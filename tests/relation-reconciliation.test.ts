/**
 * Phase 16.4-B1-b — Relationship Reconciliation.
 *
 * commit → hypothesis_fixes → issue must not depend on Evidence arrival order:
 * reconciliation re-runs after every ingestion round, keyed on the structured
 * TimelineEventSnapshot.commitId (legacy body-SHA only as compatibility path).
 * Relation truth here is graph fact only — never verified_complete.
 * Phase 18-B: text closing-keyword edges are typed hypothesis_fixes and never
 * certify; certified "fixes" comes only from structured corroboration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import {
  commitFact,
  createInvestigationRun,
  createInvestigationTask,
  issueFact,
} from "../src/domain/index.js";
import { ingestObservation, type InvestigationSession } from "../src/investigation/index.js";
import { InvestigationState } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const OWNER = "microsoft";
const REPO = "vscode";
const ISSUE_NUMBER = 258694;
const SHA = "67f18f167f3b21708fbd2c35a7cce20670c59b12";
const OTHER_SHA = "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b";
const RETRIEVED_AT = "2026-09-21T00:00:00.000Z";

function makeSession(): InvestigationSession {
  const task = createInvestigationTask({
    target: { owner: OWNER, repository: REPO, issueNumber: ISSUE_NUMBER },
  });
  return {
    state: new InvestigationState(task, createInvestigationRun({ task })),
    trace: new TraceCollector(),
    runId: "run-relation-reconciliation",
    llmUsage: new LlmUsageCollector(),
  };
}

function ingestIssue(session: InvestigationSession): void {
  ingestObservation(session, "github_get_issue", { issueNumber: ISSUE_NUMBER }, {
    number: ISSUE_NUMBER,
    repository: `${OWNER}/${REPO}`,
    state: "closed",
    title: "terminal quick fix should rank q",
    body: "issue body without references",
    url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`,
    retrievedAt: RETRIEVED_AT,
  });
}

function ingestCommit(session: InvestigationSession, sha = SHA): void {
  ingestObservation(session, "github_get_commit", { sha }, {
    sha,
    repository: `${OWNER}/${REPO}`,
    message: "rank terminal quick fix suggestions",
    author: "maintainer",
    url: `https://github.com/${OWNER}/${REPO}/commit/${sha}`,
    retrievedAt: RETRIEVED_AT,
  });
}

interface TimelineEventInit {
  commitId?: string;
  body: string;
}

function ingestTimeline(session: InvestigationSession, inits: TimelineEventInit[]): void {
  ingestObservation(
    session,
    "github_get_issue_timeline",
    { issueNumber: ISSUE_NUMBER },
    inits.map((init, index) => ({
      id: `timeline:${OWNER}/${REPO}:evt-${index}`,
      repository: `${OWNER}/${REPO}`,
      event: "referenced",
      createdAt: "2026-09-01T00:00:00Z",
      actor: "maintainer",
      body: init.body,
      ...(init.commitId ? { commitId: init.commitId } : {}),
      source: "github",
      url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`,
      retrievedAt: RETRIEVED_AT,
      trust: "external_untrusted",
    })),
  );
}

/** Stable semantic triples (source commit sha, relation type, target issue) — never raw Evidence ids. */
function commitFixTriples(session: InvestigationSession): string[] {
  const byId = new Map(session.state.run.evidence.map((item) => [item.id, item]));
  const triples: string[] = [];
  for (const relation of session.state.run.relations) {
    if (relation.type !== "hypothesis_fixes") {
      continue;
    }
    const source = byId.get(relation.fromEvidenceId);
    const target = byId.get(relation.toEvidenceId);
    const fact = source ? commitFact(source) : undefined;
    const issue = target ? issueFact(target) : undefined;
    if (fact && issue) {
      triples.push(`${fact.sha.toLowerCase()}|hypothesis_fixes|${issue.repository}#${issue.number}`);
    }
  }
  return triples.sort();
}

function fixesRelationCount(session: InvestigationSession): number {
  return session.state.run.relations.filter(
    (relation) => relation.type === "hypothesis_fixes" || relation.type === "fixes",
  ).length;
}

test("Test A — Timeline first: relation absent until Commit Evidence arrives, then reconciled", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
  assert.deepEqual(commitFixTriples(session), [], "relation construction must not fail permanently");

  ingestCommit(session);
  assert.deepEqual(commitFixTriples(session), [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`]);
});

test("Test B — Commit first: same final relation as Timeline first", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestCommit(session);
  assert.equal(fixesRelationCount(session), 0, "commit message alone must not claim fixes");

  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
  assert.deepEqual(commitFixTriples(session), [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`]);
});

