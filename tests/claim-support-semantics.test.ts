/**
 * Phase 14.2 — claim_support semantics.
 * Completion-relevant Claim := critical AND polarity resolved|partial.
 * Absence of completion-relevant Claims never blocks completion; it only
 * means no support checking was required. Evidence remains the fact source.
 */
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
  type Evidence,
  type EvidenceRequirement,
} from "../src/domain/index.js";
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

function taskFor() {
  return createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
}

function issueEvidence() {
  return createEvidence({
    kind: "issue",
    summary: "Issue #42 is closed",
    payload: {
      number: 42,
      repository: "acme/box",
      state: "closed",
      title: "Null pointer when saving empty cart",
      body: "Saving an empty cart throws. Please fix.",
    },
    provenance: provenance("issues/42", "https://github.com/acme/box/issues/42"),
  });
}

function prEvidence(input?: { merged?: boolean }) {
  const merged = input?.merged ?? true;
  return createEvidence({
    kind: "pull_request",
    summary: `PR #7 merged=${merged}`,
    payload: {
      number: 7,
      repository: "acme/box",
      merged,
      state: "closed",
      title: "Fix empty cart save",
      body: "Fixes #42",
    },
    provenance: provenance("pull/7", "https://github.com/acme/box/pull/7"),
  });
}

function commitEvidence() {
  return createEvidence({
    kind: "commit",
    summary: "commit abc123def456",
    payload: { sha: "abc123def456", repository: "acme/box", message: "Fix empty cart save\n\nFixes #42" },
    provenance: provenance("commit/abc123def456", "https://github.com/acme/box/commit/abc123def456"),
  });
}

const claimReq: EvidenceRequirement = {
  id: "req-claim",
  kind: "other",
  severity: "required",
  description: "claim",
  condition: "claim_support",
};

function evalClaimSupport(input: {
  evidence: Evidence[];
  claims?: ReturnType<typeof createClaim>[];
  claimEvidence?: ReturnType<typeof bindClaimEvidence>[];
  relations?: ReturnType<typeof createRelation>[];
}) {
  return evaluateEvidenceRequirement(
    claimReq,
    requirementEvalContext({
      task: taskFor(),
      evidence: input.evidence,
      claims: input.claims,
      claimEvidence: input.claimEvidence,
      relations: input.relations,
    }),
  );
}

// Case A — no critical Claim
test("Case A — no claims at all: claim_support satisfied, no support validation required", () => {
  const evaluation = evalClaimSupport({ evidence: [issueEvidence()], claims: [] });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
  assert.match(evaluation.reason, /requires support validation/);
});

// Case B — only non-critical Claim
test("Case B — non-critical claim without support does not block", () => {
  const claim = createClaim({
    text: "Issue was resolved",
    polarity: "resolved",
    critical: false,
  });
  const evaluation = evalClaimSupport({ evidence: [issueEvidence()], claims: [claim] });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
  assert.match(evaluation.reason, /requires support validation/);
});

// Case C — critical resolved Claim with supporting ClaimEvidence
test("Case C — critical resolved claim with supporting ClaimEvidence is satisfied", () => {
  const pr = prEvidence();
  const claim = createClaim({ text: "Issue was resolved", polarity: "resolved", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [pr],
    claims: [claim],
    claimEvidence: [bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" })],
  });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
});

// Case D — critical partial Claim with supporting ClaimEvidence
test("Case D — critical partial claim with supporting ClaimEvidence is satisfied", () => {
  const pr = prEvidence();
  const claim = createClaim({ text: "Issue was partially resolved", polarity: "partial", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [pr],
    claims: [claim],
    claimEvidence: [bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" })],
  });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
});

// Case E — critical resolved Claim without supporting ClaimEvidence
test("Case E — critical resolved claim without ClaimEvidence is missing and names the claim", () => {
  const claim = createClaim({ text: "Issue was resolved", polarity: "resolved", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [issueEvidence()],
    claims: [claim],
    claimEvidence: [],
  });
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "missing");
  assert.deepEqual(evaluation.actual, [claim.id]);
});

// Case F — critical partial Claim without supporting ClaimEvidence
test("Case F — critical partial claim without ClaimEvidence is missing", () => {
  const claim = createClaim({ text: "Issue was partially resolved", polarity: "partial", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [issueEvidence()],
    claims: [claim],
    claimEvidence: [],
  });
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "missing");
  assert.deepEqual(evaluation.actual, [claim.id]);
});

// Case G — critical resolved Claim contradicted by ClaimEvidence
test("Case G — critical resolved claim contradicted by ClaimEvidence is rejected", () => {
  const pr = prEvidence();
  const unmerged = prEvidence({ merged: false });
  const claim = createClaim({ text: "Issue was resolved", polarity: "resolved", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [pr, unmerged],
    claims: [claim],
    claimEvidence: [
      bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" }),
      bindClaimEvidence({ claimId: claim.id, evidenceId: unmerged.id, role: "contradicts" }),
    ],
  });
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "rejected");
  assert.deepEqual(evaluation.actual, [claim.id]);
});

