import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RECOVERY_EVALUATION_FOCUS_CASES,
  analyzeRecoveryEffectivenessByGapType,
  classifyVerificationDelta,
  computeEvidenceGain,
  computeGapReduction,
  evaluateRecoveryImpact,
  evaluateRecoveryLoopFocusCases,
  readRecoveryCostFromTrace,
} from "../src/evaluation/index.js";
import type {
  RecoveryEvaluationBaselineInput,
  RecoveryEvaluationRecoveryInput,
} from "../src/evaluation/index.js";

function baselineInput(
  partial: Partial<RecoveryEvaluationBaselineInput> = {},
): RecoveryEvaluationBaselineInput {
  return {
    caseId: "synthetic",
    verifierStatus: "insufficient_evidence",
    gaps: ["missing_patch_evidence", "missing_validation_evidence"],
    evidenceCount: 3,
    ...partial,
  };
}

function recoveryInput(
  partial: Partial<RecoveryEvaluationRecoveryInput> = {},
): RecoveryEvaluationRecoveryInput {
  return {
    executed: true,
    actions: ["fetch_commit_patch"],
    recoveryAttempts: 1,
    verifierStatus: "insufficient_evidence",
    gaps: ["missing_validation_evidence"],
    evidenceCount: 4,
    additionalToolCalls: 1,
    additionalActions: 1,
    additionalAttempts: 1,
    ...partial,
  };
}

test("Test 1: Baseline and Recovery can be compared independently", () => {
  const baseline = baselineInput({
    caseId: "independent-baseline",
    gaps: ["missing_patch_evidence"],
    evidenceCount: 2,
  });
  const recovery = recoveryInput({
    gaps: ["missing_patch_evidence"],
    evidenceCount: 2,
    executed: false,
    actions: [],
    recoveryAttempts: 0,
    additionalToolCalls: 0,
    additionalActions: 0,
    additionalAttempts: 0,
  });
  const withoutRecovery = evaluateRecoveryImpact(baseline, recovery);

  const recoveredBaseline = baselineInput({
    caseId: "independent-baseline",
    gaps: ["missing_patch_evidence"],
    evidenceCount: 2,
  });
  const recovered = recoveryInput({
    gaps: [],
    evidenceCount: 3,
  });
  const withRecovery = evaluateRecoveryImpact(recoveredBaseline, recovered);

  assert.equal(withoutRecovery.caseId, withRecovery.caseId);
  assert.deepEqual(withoutRecovery.baseline.gaps, ["missing_patch_evidence"]);
  assert.equal(withoutRecovery.recovery.executed, false);
  assert.equal(withoutRecovery.metrics.gapReduction, 0);
  assert.equal(withoutRecovery.metrics.evidenceGain, 0);
  assert.equal(withRecovery.recovery.executed, true);
  assert.equal(withRecovery.metrics.gapReduction, 1);
  assert.equal(withRecovery.metrics.evidenceGain, 1);
  assert.notDeepEqual(withoutRecovery.metrics, withRecovery.metrics);
});

test("Test 2: Gap reduction is removed gaps / initial gaps", () => {
  assert.equal(
    computeGapReduction(
      ["missing_patch_evidence", "missing_validation_evidence"],
      ["missing_validation_evidence"],
    ),
    0.5,
  );
  assert.equal(computeGapReduction(["missing_patch_evidence"], []), 1);
  assert.equal(computeGapReduction(["missing_patch_evidence"], ["missing_patch_evidence"]), 0);
  assert.equal(computeGapReduction([], ["missing_patch_evidence"]), 0);

  const result = evaluateRecoveryImpact(
    baselineInput(),
    recoveryInput(),
  );
  assert.equal(result.metrics.gapReduction, 0.5);
  assert.deepEqual(result.baseline.gaps, ["missing_patch_evidence", "missing_validation_evidence"]);
  assert.deepEqual(result.afterRecovery.gaps, ["missing_validation_evidence"]);
});

test("Test 3: Evidence gain does not represent completion", () => {
  const result = evaluateRecoveryImpact(
    baselineInput({ evidenceCount: 4 }),
    recoveryInput({
      evidenceCount: 7,
      gaps: [],
      verifierStatus: "insufficient_evidence",
    }),
  );
  assert.equal(computeEvidenceGain(4, 7), 3);
  assert.equal(result.metrics.evidenceGain, 3);
  assert.equal(result.metrics.gapReduction, 1);
  assert.equal(result.afterRecovery.verifierStatus, "insufficient_evidence");
  assert.notEqual(result.afterRecovery.verifierStatus, "verified_complete");
  assert.equal(result.metrics.verificationChanged, false);
});