test("Test C — both arrival orders converge to the same relation semantics", () => {
  const timelineEvents = [{ commitId: SHA, body: "fixes #258694" }];

  const timelineFirst = makeSession();
  ingestIssue(timelineFirst);
  ingestTimeline(timelineFirst, timelineEvents);
  ingestCommit(timelineFirst);

  const commitFirst = makeSession();
  ingestIssue(commitFirst);
  ingestCommit(commitFirst);
  ingestTimeline(commitFirst, timelineEvents);

  assert.deepEqual(commitFixTriples(timelineFirst), commitFixTriples(commitFirst));
  assert.equal(fixesRelationCount(timelineFirst), 1);
  assert.equal(fixesRelationCount(commitFirst), 1);
});

test("Test C.2 — Issue Evidence arriving last is reconciled too", () => {
  const session = makeSession();
  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
  ingestCommit(session);
  assert.deepEqual(commitFixTriples(session), []);

  ingestIssue(session);
  assert.deepEqual(commitFixTriples(session), [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`]);
});

test("Test D — commitId present but body contains no SHA: structured path builds fixes", () => {
  const session = makeSession();
  ingestIssue(session);
  const body = "fixes #258694";
  assert.equal(body.includes(SHA), false);
  ingestTimeline(session, [{ commitId: SHA, body }]);
  ingestCommit(session);

  assert.deepEqual(commitFixTriples(session), [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`]);
});

test("Test E — legacy snapshot without commitId still replays via body-SHA compatibility path", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ body: `fixes #258694 in ${SHA}` }]);
  ingestCommit(session);

  assert.deepEqual(
    commitFixTriples(session),
    [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`],
    "legacy body-SHA path is compatibility only, not the structured-fact path",
  );
});

test("Test E.2 — legacy short-SHA body resolves against full-SHA Commit Evidence", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ body: `fixes #258694 (${SHA.slice(0, 7)})` }]);
  ingestCommit(session);

  assert.deepEqual(commitFixTriples(session), [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`]);
});

test("Test F.1 — commitId without Commit Evidence must not invent a relation", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);

  assert.equal(fixesRelationCount(session), 0);
  assert.equal(session.state.run.evidence.some((item) => item.kind === "commit"), false);
});

test("Test F.2 — no structured commit identity and no body SHA: no commit relation", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestCommit(session);
  ingestTimeline(session, [{ body: "fixes #258694" }]);

  assert.equal(fixesRelationCount(session), 0);
});

test("Test F.3 — commitId present but no closing semantic evidence: no fixes relation", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ commitId: SHA, body: `mentioned ${SHA} in passing` }]);
  ingestCommit(session);

  assert.equal(fixesRelationCount(session), 0);
});

test("Test F.4 — mismatched SHA (no prefix relation) must not build fixes", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
  ingestCommit(session, OTHER_SHA);

  assert.equal(fixesRelationCount(session), 0);
});

test("Test G — reconciliation is idempotent across repeated ingestion rounds", () => {
  const session = makeSession();
  ingestIssue(session);
  ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
  ingestCommit(session);
  const expected = commitFixTriples(session);
  assert.equal(expected.length, 1);

  for (let round = 0; round < 3; round += 1) {
    ingestTimeline(session, [{ commitId: SHA, body: "fixes #258694" }]);
    ingestCommit(session);
  }

  assert.equal(fixesRelationCount(session), 1, "repeated reconcile must not duplicate the fixes edge");
  assert.deepEqual(commitFixTriples(session), expected);
});

test("Regression microsoft/vscode#258694 — fixes holds in either Timeline/Commit order", () => {
  const expected = [`${SHA}|hypothesis_fixes|${OWNER}/${REPO}#${ISSUE_NUMBER}`];
  const scenario = (order: "timeline-first" | "commit-first") => {
    const session = makeSession();
    ingestIssue(session);
    const events = [{ commitId: SHA, body: "fixes #258694" }];
    if (order === "timeline-first") {
      ingestTimeline(session, events);
      ingestCommit(session);
    } else {
      ingestCommit(session);
      ingestTimeline(session, events);
    }
    assert.deepEqual(commitFixTriples(session), expected, order);
  };
  scenario("timeline-first");
  scenario("commit-first");
});