// Case H — critical partial Claim contradicted by ClaimEvidence
test("Case H — critical partial claim contradicted by ClaimEvidence is rejected", () => {
  const pr = prEvidence();
  const unmerged = prEvidence({ merged: false });
  const claim = createClaim({ text: "Issue was partially resolved", polarity: "partial", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [pr, unmerged],
    claims: [claim],
    claimEvidence: [
      bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" }),
      bindClaimEvidence({ claimId: claim.id, evidenceId: unmerged.id, role: "contradicts" }),
    ],
  });
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.outcome, "rejected");
});

// Case I — critical non-resolution polarity is not a completion assertion
test("Case I — critical unresolved/unknown claims never require support validation", () => {
  const unresolved = createClaim({ text: "Bug still reproduces", polarity: "unresolved", critical: true });
  const unknown = createClaim({ text: "Outcome unclear", polarity: "unknown", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [issueEvidence()],
    claims: [unresolved, unknown],
    claimEvidence: [],
  });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
  assert.match(evaluation.reason, /requires support validation/);
});

test("Case I — contradicted critical unresolved claim is not a completion rejection", () => {
  const issue = issueEvidence();
  const other = commitEvidence();
  const claim = createClaim({ text: "Bug still reproduces", polarity: "unresolved", critical: true });
  const evaluation = evalClaimSupport({
    evidence: [issue, other],
    claims: [claim],
    claimEvidence: [
      bindClaimEvidence({ claimId: claim.id, evidenceId: issue.id, role: "contextual" }),
    ],
    relations: [createRelation({ fromEvidenceId: issue.id, toEvidenceId: other.id, type: "contradicts" })],
  });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, "satisfied");
});

function completeRun() {
  const task = taskFor();
  const run = createInvestigationRun({ task });
  const issue = issueEvidence();
  const pr = prEvidence();
  const commit = commitEvidence();
  run.evidence.push(issue, pr, commit);
  run.relations.push(
    createRelation({ fromEvidenceId: pr.id, toEvidenceId: issue.id, type: "fixes" }),
    createRelation({ fromEvidenceId: commit.id, toEvidenceId: pr.id, type: "derived_from" }),
  );
  return { task, run, pr };
}

test("Verifier — no completion-relevant claim does not block verified_complete", () => {
  const { task, run } = completeRun();
  const result = verifier.verify({ task, run });
  assert.equal(result.status, "verified_complete");
  const claimCheck = result.checks.find((item) => item.id === "claims-supported");
  assert.equal(claimCheck?.status, "pass");
  assert.match(claimCheck?.message ?? "", /requires support validation/);
});

test("Verifier — unsupported non-critical claim does not block verified_complete", () => {
  const { task, run } = completeRun();
  run.claims.push(
    createClaim({ text: "Issue was resolved", polarity: "resolved", critical: false }),
  );
  const result = verifier.verify({ task, run });
  assert.equal(result.status, "verified_complete");
  assert.equal(result.unsupportedClaimIds.length, 0);
});

test("Verifier — contradicted critical unresolved claim does not block verified_complete", () => {
  const { task, run, pr } = completeRun();
  const claim = createClaim({ text: "Bug still reproduces", polarity: "unresolved", critical: true });
  run.claims.push(claim);
  run.claimEvidence.push(
    bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "contradicts" }),
  );
  const result = verifier.verify({ task, run });
  assert.equal(result.status, "verified_complete");
});

test("Verifier — regression: unsupported critical resolved claim still blocks completion", () => {
  const { task, run } = completeRun();
  run.claims.push(
    createClaim({ text: "Issue was resolved", polarity: "resolved", critical: true }),
  );
  const result = verifier.verify({ task, run });
  assert.notEqual(result.status, "verified_complete");
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.checks.find((item) => item.id === "claims-supported")?.status, "unknown");
  assert.equal(result.unsupportedClaimIds.length, 1);
});

test("Verifier — regression: contradicted critical resolved claim still rejects completion", () => {
  const { task, run, pr } = completeRun();
  const unmerged = prEvidence({ merged: false });
  run.evidence.push(unmerged);
  const claim = createClaim({ text: "Issue was resolved", polarity: "resolved", critical: true });
  run.claims.push(claim);
  run.claimEvidence.push(
    bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" }),
    bindClaimEvidence({ claimId: claim.id, evidenceId: unmerged.id, role: "contradicts" }),
  );
  const result = verifier.verify({ task, run });
  assert.equal(result.status, "not_verified");
  assert.equal(result.checks.find((item) => item.id === "claims-supported")?.status, "fail");
});
