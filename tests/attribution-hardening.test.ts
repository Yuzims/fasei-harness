/**
 * Phase 18-B: resolution attribution hardening.
 *
 * Covers the four load-bearing invariants:
 * 1. merged never mints a certified "fixes" relation (prescan stamping is
 *    structured-corroboration only).
 * 2. hypothesis_fixes nominates but never certifies any verifier condition.
 * 3. The temporal guard is a pure field comparison that mechanically refutes
 *    landed candidates predating the issue.
 * 4. unlinkedFixScan hints are hypothesis-only: no verifier check or evidence
 *    gap item may read them.
 * Fully offline: react#37610 fixture replay, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import {
  corroboratedFixPullNumbers,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
  evaluateEvidenceRequirement,
  evaluateResolutionAdmission,
  issueFact,
  pullFact,
  refutedByTemporalOrder,
  requirementEvalContext,
  type EvidenceRequirement,
  type IssueFact,
  type PullFact,
  type ResolutionPrescanRecord,
} from "../src/domain/index.js";
import {
  SnapshotGitHubProvider,
  githubFixturePath,
  loadSnapshot,
  type ClosingReferenceFacts,
  type GitHubDataProvider,
  type ResolutionReferenceSource,
  type UnlinkedFixCommitSource,
} from "../src/github/index.js";
import {
  computeEvidenceGap,
  ingestObservation,
  runResolutionPrescan,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { InvestigationState } from "../src/investigation/state.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const FIXED_NOW = "2026-09-22T00:00:00.000Z";
const verifier = new IndependentCompletionVerifier();

function provenance(resource: string, url: string) {
  return {
    source: "github" as const,
    repository: "acme/box",
    resource,
    url,
    retrievedAt: FIXED_NOW,
    trust: "external_untrusted" as const,
  };
}

function taskFor(issueNumber = 42) {
  return createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber },
  });
}

function issueEvidence(input?: { number?: number; createdAt?: string; state?: "open" | "closed" }) {
  const number = input?.number ?? 42;
  const state = input?.state ?? "closed";
  return createEvidence({
    kind: "issue",
    summary: `Issue #${number} is ${state}`,
    payload: {
      number,
      repository: "acme/box",
      state,
      title: "Null pointer when saving empty cart",
      body: "Saving an empty cart throws.",
      ...(input?.createdAt ? { createdAt: input.createdAt } : {}),
    },
    provenance: provenance(`issues/${number}`, `https://github.com/acme/box/issues/${number}`),
  });
}

function prEvidence(input: {
  number?: number;
  merged?: boolean;
  mergedAt?: string;
  createdAt?: string;
}) {
  const number = input?.number ?? 7;
  const merged = input?.merged ?? true;
  return createEvidence({
    kind: "pull_request",
    summary: `PR #${number} merged=${merged}`,
    payload: {
      number,
      repository: "acme/box",
      merged,
      state: merged ? "closed" : "open",
      title: "Fix empty cart save",
      body: "Fixes #42",
      ...(input?.mergedAt ? { mergedAt: input.mergedAt } : {}),
      ...(input?.createdAt ? { createdAt: input.createdAt } : {}),
    },
    provenance: provenance(`pull/${number}`, `https://github.com/acme/box/pull/${number}`),
  });
}

function graphOf(
  evidence: ReturnType<typeof createEvidence>[],
  relations: ReturnType<typeof createRelation>[],
) {
  return { evidence, relations, claims: [], claimEvidence: [] };
}

const mergedReq: EvidenceRequirement = {
  id: "pr-merged",
  kind: "pull_request",
  severity: "required",
  description: "resolution landed",
  condition: "resolution_merged",
};

function prescanRecord(candidates: number[]): ResolutionPrescanRecord {
  return {
    state: "completed",
    startedAt: FIXED_NOW,
    llmCalls: 0,
    sources: [],
    candidates: candidates.map((pullNumber) => ({
      pullNumber,
      enumeratedBy: ["issue_body_mention"],
      structuredClosingReference: true,
      detailState: "completed",
    })),
    candidatesEnumerated: candidates.length,
    candidatesTruncated: false,
    commitCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// Temporal guard: pure field comparison
// ---------------------------------------------------------------------------

function pull(fields: Partial<PullFact>): PullFact {
  return { evidenceId: "ev-pr", repository: "acme/box", number: 7, ...fields };
}

function issue(fields: Partial<IssueFact>): IssueFact {
  return { evidenceId: "ev-issue", repository: "acme/box", number: 42, ...fields };
}

test("时间守卫：mergedAt 早于/等于/晚于 issue createdAt 的边界", () => {
  const created = "2026-01-01T00:00:00Z";
  const before = refutedByTemporalOrder(pull({ mergedAt: "2025-12-31T23:59:59Z" }), issue({ createdAt: created }));
  assert.ok(before, "one second earlier must refute");
  assert.equal(before.basis, "mergedAt");
  assert.match(before.reason, /PR #7 mergedAt 2025-12-31T23:59:59Z predates issue createdAt 2026-01-01T00:00:00Z/);

  assert.equal(refutedByTemporalOrder(pull({ mergedAt: created }), issue({ createdAt: created })), undefined,
    "exactly equal instants are not refuted");
  assert.equal(refutedByTemporalOrder(pull({ mergedAt: "2026-01-01T00:00:01Z" }), issue({ createdAt: created })), undefined,
    "one second later must not refute");
});

test("时间守卫：mergedAt 缺失时回退 PR createdAt，两者都缺失则守卫失效", () => {
  const created = "2026-01-01T00:00:00Z";
  const fallback = refutedByTemporalOrder(pull({ createdAt: "2025-12-01T00:00:00Z" }), issue({ createdAt: created }));
  assert.ok(fallback, "missing mergedAt must fall back to prCreatedAt");
  assert.equal(fallback.basis, "createdAt");
  assert.match(fallback.reason, /PR #7 createdAt 2025-12-01T00:00:00Z predates/);

  assert.equal(refutedByTemporalOrder(pull({}), issue({ createdAt: created })), undefined);
  assert.equal(refutedByTemporalOrder(pull({ mergedAt: "garbage" }), issue({ createdAt: created })), undefined,
    "unparseable dates keep the guard inert, never guess");
  assert.equal(refutedByTemporalOrder(pull({ mergedAt: "2020-01-01T00:00:00Z" }), issue({})), undefined,
    "issue without createdAt keeps the guard inert");
});

test("corroboratedFixPullNumbers：只认 structuredClosingReference === true", () => {
  const record = prescanRecord([11]);
  record.candidates.push(
    { pullNumber: 12, enumeratedBy: [], structuredClosingReference: false, detailState: "completed" },
    { pullNumber: 13, enumeratedBy: [], structuredClosingReference: undefined, detailState: "failed" },
    { pullNumber: 14, enumeratedBy: [], detailState: "completed" },
  );
  assert.deepEqual([...corroboratedFixPullNumbers(record)].sort((a, b) => a - b), [11]);
  assert.equal(corroboratedFixPullNumbers(undefined).size, 0);
});

// ---------------------------------------------------------------------------
// pr-merged rework: corroboration + temporal guard
// ---------------------------------------------------------------------------

test("pr-merged（有 prescan）：merged 但无结构化佐证 → 不满足，解释点名", () => {
  const issue1 = issueEvidence({ createdAt: "2025-01-01T00:00:00Z" });
  const pr = prEvidence({ number: 7, merged: true, mergedAt: "2026-02-01T00:00:00Z" });
  const edge = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue1.id, type: "references" });
  const task = taskFor();
  const evaluation = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({ task, ...graphOf([issue1, pr], [edge]), prescan: prescanRecord([999]) }),
  );
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "rejected");
  assert.match(evaluation.reason, /PR #7 without structured closing corroboration cannot satisfy pr-merged/);
});

test("pr-merged（有 prescan）：结构化佐证 + merged 且时间合法 → 满足", () => {
  const issue1 = issueEvidence({ createdAt: "2025-01-01T00:00:00Z" });
  const pr = prEvidence({ number: 7, merged: true, mergedAt: "2026-02-01T00:00:00Z" });
  const edge = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue1.id, type: "fixes" });
  const evaluation = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({
      task: taskFor(),
      ...graphOf([issue1, pr], [edge]),
      prescan: prescanRecord([7]),
    }),
  );
  assert.equal(evaluation.satisfied, true);
  assert.match(evaluation.reason, /merged PR #7/);
});

test("pr-merged：时间守卫独立于 prescan —— 无 prescan 也驳回先于 issue 的 merged 候选", () => {
  const issue1 = issueEvidence({ createdAt: "2026-01-01T00:00:00Z" });
  const pr = prEvidence({ number: 7, merged: true, mergedAt: "2025-08-15T16:14:23Z" });
  const edge = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue1.id, type: "fixes" });
  const task = taskFor();
  const evaluation = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({ task, ...graphOf([issue1, pr], [edge]) }),
  );
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "rejected");
  assert.match(evaluation.reason, /PR #7 mergedAt 2025-08-15T16:14:23Z predates issue createdAt 2026-01-01T00:00:00Z/);
  assert.equal(evaluation.actual, "temporally_refuted");

  const admission = evaluateResolutionAdmission(
    graphOf([issue1, pr], [edge]),
    task,
  );
  assert.deepEqual(admission.landed, []);
  assert.equal(admission.refuted.length, 1);
});

test("无 prescan 的历史 run 保持 legacy merged 语义（时间戳缺失时守卫惰性）", () => {
  const issue1 = issueEvidence();
  const pr = prEvidence({ merged: true });
  const edge = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue1.id, type: "references" });
  const evaluation = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({ task: taskFor(), ...graphOf([issue1, pr], [edge]) }),
  );
  assert.equal(evaluation.satisfied, true, "benchmark/offline runs keep historical behavior");
});

// ---------------------------------------------------------------------------
// hypothesis_fixes never certifies
// ---------------------------------------------------------------------------

test("hypothesis_fixes 提名候选但不翻转 pr-merged / claims-supported", () => {
  const issue1 = issueEvidence({ createdAt: "2025-01-01T00:00:00Z" });
  const pr = prEvidence({ number: 7, merged: true, mergedAt: "2026-02-01T00:00:00Z" });
  const hypothesis = createRelation({
    fromEvidenceId: pr.id,
    toEvidenceId: issue1.id,
    type: "hypothesis_fixes",
  });
  const task = taskFor();
  const prescan = prescanRecord([999]);

  const without = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({ task, ...graphOf([issue1, pr], []), prescan }),
  );
  const withHypothesis = evaluateEvidenceRequirement(
    mergedReq,
    requirementEvalContext({ task, ...graphOf([issue1, pr], [hypothesis]), prescan }),
  );
  assert.equal(without.outcome, "missing", "no graph link at all → nothing to adjudicate");
  assert.equal(withHypothesis.satisfied, false);
  assert.equal(withHypothesis.outcome, "rejected");
  assert.match(withHypothesis.reason, /without structured closing corroboration/);

  const candidateReq: EvidenceRequirement = {
    id: "resolution-candidate",
    kind: "pull_request",
    severity: "required",
    description: "candidate",
    condition: "resolution_candidate",
  };
  const nominated = evaluateEvidenceRequirement(
    candidateReq,
    requirementEvalContext({ task, ...graphOf([issue1, pr], [hypothesis]) }),
  );
  assert.equal(nominated.satisfied, true, "hypothesis edges still nominate candidates");

  const claimReq: EvidenceRequirement = {
    id: "claims-supported",
    kind: "other",
    severity: "required",
    description: "claim support",
    condition: "claim_support",
  };
  const claimContext = (relations: ReturnType<typeof createRelation>[]) =>
    evaluateEvidenceRequirement(
      claimReq,
      requirementEvalContext({ task, ...graphOf([issue1, pr], relations) }),
    );
  assert.equal(claimContext([]).outcome, claimContext([hypothesis]).outcome,
    "hypothesis_fixes must not move claim_support");
});

// ---------------------------------------------------------------------------
// unlinkedFixScan stays out of every check
// ---------------------------------------------------------------------------

test("unlinkedFixHints 不进入 verifier checks 与 evidence gap", () => {
  const issue1 = issueEvidence({ createdAt: "2025-01-01T00:00:00Z" });
  const pr = prEvidence({ number: 7, merged: true, mergedAt: "2026-02-01T00:00:00Z" });
  const edge = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue1.id, type: "fixes" });
  const task = taskFor();
  const run = createInvestigationRun({ task });
  run.evidence.push(issue1, pr);
  run.relations.push(edge);
  run.resolutionPrescan = prescanRecord([7]);

  const clean = verifier.verify({ task, run });
  const before = clean.checks.map((check) => `${check.id}:${check.status}:${check.message}`);

  run.resolutionPrescan.unlinkedFixScan = {
    state: "completed",
    hints: [{ sha: "deadbeefdeadbeef", files: ["src/cart.ts"] }],
    filesExamined: 1,
    filesTruncated: false,
    windowStart: "2025-01-01T00:00:00Z",
    baseRefs: ["main"],
  };
  const withHints = verifier.verify({ task, run });
  assert.deepEqual(
    withHints.checks.map((check) => `${check.id}:${check.status}:${check.message}`),
    before,
    "hints must not influence any check, message, or verdict",
  );
  assert.equal(withHints.status, clean.status);

  const gap = computeEvidenceGap(task, run);
  assert.equal(
    gap.items.some((item) => JSON.stringify(item).includes("deadbeef")),
    false,
    "hint SHAs must not leak into evidence gap items",
  );
});

// ---------------------------------------------------------------------------
// react#37610 replay: graph + verdict assertions
// ---------------------------------------------------------------------------

interface ClosingRefsFixture {
  repositoryNameWithOwner?: string;
  facts: ClosingReferenceFacts[];
}

function closingRefsFixture(): ClosingRefsFixture {
  const url = new URL("../fixtures/github/react-37610-closing-refs.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as ClosingRefsFixture;
}

function fixtureGraphQl(): ResolutionReferenceSource {
  const fixture = closingRefsFixture();
  return {
    async getClosingReferences({ pullNumbers }) {
      return {
        repositoryNameWithOwner: fixture.repositoryNameWithOwner,
        facts: fixture.facts.filter((fact) => pullNumbers.includes(fact.pullNumber)),
      };
    },
  };
}

function makeSession(owner: string, repository: string, issueNumber: number): InvestigationSession {
  const task = createInvestigationTask({ target: { owner, repository, issueNumber } });
  return {
    state: new InvestigationState(task, createInvestigationRun({ task })),
    trace: new TraceCollector(),
    runId: `run-18b-${issueNumber}`,
    llmUsage: new LlmUsageCollector(),
  };
}

async function replayReact37610(deps?: { commitHints?: UnlinkedFixCommitSource }) {
  const session = makeSession("facebook", "react", 37610);
  const provider = new SnapshotGitHubProvider(githubFixturePath("react-37610"));
  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: fixtureGraphQl(),
    commitHints: deps?.commitHints,
    now: () => FIXED_NOW,
  });
  return { session, record, provider };
}

function evidenceForPr(run: ReturnType<typeof createInvestigationRun>, number: number) {
  return run.evidence.find(
    (item) => item.kind === "pull_request" && (item.payload as { number?: number }).number === number,
  );
}

test("react#37610 重放：prescan 后图中不存在指向 #34069 的 certified fixes 关系", async () => {
  const { session } = await replayReact37610();
  const run = session.state.run;
  const issue = run.evidence.find((item) => item.kind === "issue");
  assert.ok(issue);
  assert.equal(issueFact(issue)?.number, 37610);

  const pr37626 = evidenceForPr(run, 37626);
  const pr34069 = evidenceForPr(run, 34069);
  assert.ok(pr37626 && pr34069, "both acceptance candidates must be Evidence after prescan");

  const certified = run.relations.filter(
    (relation) => relation.type === "fixes" && relation.toEvidenceId === issue.id,
  );
  assert.deepEqual(
    certified.map((relation) => relation.fromEvidenceId),
    [pr37626.id],
    "only the GraphQL-corroborated #37626 may hold a certified fixes edge",
  );
  assert.equal(
    run.relations.some(
      (relation) =>
        (relation.type === "fixes" || relation.type === "hypothesis_fixes") &&
        relation.fromEvidenceId === pr34069.id,
    ),
    false,
    "merged-but-wrong #34069 must carry neither certified nor hypothesis fixes edges from ingestion",
  );
  assert.ok(
    run.relations.some(
      (relation) =>
        relation.type === "references" &&
        relation.fromEvidenceId === pr34069.id &&
        relation.toEvidenceId === issue.id,
    ),
    "#34069 stays a plain references candidate",
  );
});

test("react#37610 重放：#34069 被时间守卫驳回且有解释，#37626 引用未合并 → not_verified", async () => {
  const { session, record } = await replayReact37610();
  const run = session.state.run;
  const task = session.state.task;

  const issue = run.evidence.find((item) => item.kind === "issue");
  const issueCreatedAt = issueFact(issue!)?.createdAt;
  assert.ok(issueCreatedAt, "fixture issue must carry createdAt");
  const wrong = record.candidates.find((item) => item.pullNumber === 34069);
  assert.equal(wrong?.mergedAt, "2025-08-15T16:14:23Z");
  assert.ok(Date.parse(String(wrong?.mergedAt)) < Date.parse(issueCreatedAt), "replay evidence pair");

  const result = verifier.verify({ task, run });
  assert.equal(result.status, "not_verified", "open issue + refuted merged PR + unmerged real fix");

  const prMerged = result.checks.find((check) => check.id === "pr-merged");
  assert.ok(prMerged);
  assert.equal(prMerged.status, "fail");
  assert.match(
    prMerged.message,
    /PR #34069 mergedAt 2025-08-15T16:14:23Z predates issue createdAt/,
    "temporal refutation must be explained in the check",
  );
  assert.match(prMerged.message, /#37626 hold structured closing references yet never landed/);

  const gap = computeEvidenceGap(task, run);
  const mergedGap = gap.items.find((item) => item.condition === "resolution_merged");
  assert.equal(mergedGap?.outcome, "rejected");
  assert.match(mergedGap?.reason ?? "", /predates issue createdAt/);
});

test("unlinkedFixScan：诚实穷举候选文件上的分支 commits，剔除候选自身 merge commit", async () => {
  const snapshot = loadSnapshot(githubFixturePath("react-37610"));
  const mergeSha = Object.values(snapshot.pullRequests).find(
    (pr) => pr.merged && pr.mergeCommitSha,
  )?.mergeCommitSha;
  assert.ok(mergeSha, "fixture must contain a merged candidate with a merge commit");

  const calls: { ref?: string; path: string; since?: string }[] = [];
  let firstPath: string | undefined;
  const commitHints: UnlinkedFixCommitSource = {
    async listCommitsTouchingFile(query) {
      calls.push({ ref: query.ref, path: query.path, since: query.since });
      if (firstPath === undefined) {
        firstPath = query.path;
      }
      if (query.path === firstPath) {
        return { shas: ["AAAA1111", mergeSha!.toUpperCase()], truncated: false };
      }
      return { shas: [], truncated: false };
    },
  };
  const { record } = await replayReact37610({ commitHints });

  assert.equal(record.state, "completed", "the side-scan must not flip the 18-A record state");
  const scan = record.unlinkedFixScan;
  assert.ok(scan);
  assert.ok(scan.windowStart, "window start = issue createdAt");
  assert.equal(scan.filesExamined > 0, true);
  assert.equal(scan.filesTruncated, false, "react#37610 candidate files fit inside the cap");
  assert.equal(calls.length > 0, true);
  for (const call of calls) {
    assert.equal(call.since, scan.windowStart, "every query is bounded by the issue creation date");
  }
  const shas = scan.hints.map((hint) => hint.sha);
  assert.ok(shas.includes("aaaa1111"), "hint SHAs are normalized to lowercase");
  assert.equal(
    shas.includes(mergeSha.toLowerCase()),
    false,
    "a candidate's own merge commit is subtracted from the hints",
  );
  const hit = scan.hints.find((hint) => hint.sha === "aaaa1111");
  assert.deepEqual(hit?.files, [firstPath]);
  if (scan.state === "incomplete") {
    assert.equal(scan.reason, "query_budget_reached", "only honest incompleteness reasons");
  }
});

test("unlinkedFixScan：来源不可用或查询失败时诚实降级，绝不影响 record.state", async () => {
  const skipped = await replayReact37610();
  assert.equal(skipped.record.unlinkedFixScan?.state, "skipped");
  assert.equal(skipped.record.unlinkedFixScan?.reason, "no_commit_hint_source");
  assert.equal(skipped.record.state, "completed");

  const failing = await replayReact37610({
    commitHints: {
      async listCommitsTouchingFile() {
        throw new Error("boom");
      },
    },
  });
  const scan = failing.record.unlinkedFixScan;
  assert.equal(scan?.state, "incomplete");
  assert.match(scan?.reason ?? "", /hint_query_failed:/);
  assert.equal(failing.record.state, "completed", "18-A completion semantics stay frozen");
});

test("prescan 摄取不再派生 merged⇒fixes：#34069 关系类型断言", async () => {
  const { session } = await replayReact37610();
  const run = session.state.run;
  const byId = new Map(run.evidence.map((item) => [item.id, item]));
  for (const relation of run.relations) {
    const from = byId.get(relation.fromEvidenceId);
    const to = byId.get(relation.toEvidenceId);
    if (from?.kind === "pull_request" && to?.kind === "issue") {
      const number = (from.payload as { number?: number }).number;
      if (number === 34069) {
        assert.equal(relation.type, "references");
      } else if (number === 37626) {
        assert.ok(relation.type === "fixes" || relation.type === "references");
      }
    }
  }
  assert.ok(
    run.relations.some(
      (relation) => relation.type === "merges",
    ),
    "merges edges (pr-merge → PR) remain factual and unaffected",
  );
});

test("prescan 默认（无 commitHints 来源）不产生任何 hints 之外的图副作用", async () => {
  const { session, record } = await replayReact37610();
  assert.ok(session.llmUsage.getCalls().length === 0);
  assert.equal(record.llmCalls, 0);
  assert.equal(record.unlinkedFixScan?.hints.length, 0);
});

test("issue 时间戳缺失时 unlinkedFixScan 诚实 skip", async () => {
  const provider = {
    async getIssue() {
      return {
        number: 5,
        repository: "acme/box",
        title: "t",
        body: "see #7",
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
      return [];
    },
    async getPullRequest() {
      return {
        number: 7,
        repository: "acme/box",
        title: "fix",
        body: "Fixes #5",
        state: "open",
        merged: false,
        url: "",
        source: "github",
        retrievedAt: FIXED_NOW,
        trust: "external_untrusted",
      };
    },
    async getPullRequestFiles() {
      return [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 }];
    },
  } as unknown as GitHubDataProvider;
  const session = makeSession("acme", "box", 5);
  const record = await runResolutionPrescan({
    session,
    provider,
    graphQl: { async getClosingReferences() { return { facts: [] }; } },
    commitHints: {
      async listCommitsTouchingFile() {
        throw new Error("must not be called");
      },
    },
    now: () => FIXED_NOW,
  });
  assert.equal(record.unlinkedFixScan?.state, "skipped");
  assert.equal(record.unlinkedFixScan?.reason, "no_issue_created_at");
});