test("Test 4: Verifier invariant is preserved and no winner is emitted", () => {
  const unchanged = evaluateRecoveryImpact(baselineInput(), recoveryInput());
  assert.equal(unchanged.baseline.verifierStatus, "insufficient_evidence");
  assert.equal(unchanged.afterRecovery.verifierStatus, "insufficient_evidence");
  assert.equal(unchanged.metrics.verificationChanged, false);
  assert.equal(classifyVerificationDelta("insufficient_evidence", "insufficient_evidence"), "unchanged");
  assert.equal(classifyVerificationDelta("insufficient_evidence", "verified_complete"), "improved");
  assert.equal(classifyVerificationDelta("verified_complete", "insufficient_evidence"), "worse");
  assert.equal("winner" in unchanged, false);
  assert.equal("winner" in unchanged.metrics, false);
  assert.notEqual(unchanged.afterRecovery.verifierStatus, "verified_complete");
});

test("Test 5: False candidate count does not increase on C07 / C08 / C10", async () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const observations = await evaluateRecoveryLoopFocusCases();
  assert.deepEqual(
    observations.map((item) => item.caseId),
    [...RECOVERY_EVALUATION_FOCUS_CASES],
  );

  const c07 = observations.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.equal(c07.evaluation.baseline.gaps.includes("missing_patch_evidence"), true);
  assert.equal(c07.evaluation.recovery.executed, true);
  assert.ok(c07.evaluation.recovery.actions.includes("fetch_commit_patch"));
  assert.ok(c07.evaluation.metrics.gapReduction > 0);
  assert.ok(c07.evaluation.metrics.evidenceGain > 0);
  assert.equal(c07.evaluation.metrics.verificationChanged, false);
  assert.equal(c07.verificationDelta, "unchanged");
  assert.notEqual(c07.evaluation.afterRecovery.verifierStatus, "verified_complete");
  assert.equal(c07.verifierInvariant, true);
  assert.equal(c07.falseCandidateCount, 0);

  const c08 = observations.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.evaluation.recovery.executed, true);
  assert.equal(c08.evaluation.recovery.actions.includes("create_pull_request"), false);
  assert.equal(c08.falseCandidateCount, 0);
  assert.equal(c08.verifierInvariant, true);
  assert.notEqual(c08.evaluation.afterRecovery.verifierStatus, "verified_complete");

  const c10 = observations.find((item) => item.caseId === "C10");
  assert.ok(c10);
  assert.equal(c10.falseCandidateCount, 0);
  assert.equal(c10.verifierInvariant, true);
  assert.notEqual(c10.evaluation.afterRecovery.verifierStatus, "verified_complete");

  const taxonomy = analyzeRecoveryEffectivenessByGapType(observations.map((item) => item.evaluation));
  assert.equal("bestStrategy" in taxonomy, false);
  assert.equal("winner" in taxonomy, false);
  assert.ok(taxonomy.missing_patch_evidence);
  assert.equal(taxonomy.missing_patch_evidence.cases.includes("C07"), true);
  assert.ok(taxonomy.missing_patch_evidence.avgGapReduction > 0);

  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
});

test("Test 6: Evaluation does not modify runtime state", () => {
  const runtime = {
    evidence: ["ev-1", "ev-2", "ev-3"],
    attempts: ["attempt-1"],
    status: "insufficient_evidence",
    gaps: ["missing_patch_evidence", "missing_validation_evidence"],
  };
  const frozenEvidence = Object.freeze([...runtime.evidence]);
  const frozenAttempts = Object.freeze([...runtime.attempts]);
  const frozenGaps = Object.freeze([...runtime.gaps]);
  Object.freeze(runtime);

  const baseline = baselineInput({
    verifierStatus: runtime.status,
    gaps: frozenGaps,
    evidenceCount: frozenEvidence.length,
  });
  const recovery = recoveryInput({
    verifierStatus: runtime.status,
    gaps: ["missing_validation_evidence"],
    evidenceCount: frozenEvidence.length + 1,
    traceEvents: [
      {
        type: "recovery_attempt_started",
        data: { actions: ["fetch_commit_patch"] },
      },
    ],
  });
  const originalBaselineGaps = [...baseline.gaps];
  const originalRecoveryGaps = [...recovery.gaps];
  const originalActions = [...recovery.actions];

  const result = evaluateRecoveryImpact(baseline, recovery);
  result.baseline.gaps.push("mutated_by_caller_only");
  result.recovery.actions.push("mutated_by_caller_only");

  assert.deepEqual(runtime.evidence, frozenEvidence);
  assert.deepEqual(runtime.attempts, frozenAttempts);
  assert.deepEqual(runtime.gaps, frozenGaps);
  assert.equal(runtime.status, "insufficient_evidence");
  assert.deepEqual([...baseline.gaps], originalBaselineGaps);
  assert.deepEqual([...recovery.gaps], originalRecoveryGaps);
  assert.deepEqual([...recovery.actions], originalActions);
  assert.equal(readRecoveryCostFromTrace(recovery.traceEvents ?? []).additionalToolCalls, 1);
});
