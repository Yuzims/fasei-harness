/**
 * Evidence-driven retrieval foundation.
 * Candidate relevance ≠ Evidence sufficiency ≠ Verification truth.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import {
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";
import { MAX_REPOSITORY_COMMIT_DISCOVERY } from "../src/github/index.js";
import {
  MAX_INVESTIGATED_CANDIDATES,
  NO_CANDIDATE_FOUND,
  RETRIEVAL_TOP_K,
  computeEvidenceGap,
  createRetrievalCandidate,
  discoverCommitCandidates,
  discoverPullCandidates,
  hasTerminalNegativeEvidence,
  ingestObservation,
  planInvestigationStrategy,
  proposeCandidateActions,
  applyCandidateSelection,
  investigationCandidatesOf,
  promotedCandidatesOf,
  rankCandidates,
  retrievalTopKOf,
  selectTopCandidates,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { executeDatasetCase, loadDataset, realDatasetManifestPath } from "../src/benchmark/index.js";

const RETRIEVED_AT = "2026-09-19T00:00:00.000Z";

function makeSession(issueNumber = 37269, title = "terminal resize suggestions"): InvestigationSession {
  const task = createInvestigationTask({
    target: { owner: "facebook", repository: "react", issueNumber },
  });
  const session: InvestigationSession = {
    state: new InvestigationState(task, createInvestigationRun({ task })),
    trace: new TraceCollector(),
    runId: "run-retrieval-foundation",
    llmUsage: new LlmUsageCollector(),
  };
  session.state.addEvidence(
    createEvidence({
      kind: "issue",
      summary: `Issue #${issueNumber} is open: ${title}`,
      payload: {
        number: issueNumber,
        repository: "facebook/react",
        state: "open",
        title,
        body: title,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      provenance: {
        source: "github",
        repository: "facebook/react",
        resource: `issues/${issueNumber}`,
        url: `https://github.com/facebook/react/issues/${issueNumber}`,
        retrievedAt: RETRIEVED_AT,
        trust: "external_untrusted",
      },
      contentRef: resourceKey("issue", String(issueNumber)),
    }),
  );
  session.state.investigatedResources.add(resourceKey("issue", String(issueNumber)));
  session.state.issueState = "open";
  return session;
}

test("TEST 1 — PR and commit discovery both produce RetrievalCandidate", () => {
  const commits = discoverCommitCandidates(
    [{ sha: "abc1234deadbeef", message: "fixes #37269 terminal resize" }],
    { issueNumber: 37269, issueTitle: "terminal resize suggestions" },
  );
  const pulls = discoverPullCandidates(
    [{ number: 99, title: "Fix terminal resize suggestions" }],
    { issueNumber: 37269, issueTitle: "terminal resize suggestions" },
  );
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.sourceType, "commit");
  assert.equal(commits[0]?.sourceId, "abc1234deadbeef");
  assert.equal(commits[0]?.status, "candidate");
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0]?.sourceType, "pull_request");
  assert.equal(pulls[0]?.sourceId, "99");
  assert.equal(pulls[0]?.status, "candidate");
});

test("TEST 2 — issue-reference ranking prefers fixes #<id>", () => {
  const ranked = rankCandidates([
    createRetrievalCandidate({
      sourceType: "commit",
      sourceId: "bbbb",
      retrievalReason: "unrelated",
      relevanceSignals: { lexicalScore: 0 },
    }),
    createRetrievalCandidate({
      sourceType: "commit",
      sourceId: "aaaa",
      retrievalReason: "fixes the issue",
      relevanceSignals: { issueReference: true },
    }),
  ]);
  assert.equal(ranked[0]?.sourceId, "aaaa");
  assert.equal(ranked[0]?.relevanceSignals.issueReference, true);
});

test("TEST 3 — lexical ranking prefers overlapping issue language", () => {
  const discovered = discoverCommitCandidates(
    [
      { sha: "doc", message: "update documentation" },
      { sha: "fix", message: "fix terminal suggestions after resize" },
    ],
    { issueNumber: 37269, issueTitle: "terminal resize suggestions", issueBody: "terminal resize suggestions" },
  );
  const ranked = rankCandidates(discovered);
  assert.equal(ranked[0]?.sourceId, "fix");
  assert.ok((ranked[0]?.relevanceSignals.lexicalScore ?? 0) > (ranked[1]?.relevanceSignals.lexicalScore ?? 0));
});

test("TEST 4 — temporal proximity is not a hard filter", () => {
  const discovered = discoverCommitCandidates(
    [
      {
        sha: "older",
        message: "fixes #37269 earlier landing",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ],
    {
      issueNumber: 37269,
      issueTitle: "terminal resize suggestions",
      issueCreatedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.status, "candidate");
  assert.ok(Date.parse("2025-01-01T00:00:00.000Z") < Date.parse("2026-01-01T00:00:00.000Z"));
});

test("TEST 5 — Top-K selects only the investigation budget", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    createRetrievalCandidate({
      sourceType: "commit",
      sourceId: `sha-${index}`,
      retrievalReason: "synthetic",
      relevanceSignals: { lexicalScore: index },
    }),
  );
  const selected = selectTopCandidates(candidates, 3);
  assert.equal(selected.length, 3);
  assert.equal(selected.every((item) => item.status === "investigating"), true);
  assert.equal(MAX_INVESTIGATED_CANDIDATES, 5);
  assert.equal(RETRIEVAL_TOP_K, 5);
});

test("combined retrieval Top-K is not the per-type investigation budget", () => {
  const pulls = Array.from({ length: 3 }, (_, index) =>
    createRetrievalCandidate({
      sourceType: "pull_request",
      sourceId: String(index + 1),
      retrievalReason: "synthetic",
      status: "investigating",
    }),
  );
  const commits = Array.from({ length: 3 }, (_, index) =>
    createRetrievalCandidate({
      sourceType: "commit",
      sourceId: `sha-${index}`,
      retrievalReason: "synthetic",
      status: index === 0 ? "promoted" : "investigating",
    }),
  );
  const combined = [...pulls, ...commits];
  const investigation = investigationCandidatesOf(combined);
  const topK = retrievalTopKOf(combined, RETRIEVAL_TOP_K);
  assert.equal(investigation.length, 6);
  assert.equal(topK.length, RETRIEVAL_TOP_K);
  assert.equal(promotedCandidatesOf(combined).length, 1);
  assert.equal(topK.some((item) => item.sourceId === "sha-2"), false);
  assert.equal(investigation.some((item) => item.sourceId === "sha-2"), true);
});

test("TEST 6 — Discovery creates candidates, not Evidence", () => {
  const session = makeSession();
  const before = session.state.run.evidence.length;
  const ids = ingestObservation(
    session,
    "github_list_commits",
    { owner: "facebook", repo: "react" },
    {
      commits: [
        { sha: "aaa111", message: "fixes #37269 terminal resize", repository: "facebook/react", retrievedAt: RETRIEVED_AT },
        { sha: "bbb222", message: "update documentation", repository: "facebook/react", retrievedAt: RETRIEVED_AT },
      ],
      truncated: false,
    },
  );
  assert.equal(ids.length, 0);
  assert.equal(session.state.run.evidence.length, before);
  assert.equal(session.state.run.evidence.filter((item) => item.kind === "commit").length, 0);
  assert.ok(session.state.retrievalCandidates.length >= 2);
  assert.equal(session.state.retrievalCandidates.every((item) => item.sourceType === "commit"), true);

  const investigated = ingestObservation(
    session,
    "github_get_commit",
    { owner: "facebook", repo: "react", sha: "aaa111" },
    { sha: "aaa111", message: "fixes #37269 terminal resize", repository: "facebook/react", retrievedAt: RETRIEVED_AT },
  );
  assert.equal(investigated.length, 1);
  assert.equal(session.state.run.evidence.filter((item) => item.kind === "commit").length, 1);
  assert.equal(
    session.state.retrievalCandidates.find((item) => item.sourceId === "aaa111")?.status,
    "promoted",
  );
});

test("TEST 7 — bounded repository discovery keeps network/candidate/truncated metadata", () => {
  const session = makeSession();
  const output = {
    commits: Array.from({ length: 80 }, (_, index) => ({
      sha: `c${String(index).padStart(3, "0")}${"a".repeat(37)}`.slice(0, 40),
      message: `Repo commit ${index}`,
      repository: "facebook/react",
      retrievedAt: RETRIEVED_AT,
    })),
    truncated: true,
  };
  ingestObservation(session, "github_list_commits", { owner: "facebook", repo: "react" }, output);
  assert.equal(session.state.retrievalCandidates.length, MAX_REPOSITORY_COMMIT_DISCOVERY);
  assert.equal(session.state.discoveryTruncated, true);
  assert.ok(session.state.selectedRetrievalCandidates("commit").length <= MAX_INVESTIGATED_CANDIDATES);
  assert.equal(session.state.run.evidence.filter((item) => item.kind === "commit").length, 0);
});

test("TEST 8 — C08 direct-commit path remains Issue → Candidate → Investigation → Evidence → Verification", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C08");
  assert.equal(executed.observed.verificationStatus, "verified_complete");
  assert.equal(
    executed.report.investigationSteps.some(
      (step) => step.tool === "github_list_commits" && step.success === true,
    ),
    true,
  );
  assert.equal(
    executed.report.investigationSteps.some(
      (step) => step.tool === "github_get_commit" && step.success === true,
    ),
    true,
  );
  assert.ok(
    executed.report.evidence.some(
      (item) => item.kind === "commit" && /e70118a/i.test(JSON.stringify(item.payload ?? item.summary)),
    ),
  );
});

test("TEST 9 — OPEN issue (react/react#37269) is not terminal because issue_closed is rejected", () => {
  const session = makeSession(37269);
  const gap = computeEvidenceGap(session.state.task, session.state.run);
  assert.equal(
    gap.rejectedRequirements.some((item) => item.condition === "issue_closed"),
    true,
  );
  assert.equal(hasTerminalNegativeEvidence(gap), false);
  const legal = proposeCandidateActions(session.state, { gap });
  assert.equal(
    legal.some(
      (item) =>
        item.tool === "github_get_issue_timeline" ||
        item.tool === "github_get_issue_comments" ||
        item.tool === "github_list_commits",
    ),
    true,
  );
  const planned = planInvestigationStrategy(session.state, { gap });
  assert.equal(planned.closure, "GAP_OPEN_ACTIONABLE");
});

test("TEST 10 — empty discovery is no_candidate_found, not verification or resolution failure", () => {
  const session = makeSession();
  ingestObservation(session, "github_list_commits", { owner: "facebook", repo: "react" }, {
    commits: [],
    truncated: false,
  });
  assert.equal(session.state.retrievalOutcome, NO_CANDIDATE_FOUND);
  assert.equal(session.state.retrievalCandidates.length, 0);
  assert.equal(session.state.run.evidence.filter((item) => item.kind === "commit").length, 0);

  const verification = new IndependentCompletionVerifier().verify({
    task: session.state.task,
    run: session.state.run,
    agentClaimedComplete: false,
  });
  assert.notEqual(verification.status, "verified_complete");
  assert.notEqual(session.state.polarity, "unresolved");
  const gap = computeEvidenceGap(session.state.task, session.state.run);
  assert.equal(
    gap.items.some((item) => item.condition === "resolution_candidate" && item.outcome === "missing"),
    true,
  );
});

function pullCandidate(sourceId: string, lexicalScore: number, status?: "candidate" | "investigating" | "rejected" | "promoted") {
  return createRetrievalCandidate({
    sourceType: "pull_request",
    sourceId,
    retrievalReason: "synthetic pull candidate",
    relevanceSignals: { lexicalScore },
    status,
  });
}

function countStatus(
  candidates: Array<{ status: string }>,
  status: string,
): number {
  return candidates.filter((item) => item.status === status).length;
}

test("Test A — first batch of 6 PR candidates keeps investigating at Top-K", () => {
  const first = Array.from({ length: 6 }, (_, index) => pullCandidate(String(index + 1), index + 1));
  const selected = applyCandidateSelection(first, 5);
  assert.equal(countStatus(selected, "investigating"), 5);
  assert.equal(countStatus(selected, "rejected"), 1);
  assert.ok(selected.every((item) => item.status !== "investigating" || item.relevanceSignals.lexicalScore !== 1));
});

test("Test B — later higher-scoring PRs re-rank and investigating stays <= 5", () => {
  const first = applyCandidateSelection(
    Array.from({ length: 6 }, (_, index) => pullCandidate(String(index + 1), index + 1)),
    5,
  );
  assert.equal(countStatus(first, "investigating"), 5);
  const next = applyCandidateSelection(
    [
      ...first,
      pullCandidate("100", 50),
      pullCandidate("101", 51),
      pullCandidate("102", 52),
    ],
    5,
  );
  assert.ok(countStatus(next, "investigating") <= 5);
  assert.equal(countStatus(next, "investigating"), 5);
  assert.deepEqual(
    next.filter((item) => item.status === "investigating").map((item) => item.sourceId).sort(),
    ["100", "101", "102", "5", "6"],
  );
});

test("Test C — promoted candidates consume investigation budget", () => {
  const first = applyCandidateSelection(
    Array.from({ length: 6 }, (_, index) => pullCandidate(String(index + 1), index + 1)),
    5,
  );
  const withPromoted = first.map((item) =>
    item.sourceId === "5" || item.sourceId === "6" ? { ...item, status: "promoted" as const } : item,
  );
  const next = applyCandidateSelection(
    [...withPromoted, pullCandidate("100", 50), pullCandidate("101", 51), pullCandidate("102", 52)],
    5,
  );
  assert.equal(countStatus(next, "promoted"), 2);
  assert.ok(countStatus(next, "investigating") <= 3);
  assert.equal(countStatus(next, "investigating"), 3);
  assert.deepEqual(
    next.filter((item) => item.status === "promoted").map((item) => item.sourceId).sort(),
    ["5", "6"],
  );
});

test("Test D — repeated registerPullCandidates / applyCandidateSelection never exceeds budget", () => {
  const session = makeSession(10, "budget overflow");
  ingestObservation(session, "github_get_issue", { owner: "facebook", repo: "react", issueNumber: 10 }, {
    number: 10,
    state: "open",
    title: "budget overflow",
    body: "#1 #2 #3 #4 #5 #6",
    repository: "facebook/react",
    retrievedAt: RETRIEVED_AT,
  });
  assert.ok(countStatus(session.state.retrievalCandidates, "investigating") <= MAX_INVESTIGATED_CANDIDATES);

  ingestObservation(session, "github_get_issue_timeline", { owner: "facebook", repo: "react", issueNumber: 10 }, [
    { event: "cross-referenced", pullRequestNumber: 20, body: "see #21" },
    { event: "cross-referenced", pullRequestNumber: 22, body: "" },
    { event: "commented", body: "also #23 #24" },
  ]);
  assert.ok(countStatus(session.state.retrievalCandidates, "investigating") <= MAX_INVESTIGATED_CANDIDATES);

  ingestObservation(session, "github_get_issue_comments", { owner: "facebook", repo: "react", issueNumber: 10 }, [
    { body: "try #30 #31 #32" },
    { body: "or #33 #34" },
  ]);
  assert.ok(countStatus(session.state.retrievalCandidates, "investigating") <= MAX_INVESTIGATED_CANDIDATES);

  let group = session.state.retrievalCandidates.filter((item) => item.sourceType === "pull_request");
  for (let round = 0; round < 4; round += 1) {
    group = applyCandidateSelection(
      [...group, pullCandidate(String(200 + round), 80 + round)],
      MAX_INVESTIGATED_CANDIDATES,
    );
    assert.ok(countStatus(group, "investigating") <= MAX_INVESTIGATED_CANDIDATES);
  }
});

test("Test E — C08 direct-commit path still verifies after budget enforcement", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C08");
  assert.equal(executed.observed.verificationStatus, "verified_complete");
  assert.ok(
    executed.report.evidence.some(
      (item) => item.kind === "commit" && /e70118a/i.test(JSON.stringify(item.payload ?? item.summary)),
    ),
  );
});
