import assert from "node:assert/strict";
import test from "node:test";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import { InvestigationState } from "../src/investigation/state.js";
import { ingestObservation, type InvestigationSession } from "../src/investigation/investigation-tools.js";
import { matchLegalAction, proposeCandidateActions } from "../src/investigation/candidate-actions.js";
import { compactInvestigationToolOutput } from "../src/investigation/tool-result-context.js";
import { createInvestigationRun, createInvestigationTask } from "../src/domain/index.js";
import type { InvestigationRun, InvestigationTask } from "../src/domain/index.js";

const SHA = "67f18f167f3b21708fbd2c35a7cce20670c59b12";
const OWNER = "microsoft";
const REPO = "vscode";
const ISSUE = 258694;

function makeSession(): InvestigationSession {
  const task = createInvestigationTask({
    target: { owner: OWNER, repository: REPO, issueNumber: ISSUE },
  });
  const run = createInvestigationRun({ task });
  return {
    state: new InvestigationState(task, run),
    trace: new TraceCollector(),
    runId: "test-run",
    llmUsage: new LlmUsageCollector(),
  };
}

function timelineEvent(extra: Record<string, unknown> = {}) {
  return {
    id: "timeline:microsoft/vscode:1",
    repository: `${OWNER}/${REPO}`,
    event: "referenced",
    createdAt: "2026-09-01T00:00:00Z",
    actor: "maintainer",
    body: "fixes #258694",
    source: "github",
    url: "https://github.com/microsoft/vscode",
    retrievedAt: "2026-09-20T00:00:00.000Z",
    trust: "external_untrusted",
    ...extra,
  };
}

test("Test 1: Timeline commitId becomes RetrievalCandidate", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: SHA }),
  ]);
  const found = session.state.retrievalCandidates.find(
    (c) => c.sourceType === "commit" && c.sourceId === SHA,
  );
  assert.ok(found, "commit candidate should exist");
  assert.equal(found?.sourceId, SHA);
});

test("Test 2: Timeline commit candidate reaches selectedRetrievalCandidates", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: SHA }),
  ]);
  const selected = session.state.selectedRetrievalCandidates("commit");
  assert.ok(selected.some((c) => c.sourceId === SHA), "commit candidate should be selected");
});

test("Test 3: Selected candidate yields legal github_get_commit", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: SHA }),
  ]);
  const legal = proposeCandidateActions(session.state);
  const matched = matchLegalAction(
    { name: "github_get_commit", arguments: { owner: OWNER, repo: REPO, sha: SHA } },
    legal,
  );
  assert.ok(matched, "github_get_commit should be legal");
  assert.equal(matched?.tool, "github_get_commit");
});

test("Test 4: PR reference path still works", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: undefined, pullRequestNumber: 123, body: "" }),
  ]);
  const pr = session.state.retrievalCandidates.find(
    (c) => c.sourceType === "pull_request" && c.sourceId === "123",
  );
  assert.ok(pr, "PR candidate should exist");
  const legal = proposeCandidateActions(session.state);
  const matched = matchLegalAction(
    { name: "github_get_pull_request", arguments: { owner: OWNER, repo: REPO, pullNumber: 123 } },
    legal,
  );
  assert.ok(matched, "github_get_pull_request should be legal");
});

test("Test 5: Commit + PR coexist", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: SHA, pullRequestNumber: 123 }),
  ]);
  assert.ok(session.state.retrievalCandidates.some((c) => c.sourceType === "commit" && c.sourceId === SHA));
  assert.ok(session.state.retrievalCandidates.some((c) => c.sourceType === "pull_request" && c.sourceId === "123"));
  const legal = proposeCandidateActions(session.state);
  assert.ok(matchLegalAction({ name: "github_get_commit", arguments: { owner: OWNER, repo: REPO, sha: SHA } }, legal));
  assert.ok(
    matchLegalAction({ name: "github_get_pull_request", arguments: { owner: OWNER, repo: REPO, pullNumber: 123 } }, legal),
  );
});

test("Test 6: Duplicate commit references are deduplicated", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ commitId: SHA }),
    timelineEvent({ commitId: SHA }),
    timelineEvent({ commitId: ` ${SHA} ` }),
  ]);
  const matches = session.state.retrievalCandidates.filter(
    (c) => c.sourceType === "commit" && c.sourceId.toLowerCase() === SHA.toLowerCase(),
  );
  assert.equal(matches.length, 1);
});

test("Test 7: No commitId produces no commit candidate", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ body: "ordinary event" }),
  ]);
  // remove commitId key explicitly
  const commits = session.state.retrievalCandidates.filter((c) => c.sourceType === "commit");
  assert.equal(commits.length, 0);
  assert.ok(!commits.some((c) => !c.sourceId || c.sourceId === "undefined" || c.sourceId === ""));
});

test("Regression vscode#258694: full chain to legal github_get_commit", () => {
  const session = makeSession();
  ingestObservation(session, "github_get_issue_timeline", { owner: OWNER, repo: REPO, issueNumber: ISSUE }, [
    timelineEvent({ event: "referenced", commitId: SHA, body: "fixes #258694" }),
  ]);
  const candidate = session.state.retrievalCandidates.find((c) => c.sourceId === SHA);
  assert.ok(candidate);
  const selected = session.state.selectedRetrievalCandidates("commit");
  assert.ok(selected.some((c) => c.sourceId === SHA));
  const legal = proposeCandidateActions(session.state);
  const matched = matchLegalAction(
    { name: "github_get_commit", arguments: { owner: OWNER, repo: REPO, sha: SHA } },
    legal,
  );
  assert.ok(matched);
});

test("compactTimeline exposes commitId minimally", () => {
  const out = compactInvestigationToolOutput({
    tool: "github_get_issue_timeline",
    args: { owner: OWNER, repo: REPO, issueNumber: ISSUE },
    output: [timelineEvent({ commitId: SHA })],
    evidenceIds: [],
  }) as { result: { events: Array<Record<string, unknown>> } };
  assert.equal(out.result.events[0]?.commitId, SHA);
  assert.ok(!("body" in (out.result.events[0] ?? {})));
});
