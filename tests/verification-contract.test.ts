import assert from "node:assert/strict";
import test from "node:test";
import {
  bindClaimEvidence,
  createClaim,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
  evaluateEvidenceRequirement,
  requirementEvalContext,
} from "../src/domain/index.js";
import {
  computeBenchmarkMetrics,
  executeDatasetCase,
  isFalseCompletion,
  isVerifierFalsePositive,
  loadDataset,
  realDatasetManifestPath,
  type ScenarioResult,
} from "../src/benchmark/index.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";

const now = "2026-09-17T00:00:00.000Z";
const verifier = new IndependentCompletionVerifier();

function provenance(resource: string, url: string) {
  return {
    source: "github" as const,
    repository: "acme/box",
    resource,
    url,
    retrievedAt: now,
    trust: "external_untrusted" as const,
  };
}

function verifyGraph(input: {
  issueTitle: string;
  issueBody?: string;
  stateReason?: string;
  pr?: { title: string; body: string; merged: boolean };
  commit?: { sha: string; message: string };
  linkCommitToIssue?: boolean;
}) {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const issue = createEvidence({
    kind: "issue",
    summary: `Issue #42 ${input.issueTitle}`,
    payload: {
      number: 42,
      repository: "acme/box",
      state: "closed",
      stateReason: input.stateReason ?? "completed",
      title: input.issueTitle,
      body: input.issueBody ?? input.issueTitle,
    },
    provenance: provenance("issues/42", "https://github.com/acme/box/issues/42"),
  });
  run.evidence.push(issue);
  if (input.pr) {
    const pr = createEvidence({
      kind: "pull_request",
      summary: input.pr.title,
      payload: {
        number: 7,
        repository: "acme/box",
        merged: input.pr.merged,
        state: "closed",
        title: input.pr.title,
        body: input.pr.body,
      },
      provenance: provenance("pull/7", "https://github.com/acme/box/pull/7"),
    });
    run.evidence.push(pr);
    run.relations.push(createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue.id, type: "fixes" }));
    if (input.commit) {
      const commit = createEvidence({
        kind: "commit",
        summary: input.commit.message,
        payload: { sha: input.commit.sha, repository: "acme/box", message: input.commit.message },
        provenance: provenance(`commit/${input.commit.sha}`, `https://github.com/acme/box/commit/${input.commit.sha}`),
      });
      run.evidence.push(commit);
      run.relations.push(createRelation({ fromEvidenceId: commit.id, toEvidenceId: pr.id, type: "derived_from" }));
    }
  } else if (input.commit) {
    const commit = createEvidence({
      kind: "commit",
      summary: input.commit.message,
      payload: { sha: input.commit.sha, repository: "acme/box", message: input.commit.message },
      provenance: provenance(`commit/${input.commit.sha}`, `https://github.com/acme/box/commit/${input.commit.sha}`),
    });
    run.evidence.push(commit);
    if (input.linkCommitToIssue !== false) {
      run.relations.push(createRelation({ fromEvidenceId: commit.id, toEvidenceId: issue.id, type: "fixes" }));
    }
  }
  const claim = createClaim({
    text: "Resolution hypothesis",
    polarity: "resolved",
    critical: true,
  });
  run.claims.push(claim);
  const supportId = run.evidence.find((item) => item.kind !== "issue")?.id ?? issue.id;
  run.claimEvidence.push(bindClaimEvidence({ claimId: claim.id, evidenceId: supportId, role: "supports" }));
  return verifier.verify({ task, run });
}

test("TEST 1 — PR merge path can reach verified_complete", () => {
  const result = verifyGraph({
    issueTitle: "Null pointer when saving empty cart",
    pr: { title: "Fix empty cart save", body: "Fixes #42", merged: true },
    commit: { sha: "abc123def456", message: "Fix empty cart save\n\nFixes #42" },
  });
  assert.equal(result.status, "verified_complete");
  assert.equal(result.checks.find((item) => item.id === "pr-merged")?.status, "pass");
});

test("TEST 2 — Direct commit path can reach verified_complete", () => {
  const result = verifyGraph({
    issueTitle: "Dynamic configuration of lobby",
    issueBody: "Implement dynamic configuration via JSON file and remote url.",
    commit: {
      sha: "e70118a2a11aa239472336f6a961784f04c63c9d",
      message:
        "Add GitHub actions workflow to push dynamic config.\n\nResolves #42",
    },
  });
  assert.equal(result.status, "verified_complete");
  assert.equal(result.checks.find((item) => item.id === "resolution-candidate")?.status, "pass");
  assert.equal(result.checks.find((item) => item.id === "pr-merged")?.status, "pass");
  assert.equal(result.checks.find((item) => item.id === "code-commit")?.status, "pass");
});

