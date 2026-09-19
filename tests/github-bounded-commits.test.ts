/**
 * Bounded repository-wide commit discovery.
 * PR-specific commit retrieval must remain unbounded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import {
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";
import {
  LiveGitHubProvider,
  MAX_REPOSITORY_COMMIT_DISCOVERY,
  REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE,
  SnapshotGitHubProvider,
  UNTRUSTED,
  githubFixturePath,
  loadSnapshot,
} from "../src/github/index.js";
import { GithubHttpClient } from "../src/github/http.js";
import type { CommitSnapshot, InvestigationSnapshot } from "../src/github/types.js";
import {
  compactInvestigationToolOutput,
  computeEvidenceGap,
  hasTerminalNegativeEvidence,
  ingestObservation,
  planInvestigationStrategy,
  proposeCandidateActions,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { executeDatasetCase, loadDataset, realDatasetManifestPath } from "../src/benchmark/index.js";
import { createGithubListCommitsTool } from "../src/tools/github.js";

const RETRIEVED_AT = "2026-09-19T00:00:00.000Z";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function shaFor(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, "0")}${"a".repeat(34)}`.slice(0, 40);
}

function commitPayload(sha: string, message = `commit ${sha.slice(0, 8)}`) {
  return {
    sha,
    html_url: `https://github.com/acme/box/commit/${sha}`,
    commit: { message, author: { name: "dev" } },
    author: { login: "dev" },
  };
}

function snapshotCommit(index: number): CommitSnapshot {
  const sha = shaFor("c", index);
  return {
    id: `commit:acme/box@${sha}`,
    repository: "acme/box",
    sha,
    message: `Repo commit ${index}`,
    author: "dev",
    source: "github",
    url: `https://github.com/acme/box/commit/${sha}`,
    retrievedAt: RETRIEVED_AT,
    trust: UNTRUSTED,
  };
}

function snapshotWithRepoCommits(count: number): InvestigationSnapshot {
  const base = loadSnapshot(githubFixturePath("insufficient-evidence"));
  const repo = Array.from({ length: count }, (_, index) => snapshotCommit(index));
  return {
    ...base,
    commits: { ...base.commits, repo },
    commitIndex: { ...base.commitIndex, ...Object.fromEntries(repo.map((item) => [item.sha, item])) },
  };
}

function pagedArrayResponse(url: string, total: number, item: (index: number) => unknown): Response {
  const parsed = new URL(url);
  const page = Number(parsed.searchParams.get("page") ?? "1");
  const perPage = Number(parsed.searchParams.get("per_page") ?? "30");
  const start = (page - 1) * perPage;
  const items = Array.from({ length: Math.min(perPage, Math.max(0, total - start)) }, (_, offset) =>
    item(start + offset),
  );
  const headers: Record<string, string> = {};
  if (start + items.length < total) {
    const next = new URL(parsed.href);
    next.searchParams.set("page", String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return jsonResponse(items, 200, headers);
}

function makeSession(issueNumber = 7): InvestigationSession {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber },
  });
  return {
    state: new InvestigationState(task, createInvestigationRun({ task })),
    trace: new TraceCollector(),
    runId: "run-bounded-commits",
    llmUsage: new LlmUsageCollector(),
  };
}

function addOpenIssue(state: InvestigationState): void {
  const number = state.task.target.issueNumber;
  state.addEvidence(
    createEvidence({
      kind: "issue",
      summary: `Issue #${number} is open`,
      payload: {
        number,
        repository: "acme/box",
        state: "open",
        title: "Open bug",
        body: "Still happens.",
      },
      provenance: {
        source: "github",
        repository: "acme/box",
        resource: `issues/${number}`,
        url: `https://github.com/acme/box/issues/${number}`,
        retrievedAt: RETRIEVED_AT,
        trust: "external_untrusted",
      },
      contentRef: resourceKey("issue", String(number)),
    }),
  );
  state.investigatedResources.add(resourceKey("issue", String(number)));
  state.issueState = "open";
}

function addClosedIssue(state: InvestigationState): void {
  const number = state.task.target.issueNumber;
  state.addEvidence(
    createEvidence({
      kind: "issue",
      summary: `Issue #${number} is closed`,
      payload: {
        number,
        repository: "acme/box",
        state: "closed",
        title: "Closed bug",
        body: "Please fix.",
      },
      provenance: {
        source: "github",
        repository: "acme/box",
        resource: `issues/${number}`,
        url: `https://github.com/acme/box/issues/${number}`,
        retrievedAt: RETRIEVED_AT,
        trust: "external_untrusted",
      },
      contentRef: resourceKey("issue", String(number)),
    }),
  );
  state.investigatedResources.add(resourceKey("issue", String(number)));
  state.issueState = "closed";
}

test("repository-wide discovery returns only the configured window", async () => {
  const provider = new SnapshotGitHubProvider(snapshotWithRepoCommits(MAX_REPOSITORY_COMMIT_DISCOVERY + 40));
  const commits = await provider.listCommits({ owner: "acme", repo: "box" });
  assert.equal(commits.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(commits.truncated, true);
});

test("network pagination stops at the discovery budget instead of fetching every page", async () => {
  const requested: string[] = [];
  const provider = new LiveGitHubProvider({
    maxRetries: 0,
    now: () => RETRIEVED_AT,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      const path = new URL(url).pathname;
      assert.equal(path, "/repos/acme/box/commits");
      return pagedArrayResponse(url, 80, (index) => commitPayload(shaFor("r", index)));
    },
  });
  const commits = await provider.listCommits({ owner: "acme", repo: "box" });
  assert.equal(commits.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(commits.truncated, true);
  assert.equal(requested.length, 1, "must not retrieve later pages after the budget is filled");
  assert.equal(new URL(requested[0] ?? "").searchParams.get("page"), null);
});

test("HTTP getJsonPagesBounded does not follow the next link after maxItems", async () => {
  const requested: string[] = [];
  const client = new GithubHttpClient({
    maxRetries: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      return pagedArrayResponse(url, 90, (index) => ({ id: index }));
    },
  });
  const { items, truncated } = await client.getJsonPagesBounded(
    "listCommits",
    "/repos/acme/box/commits?per_page=30",
    MAX_REPOSITORY_COMMIT_DISCOVERY,
  );
  assert.equal(items.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(truncated, true);
  assert.equal(requested.length, 1);
  assert.equal(
    requested.some((url) => new URL(url).searchParams.get("page") === "2"),
    false,
  );
});

test("truncation is observable for both over-budget and in-window repositories", async () => {
  const over = new SnapshotGitHubProvider(snapshotWithRepoCommits(MAX_REPOSITORY_COMMIT_DISCOVERY + 1));
  const overList = await over.listCommits({ owner: "acme", repo: "box" });
  assert.equal(overList.truncated, true);
  assert.equal(overList.length, MAX_REPOSITORY_COMMIT_DISCOVERY);

  const exact = new SnapshotGitHubProvider(snapshotWithRepoCommits(MAX_REPOSITORY_COMMIT_DISCOVERY));
  const exactList = await exact.listCommits({ owner: "acme", repo: "box" });
  assert.equal(exactList.truncated, false);
  assert.equal(exactList.length, MAX_REPOSITORY_COMMIT_DISCOVERY);

  const under = new SnapshotGitHubProvider(snapshotWithRepoCommits(4));
  const underList = await under.listCommits({ owner: "acme", repo: "box" });
  assert.equal(underList.truncated, false);
  assert.equal(underList.length, 4);

  let liveCalls = 0;
  const liveFit = new LiveGitHubProvider({
    maxRetries: 0,
    now: () => RETRIEVED_AT,
    fetchImpl: async (input) => {
      liveCalls += 1;
      return pagedArrayResponse(String(input), 8, (index) => commitPayload(shaFor("s", index)));
    },
  });
  const liveList = await liveFit.listCommits({ owner: "acme", repo: "box" });
  assert.equal(liveList.truncated, false);
  assert.equal(liveList.length, 8);
  assert.equal(liveCalls, 1);
});

test("repository-wide discovery does not create hundreds of commit Evidence records", () => {
  const session = makeSession();
  const output = {
    commits: Array.from({ length: 80 }, (_, index) => snapshotCommit(index)),
    truncated: true,
  };
  const ids = ingestObservation(session, "github_list_commits", { owner: "acme", repo: "box" }, output);
  const commitEvidence = session.state.run.evidence.filter((item) => item.kind === "commit");
  assert.ok(ids.length <= MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.ok(commitEvidence.length <= MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(commitEvidence.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
});

test("compact Agent context for repository-wide discovery stays inside the window", () => {
  const commits = Array.from({ length: 75 }, (_, index) => snapshotCommit(index));
  const compact = compactInvestigationToolOutput({
    tool: "github_list_commits",
    args: { owner: "acme", repo: "box" },
    output: { commits, truncated: true },
    evidenceIds: commits.slice(0, MAX_REPOSITORY_COMMIT_DISCOVERY).map((item) => item.id),
  });
  const result = compact.result as {
    count: number;
    truncated?: boolean;
    discoveryBound?: number;
    notice?: string;
    commits: Array<{ sha: string; message: string }>;
  };
  assert.equal(result.count, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(result.commits.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(result.truncated, true);
  assert.equal(result.discoveryBound, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(result.notice, REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE);
  assert.ok(JSON.stringify(result).includes(result.commits[0]?.sha ?? "missing"));

  const fitted = compactInvestigationToolOutput({
    tool: "github_list_commits",
    args: { owner: "acme", repo: "box" },
    output: { commits: commits.slice(0, 6), truncated: false },
    evidenceIds: ["ev-a"],
  });
  const fittedResult = fitted.result as { count: number; truncated?: boolean; notice?: string };
  assert.equal(fittedResult.count, 6);
  assert.equal(fittedResult.truncated, false);
  assert.equal("notice" in fittedResult, false);
});

test("PR-specific commit retrieval stays unbounded and untruncated", async () => {
  const requested: string[] = [];
  const provider = new LiveGitHubProvider({
    maxRetries: 0,
    now: () => RETRIEVED_AT,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      const path = new URL(url).pathname;
      assert.equal(path, "/repos/acme/box/pulls/7/commits");
      return pagedArrayResponse(url, 150, (index) => commitPayload(shaFor("p", index)));
    },
  });
  const commits = await provider.listCommits({ owner: "acme", repo: "box", pullNumber: 7 });
  assert.equal(commits.length, 150);
  assert.equal(commits.truncated, undefined);
  assert.equal(requested.length, 2);

  const compact = compactInvestigationToolOutput({
    tool: "github_list_commits",
    args: { owner: "acme", repo: "box", pullNumber: 7 },
    output: commits,
    evidenceIds: commits.map((item) => item.id),
  });
  const result = compact.result as {
    count: number;
    truncated?: boolean;
    commits: unknown[];
  };
  assert.equal(result.count, 150);
  assert.equal(result.commits.length, 150);
  assert.equal("truncated" in result, false);

  const session = makeSession(42);
  const ids = ingestObservation(
    session,
    "github_list_commits",
    { owner: "acme", repo: "box", pullNumber: 7 },
    commits,
  );
  assert.equal(ids.length, 150);
  assert.equal(session.state.run.evidence.filter((item) => item.kind === "commit").length, 150);
});

test("unbounded getJsonPages still follows later pages for non-discovery lists", async () => {
  const requested: string[] = [];
  const client = new GithubHttpClient({
    maxRetries: 0,
    fetchImpl: async (input) => {
      requested.push(String(input));
      return pagedArrayResponse(String(input), 45, (index) => ({ id: index, body: `comment ${index}` }));
    },
  });
  const items = await client.getJsonPages("getIssueComments", "/repos/acme/box/issues/7/comments?per_page=30");
  assert.equal(items.length, 45);
  assert.equal(requested.length, 2);
});

test("github_list_commits tool wraps repository-wide truncation and leaves PR arrays unchanged", async () => {
  const provider = new SnapshotGitHubProvider(snapshotWithRepoCommits(MAX_REPOSITORY_COMMIT_DISCOVERY + 5));
  const tool = createGithubListCommitsTool({ provider });
  const repoWide = await tool.execute({ owner: "acme", repo: "box" });
  assert.equal(Array.isArray(repoWide), false);
  const wrapped = repoWide as { commits: unknown[]; truncated: boolean };
  assert.equal(wrapped.commits.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(wrapped.truncated, true);

  const resolved = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const prTool = createGithubListCommitsTool({ provider: resolved });
  const prCommits = await prTool.execute({ owner: "acme", repo: "box", pullNumber: 7 });
  assert.equal(Array.isArray(prCommits), true);
  assert.equal((prCommits as unknown[]).length, 1);
});

test("C08 direct-commit resolution remains observable", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C08");
  assert.equal(executed.observed.verificationStatus, "verified_complete");
  assert.equal(
    executed.report.investigationSteps.some(
      (step) => step.tool === "github_list_commits" && step.success === true,
    ),
    true,
  );
  assert.ok(
    executed.report.evidence.some(
      (item) => item.kind === "commit" && /e70118a/i.test(JSON.stringify(item.payload ?? item.summary)),
    ),
  );
});

test("OPEN issue does not terminate investigation merely because issue_closed is rejected", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const state = new InvestigationState(task, createInvestigationRun({ task }));
  addOpenIssue(state);
  const gap = computeEvidenceGap(state.task, state.run);
  assert.equal(
    gap.rejectedRequirements.some((item) => item.condition === "issue_closed"),
    true,
  );
  assert.equal(hasTerminalNegativeEvidence(gap), false);
  const legal = proposeCandidateActions(state, { gap });
  assert.equal(
    legal.some(
      (item) =>
        item.tool === "github_get_issue_timeline" ||
        item.tool === "github_get_issue_comments" ||
        item.tool === "github_list_commits",
    ),
    true,
  );
  const planned = planInvestigationStrategy(state, { gap });
  assert.equal(planned.closure, "GAP_OPEN_ACTIONABLE");
  assert.notEqual(planned.closure, "GAP_CLOSED");
});

test("candidate generation exposes only one repository-wide commit discovery action", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const state = new InvestigationState(task, createInvestigationRun({ task }));
  addClosedIssue(state);
  const legal = proposeCandidateActions(state);
  const repoWide = legal.filter(
    (item) => item.tool === "github_list_commits" && item.arguments.pullNumber === undefined,
  );
  assert.equal(repoWide.length, 1);
  assert.deepEqual(repoWide[0]?.arguments, { owner: "acme", repo: "box" });
});
