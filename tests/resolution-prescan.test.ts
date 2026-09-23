/**
 * Phase 18-A: deterministic resolution-reference pre-scan.
 * Fully offline: replays the captured facebook/react#37610 REST fixture plus an
 * offline GraphQL closingIssuesReferences facts fixture. No real network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import {
  createInvestigationRun,
  createInvestigationTask,
  type ResolutionPrescanCandidate,
} from "../src/domain/index.js";
import {
  GitHubProviderError,
  SnapshotGitHubProvider,
  githubFixturePath,
  type ClosingReferenceFacts,
  type GitHubDataProvider,
  type ResolutionReferenceSource,
} from "../src/github/index.js";
import {
  HARNESS_STRUCTURED_SOURCE,
  ingestObservation,
  investigate,
  runResolutionPrescan,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const FIXED_NOW = "2026-09-22T00:00:00.000Z";

interface ClosingRefsFixture {
  repositoryNameWithOwner?: string;
  facts: ClosingReferenceFacts[];
}

function closingRefsFixture(): ClosingRefsFixture {
  const url = new URL("../fixtures/github/react-37610-closing-refs.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as ClosingRefsFixture;
}

function makeSession(owner: string, repository: string, issueNumber: number): InvestigationSession {
  const task = createInvestigationTask({ target: { owner, repository, issueNumber } });
  return {
    state: new InvestigationState(task, createInvestigationRun({ task })),
    trace: new TraceCollector(),
    runId: `run-prescan-${issueNumber}`,
    llmUsage: new LlmUsageCollector(),
  };
}

function fixtureGraphQl(options?: { failWith?: GitHubProviderError }): ResolutionReferenceSource {
  const fixture = closingRefsFixture();
  return {
    async getClosingReferences({ pullNumbers }) {
      if (options?.failWith) {
        throw options.failWith;
      }
      return {
        repositoryNameWithOwner: fixture.repositoryNameWithOwner,
        facts: fixture.facts.filter((fact) => pullNumbers.includes(fact.pullNumber)),
      };
    },
  };
}

function candidate(
  candidates: ResolutionPrescanCandidate[],
  pullNumber: number,
): ResolutionPrescanCandidate {
  const hit = candidates.find((item) => item.pullNumber === pullNumber);
  assert.ok(hit, `candidate PR #${pullNumber} must be enumerated`);
  return hit;
}

test("react#37610 重放：零 LLM 调用枚举全部候选，#37626 与 #34069 都在场", async () => {
  const session = makeSession("facebook", "react", 37610);
  const provider = new SnapshotGitHubProvider(githubFixturePath("react-37610"));

  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: fixtureGraphQl(),
    now: () => FIXED_NOW,
  });

  // Zero-LLM by construction — and the usage collector confirms it externally.
  assert.equal(record.llmCalls, 0);
  assert.equal(session.llmUsage.getCalls().length, 0, "prescan must not send any LLM call");

  // Machine-decidable completion record.
  assert.equal(record.state, "completed");
  assert.equal(session.state.run.resolutionPrescan, record);
  assert.equal(record.repositoryNameWithOwner, "react/react", "rename normalization recorded");
  assert.ok(
    record.sources.every((source) => source.state === "completed"),
    "every enumeration source completed in this replay",
  );

  // The REST timeline for react#37610 genuinely has zero cross-referenced
  // events; both acceptance candidates come from canonical `#N` references.
  assert.equal(record.candidatesEnumerated, 10);
  assert.equal(record.candidatesTruncated, false);
  assert.deepEqual(record.commitCandidates, []);

  const real = candidate(record.candidates, 37626);
  assert.equal(real.structuredClosingReference, true, "#37626 closes #37610 per GraphQL field");
  assert.equal(real.merged, false, "the real fix is still open — prescan records facts, not verdicts");
  assert.equal(real.detailState, "completed");
  assert.ok(real.enumeratedBy.includes("comment_mention"));

  const wrong = candidate(record.candidates, 34069);
  assert.equal(wrong.structuredClosingReference, false);
  assert.equal(wrong.merged, true);
  assert.equal(wrong.mergedAt, "2025-08-15T16:14:23Z", "temporal guard input must be captured");
  assert.equal(wrong.detailState, "completed");
  assert.ok(wrong.enumeratedBy.includes("issue_body_mention"));

  // Corroborated-first ordering is field-based, never text-based.
  assert.equal(record.candidates[0]?.pullNumber, 37626);

  // GitHub says #37578/#37606 are not PRs — authoritative found=false, honestly recorded.
  assert.equal(candidate(record.candidates, 37578).detailState, "not_a_pull_request");
  assert.equal(candidate(record.candidates, 37606).detailState, "not_a_pull_request");

  // Evidence: every prescan observation entered the run as harness_structured.
  const evidence = session.state.run.evidence;
  assert.ok(evidence.length > 0);
  assert.ok(
    evidence.every((item) => item.provenance.source === HARNESS_STRUCTURED_SOURCE),
    "prescan evidence must be distinguishable from agent-fetched github evidence",
  );
  const prNumbers = evidence
    .filter((item) => item.kind === "pull_request" && typeof (item.payload as { number?: unknown }).number === "number")
    .map((item) => (item.payload as { number: number }).number);
  assert.ok(prNumbers.includes(37626), "PR #37626 content must already be evidence");
  assert.ok(prNumbers.includes(34069), "PR #34069 content must already be evidence");
  assert.ok(
    evidence.some((item) => item.kind === "issue"),
    "target issue ingested as evidence",
  );

  // The agent must not burn budget rediscovering what prescan ingested.
  assert.ok(session.state.investigatedResources.has(resourceKey("issue", "37610")));
  assert.ok(session.state.investigatedResources.has(resourceKey("pull", "37626")));

  const traceTypes = session.trace.getEvents().map((event) => event.type);
  assert.ok(traceTypes.includes("evidence_added"));
  assert.ok(traceTypes.includes("resolution_prescan_completed"));
  assert.ok(!traceTypes.includes("resolution_prescan_incomplete"));
});

test("GraphQL 失败：如实降级为 incomplete，REST 枚举与摄取照常存活", async () => {
  const session = makeSession("facebook", "react", 37610);
  const provider = new SnapshotGitHubProvider(githubFixturePath("react-37610"));
  const failure = new GitHubProviderError({
    code: "unauthorized",
    operation: "getClosingReferences",
    message: "Resource not accessible by personal access token",
    retryable: false,
  });

  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: fixtureGraphQl({ failWith: failure }),
    now: () => FIXED_NOW,
  });

  assert.equal(record.state, "incomplete", "coverage loss must be machine-visible (18-C input)");
  assert.equal(record.llmCalls, 0);
  const graphqlSource = record.sources.find((s) => s.source === "graphql_closing_references");
  assert.equal(graphqlSource?.state, "failed");
  assert.equal(graphqlSource?.errorCode, "unauthorized");

  // REST enumeration survives the GraphQL failure unchanged.
  assert.equal(record.candidatesEnumerated, 10);
  assert.ok(record.candidates.some((c) => c.pullNumber === 37626));
  assert.ok(record.candidates.some((c) => c.pullNumber === 34069));
  // Without GraphQL, found=false is unknown, so detail fetch was attempted and
  // the non-PR numbers honestly failed the REST fetch.
  assert.equal(candidate(record.candidates, 37626).structuredClosingReference, undefined);
  const detailSource = record.sources.find((s) => s.source === "pr_detail_fetch");
  assert.equal(detailSource?.state, "failed");
  assert.equal(detailSource?.errorCode, "partial_failure");
  assert.equal(
    session.state.run.evidence.every((item) => item.provenance.source === HARNESS_STRUCTURED_SOURCE),
    true,
  );
  assert.ok(
    session.trace.getEvents().some((event) => event.type === "resolution_prescan_incomplete"),
  );
});

test("未提供 GraphQL 来源：记为 skipped 且 incomplete，绝不静默", async () => {
  const session = makeSession("facebook", "react", 37610);
  const record = await runResolutionPrescan({
    session,
    provider: new SnapshotGitHubProvider(githubFixturePath("react-37610")),
    now: () => FIXED_NOW,
  });
  const graphqlSource = record.sources.find((s) => s.source === "graphql_closing_references");
  assert.equal(graphqlSource?.state, "skipped");
  assert.equal(record.state, "incomplete");
});

test("空 timeline 且无任何引用：候选集为空，扫描仍诚实完成", async () => {
  const provider = {
    async getIssue() {
      return {
        number: 5,
        repository: "acme/box",
        title: "Crash on mount",
        body: "No references at all.",
        state: "open",
        url: "https://github.com/acme/box/issues/5",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
    async getIssueComments() {
      return [];
    },
    async getIssueTimeline() {
      return [];
    },
    async getPullRequest(): Promise<never> {
      throw new Error("must not be called when no candidates exist");
    },
  } as unknown as GitHubDataProvider;

  const session = makeSession("acme", "box", 5);
  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: { async getClosingReferences() { return { facts: [] }; } },
    now: () => FIXED_NOW,
  });

  assert.equal(record.state, "completed");
  assert.deepEqual(record.candidates, []);
  assert.equal(record.candidatesEnumerated, 0);
  assert.deepEqual(record.commitCandidates, []);
});

test("timeline 结构化 cross-reference 与 commit SHA 直接进入候选与记录", async () => {
  const issue = {
    number: 9,
    repository: "acme/box",
    title: "Bug",
    body: "nothing here",
    state: "closed",
    url: "https://github.com/acme/box/issues/9",
    source: "github",
    retrievedAt: FIXED_NOW,
    trust: "external_untrusted",
  };
  const provider = {
    async getIssue() {
      return issue;
    },
    async getIssueComments() {
      return [];
    },
    async getIssueTimeline() {
      return [
        {
          id: "timeline:1",
          repository: "acme/box",
          event: "cross-referenced",
          actor: "dev",
          body: "",
          pullRequestNumber: 55,
          source: "github",
          url: "",
          retrievedAt: FIXED_NOW,
          trust: "external_untrusted",
        },
        {
          id: "timeline:2",
          repository: "acme/box",
          event: "committed",
          actor: "dev",
          body: "Fix it",
          commitId: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
          source: "github",
          url: "",
          retrievedAt: FIXED_NOW,
          trust: "external_untrusted",
        },
      ];
    },
    async getPullRequest() {
      return {
        number: 55,
        repository: "acme/box",
        title: "Fix bug",
        body: "Fixes #9",
        state: "closed",
        merged: true,
        mergeCommitSha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
        url: "https://github.com/acme/box/pull/55",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
  } as unknown as GitHubDataProvider;

  const session = makeSession("acme", "box", 9);
  const graphQl: ResolutionReferenceSource = {
    async getClosingReferences() {
      return {
        facts: [
          {
            pullNumber: 55,
            found: true,
            state: "MERGED",
            merged: true,
            mergedAt: FIXED_NOW,
            createdAt: FIXED_NOW,
            baseRefName: "main",
            url: "https://github.com/acme/box/pull/55",
            closingIssueNumbers: [9],
          },
        ],
      };
    },
  };

  const record = await runResolutionPrescan({ session, provider, graphQl, now: () => FIXED_NOW });
  const c55 = candidate(record.candidates, 55);
  assert.ok(c55.enumeratedBy.includes("timeline_cross_reference"));
  assert.equal(c55.structuredClosingReference, true);
  assert.equal(c55.merged, true);
  assert.deepEqual(record.commitCandidates, ["abcdef1234567890abcdef1234567890abcdef12"]);
  assert.equal(record.state, "completed");
});

test("prescan 候选上限：超出部分截断并诚实标记，不静默丢弃", async () => {
  const body = Array.from({ length: 15 }, (_, i) => `see #${100 + i}`).join(" ");
  const provider = {
    async getIssue() {
      return { number: 7, repository: "acme/box", title: "t", body, state: "open", url: "", source: "github", retrievedAt: FIXED_NOW, trust: "external_untrusted" };
    },
    async getIssueComments() {
      return [];
    },
    async getIssueTimeline() {
      return [];
    },
    async getPullRequest({ pullNumber }: { pullNumber: number }) {
      return {
        number: pullNumber,
        repository: "acme/box",
        title: `PR ${pullNumber}`,
        body: "",
        state: "open",
        merged: false,
        url: "",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
  } as unknown as GitHubDataProvider;

  const session = makeSession("acme", "box", 7);
  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: { async getClosingReferences() { return { facts: [] }; } },
    maxCandidates: 12,
    now: () => FIXED_NOW,
  });
  assert.equal(record.candidatesEnumerated, 15);
  assert.equal(record.candidatesTruncated, true);
  assert.equal(record.candidates.length, 12);
});

test("默认工具路径 provenance 不变：仍是 github，只有 prescan 用 harness_structured", async () => {
  const session = makeSession("acme", "box", 5);
  ingestObservation(session, "github_get_issue", { issueNumber: 5 }, {
    number: 5,
    repository: "acme/box",
    title: "Plain",
    body: "body",
    state: "open",
    url: "https://github.com/acme/box/issues/5",
    source: "github",
    retrievedAt: FIXED_NOW,
    trust: "external_untrusted",
  });
  const evidence = session.state.run.evidence;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.provenance.source, "github", "tool-path ingestion defaults unchanged");
});

test("investigate() 接线：prescan 先于任何模型调用完成，记录与证据进入 run", async () => {
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "facebook", repository: "react", issueNumber: 37610 },
    provider: new SnapshotGitHubProvider(githubFixturePath("react-37610")),
    model: {
      async decide() {
        return { type: "final" as const, message: "Prescan already gave me the candidate set." };
      },
    },
    resolutionPrescan: { enabled: true, graphQl: fixtureGraphQl() },
    maxAttempts: 1,
    trace,
  });

  assert.ok(result.run.resolutionPrescan, "run must carry the machine record");
  assert.equal(result.run.resolutionPrescan?.state, "completed");
  const candidates = result.run.resolutionPrescan?.candidates ?? [];
  assert.ok(candidates.some((c) => c.pullNumber === 37626));
  assert.ok(candidates.some((c) => c.pullNumber === 34069));
  assert.ok(
    result.run.evidence.every((item) => item.provenance.source === HARNESS_STRUCTURED_SOURCE),
  );

  const types = trace.getEvents().map((event) => event.type);
  const prescanAt = types.indexOf("resolution_prescan_completed");
  const modelAt = types.findIndex((type) => type === "model_call" || type === "model_call_completed");
  assert.ok(prescanAt >= 0, "prescan completion must be observable in the trace");
  assert.ok(modelAt >= 0, "agent loop still runs after prescan");
  assert.ok(prescanAt < modelAt, "prescan precedes the first LLM call");
});

// ---- Phase 19-B enumeration fix: issue-side GraphQL channels ----

function issue37652Provider(): GitHubDataProvider {
  // react#37652 形态：正文只提 #37651；无评论；时间线只有 labeled；
  // #37653 在 Issue 侧零信号，只存在于 closedByPullRequestsReferences。
  return {
    async getIssue() {
      return {
        number: 37652,
        repository: "react/react",
        title: "Bug: view-transition-class is replaced",
        body: "I've already opened a pull request #37651 that will close this issue.",
        state: "open",
        url: "https://github.com/react/react/issues/37652",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
    async getIssueComments() {
      return [];
    },
    async getIssueTimeline() {
      return [
        {
          id: "timeline:1",
          repository: "react/react",
          event: "labeled",
          actor: "bot",
          body: "",
          source: "github",
          url: "",
          retrievedAt: FIXED_NOW,
          trust: "external_untrusted",
        },
      ];
    },
    async getPullRequest({ pullNumber }: { pullNumber: number }) {
      return {
        number: pullNumber,
        repository: "react/react",
        title: `PR ${pullNumber}`,
        body: "",
        state: "open",
        merged: false,
        url: `https://github.com/react/react/pull/${pullNumber}`,
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
  } as unknown as GitHubDataProvider;
}

function closingFact(pullNumber: number, closing: boolean): ClosingReferenceFacts {
  return {
    pullNumber,
    found: true,
    state: "OPEN",
    merged: false,
    mergedAt: null,
    createdAt: FIXED_NOW,
    baseRefName: "main",
    url: `https://github.com/react/react/pull/${pullNumber}`,
    closingIssueNumbers: closing ? [37652] : [],
  };
}

test("19-C closed_by 渠道：Issue 侧零提及的官方链接 PR 也被枚举并富化", async () => {
  const session = makeSession("react", "react", 37652);
  const record = await runResolutionPrescan({
    session,
    provider: issue37652Provider(),
    graphQl: {
      async getClosingReferences({ pullNumbers }) {
        return {
          facts: [37651, 37653]
            .filter((n) => pullNumbers.includes(n))
            .map((n) => closingFact(n, true)),
        };
      },
      async getIssueLinkedPulls() {
        return { closedBy: [37651, 37653], connected: [], truncated: false };
      },
    },
    now: () => FIXED_NOW,
  });

  assert.equal(record.candidatesEnumerated, 2);
  const first = candidate(record.candidates, 37651);
  assert.ok(first.enumeratedBy.includes("issue_body_mention"));
  assert.ok(first.enumeratedBy.includes("graphql_closed_by"), "双渠道在场");
  const second = candidate(record.candidates, 37653);
  assert.deepEqual(second.enumeratedBy, ["graphql_closed_by"]);
  assert.equal(second.structuredClosingReference, true, "新候选同样经过 closing-reference 富化");
  assert.equal(second.detailState, "completed", "新候选进入详情摄取");
  assert.equal(record.state, "completed");
  const linked = record.sources.find((s) => s.source === "graphql_issue_linked");
  assert.equal(linked?.state, "completed");
});

test("19-C commit 反查渠道：timeline commit 的关联 PR 进入候选", async () => {
  const session = makeSession("acme", "box", 9);
  const provider = {
    async getIssue() {
      return {
        number: 9,
        repository: "acme/box",
        title: "Bug",
        body: "no references",
        state: "open",
        url: "",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
    async getIssueComments() {
      return [];
    },
    async getIssueTimeline() {
      return [
        {
          id: "timeline:1",
          repository: "acme/box",
          event: "committed",
          actor: "dev",
          body: "",
          commitId: "abc123abc123abc123abc123abc123abc123abcd",
          source: "github",
          url: "",
          retrievedAt: FIXED_NOW,
          trust: "external_untrusted",
        },
      ];
    },
    async getPullRequest({ pullNumber }: { pullNumber: number }) {
      return {
        number: pullNumber,
        repository: "acme/box",
        title: `PR ${pullNumber}`,
        body: "",
        state: "closed",
        merged: true,
        url: "",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
  } as unknown as GitHubDataProvider;

  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: {
      async getClosingReferences() {
        return { facts: [closingFact(77, false)] };
      },
      async getPullsForCommits({ oids }) {
        assert.deepEqual(oids, ["abc123abc123abc123abc123abc123abc123abcd"]);
        return [{ oid: oids[0]!, pullNumbers: [77] }];
      },
    },
    now: () => FIXED_NOW,
  });

  const c77 = candidate(record.candidates, 77);
  assert.deepEqual(c77.enumeratedBy, ["commit_associated_pr"]);
  assert.equal(record.state, "completed");
  assert.ok(record.sources.some((s) => s.source === "graphql_commit_associated_prs" && s.state === "completed"));
});

test("19-C 能力缺失：旧 GraphQL 实现不新增来源条目，18-A 记录逐字不变", async () => {
  const session = makeSession("facebook", "react", 37610);
  const record = await runResolutionPrescan({
    session,
    provider: new SnapshotGitHubProvider(githubFixturePath("react-37610")),
    graphQl: fixtureGraphQl(),
    now: () => FIXED_NOW,
  });
  assert.equal(
    record.sources.some((s) => s.source === "graphql_issue_linked" || s.source === "graphql_commit_associated_prs"),
    false,
    "无能力的实现不得改变记录形状",
  );
  assert.equal(record.candidatesEnumerated, 10);
  assert.equal(record.state, "completed");
});

test("19-C closed_by 失败：诚实降级 incomplete，REST 枚举不受影响", async () => {
  const session = makeSession("react", "react", 37652);
  const record = await runResolutionPrescan({
    session,
    provider: issue37652Provider(),
    graphQl: {
      async getClosingReferences() {
        return { facts: [] };
      },
      async getIssueLinkedPulls() {
        throw new GitHubProviderError({
          code: "unauthorized",
          operation: "getIssueLinkedPulls",
          message: "Resource not accessible",
          retryable: false,
        });
      },
    },
    now: () => FIXED_NOW,
  });
  assert.equal(record.state, "incomplete");
  const linked = record.sources.find((s) => s.source === "graphql_issue_linked");
  assert.equal(linked?.state, "failed");
  assert.equal(linked?.errorCode, "unauthorized");
  assert.equal(record.candidatesEnumerated, 1, "#37651 仍来自正文提及");
});