test("TEST 3 — mismatched resolution cannot be verified_complete", () => {
  const result = verifyGraph({
    issueTitle: "[BUG] multiSession: listDeviceSessions() only returns 2 sessions when maximumSessions: 3",
    issueBody: "Three different accounts should all appear in listDeviceSessions().",
    pr: {
      title: "fix(multi-session): prevent duplicate cookies when same user signs in multiple times",
      body: "Closes #42\n\nFixes duplicate multi-session cookies when the same user signs in multiple times.",
      merged: true,
    },
    commit: {
      sha: "c93dd33bf1d9678dcfbeab3421438e1d1de95f15",
      message: "fix(multi-session): prevent duplicate cookies",
    },
  });
  assert.notEqual(result.status, "verified_complete");
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.checks.find((item) => item.id === "resolution-effect")?.status, "unknown");
});

test("TEST 4 — closed as not planned is not_verified", () => {
  const result = verifyGraph({
    issueTitle: "Feature request we will not do",
    stateReason: "not_planned",
  });
  assert.equal(result.status, "not_verified");
  assert.equal(result.checks.find((item) => item.id === "closure-semantics")?.status, "fail");
});

test("TEST 5 — no positive or negative resolution evidence is insufficient_evidence", () => {
  const result = verifyGraph({
    issueTitle: "Something closed without a resolution path",
    stateReason: "completed",
  });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.checks.find((item) => item.id === "resolution-candidate")?.status, "unknown");
});

test("TEST 6 — merged PR plus files is not automatic verified_complete without effect alignment", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C07");
  assert.notEqual(executed.observed.verificationStatus, "verified_complete");
  assert.equal(executed.report.verification?.checks.some((item) => item.id === "pr-merged" && item.status === "pass"), true);
  assert.equal(
    executed.report.verification?.checks.some((item) => item.id === "resolution-effect" && item.status !== "pass"),
    true,
  );
});

test("TEST 2b — C08 direct commit path is observable as verified_complete", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C08");
  assert.equal(executed.observed.verificationStatus, "verified_complete");
  assert.match(
    JSON.stringify(executed.report.verification?.checks ?? []),
    /direct commit|e70118a/i,
  );
});

test("TEST 7 — Ground truth stays out of agent input", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const executed = await executeDatasetCase(dataset, "C07");
  const agentInput = JSON.stringify({
    task: executed.report.task,
    scenario: executed.scenario,
  });
  assert.equal(agentInput.includes("expectedOutcome"), false);
  assert.equal(agentInput.includes("expectedFailureModes"), false);
  assert.equal(agentInput.includes("wrong_target"), false);
  assert.equal(agentInput.includes("ground-truth.json"), false);
});

test("TEST 8 — verifierFalsePositiveRate captures verified_complete against not_verified ground truth", () => {
  assert.equal(isVerifierFalsePositive("not_verified", "verified_complete"), true);
  assert.equal(isVerifierFalsePositive("not_verified", "insufficient_evidence"), false);
  assert.equal(isFalseCompletion(true, "not_verified"), true);
  assert.equal(isFalseCompletion(true, "verified_complete"), false);

  const results: ScenarioResult[] = [
    {
      scenarioId: "c07-shape",
      kind: "failure",
      expectedOutcome: "not_verified",
      observedOutcome: "verified_complete",
      passed: false,
      attemptCount: 1,
      toolCallCount: 8,
      verificationStatus: "verified_complete",
      failureTypes: [],
      expectedFailureModes: ["wrong_target"],
      observedFailureModes: [],
      agentClaimedComplete: true,
      falseCompletion: false,
      recovered: false,
      recoveryAttempted: false,
      evidenceCoverage: 1,
      unsupportedClaimRate: 0,
    },
    {
      scenarioId: "ok",
      kind: "normal",
      expectedOutcome: "verified_complete",
      observedOutcome: "verified_complete",
      passed: true,
      attemptCount: 1,
      toolCallCount: 6,
      verificationStatus: "verified_complete",
      failureTypes: [],
      expectedFailureModes: [],
      observedFailureModes: [],
      agentClaimedComplete: true,
      falseCompletion: false,
      recovered: false,
      recoveryAttempted: false,
      evidenceCoverage: 1,
      unsupportedClaimRate: 0,
    },
  ];
  const metrics = computeBenchmarkMetrics(results);
  assert.equal(metrics.falseCompletionRate, 0);
  assert.equal(metrics.verifierFalsePositiveRate, 1);
});

test("eligible_closure rejects not_planned via requirement evaluation", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const issue = createEvidence({
    kind: "issue",
    summary: "closed not planned",
    payload: {
      number: 42,
      repository: "acme/box",
      state: "closed",
      stateReason: "not_planned",
      title: "no",
    },
    provenance: provenance("issues/42", "https://github.com/acme/box/issues/42"),
  });
  const evaluation = evaluateEvidenceRequirement(
    {
      id: "req-closure",
      kind: "issue",
      severity: "required",
      description: "eligible",
      condition: "eligible_closure",
    },
    requirementEvalContext({ task, evidence: [issue] }),
  );
  assert.equal(evaluation.outcome, "rejected");
  assert.equal(evaluation.satisfied, false);
});
