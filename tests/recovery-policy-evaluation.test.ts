import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RECOVERY_POLICY_FOCUS_CASES,
  evaluatePhase12FocusCases,
  evaluateRecoveryPolicyDecision,
  isPrCreatingAction,
} from "../src/evaluation/index.js";
import {
  DEFAULT_RECOVERY_ACTION_PROFILES,
  createRecoveryBudget,
  decideRecoveryPolicy,
  deriveRecoveryIntents,
  toRecoveryActionCandidatesFromIntents,
} from "../src/investigation/index.js";
import type { ResolutionGap } from "../src/domain/index.js";

function gap(type: ResolutionGap["type"], severity: ResolutionGap["severity"] = "blocking"): ResolutionGap {
  return {
    candidateId: "cand-1",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-1"],
    explanation: "synthetic",
    recommendedActions: [],
  };
}

test("Phase 12.0 evaluation metrics hold and do not emit a winner", () => {
  const results = evaluatePhase12FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RECOVERY_POLICY_FOCUS_CASES],
  );
  for (const item of results) {
    assert.equal(item.metrics.budgetCompliant, true);
    assert.ok(item.metrics.selectedCost <= item.metrics.remainingBudget);
    assert.equal(item.metrics.gapCoverageHold, true);
    assert.equal(item.metrics.determinismHold, true);
    assert.equal(item.metrics.invalidRejected, true);
    assert.equal("winner" in item, false);
    assert.equal("bestStrategy" in item, false);
    assert.equal("completionRate" in item.metrics, false);
  }
});

test("Case C07 selects a reasonable patch-evidence action", () => {
  const results = evaluatePhase12FocusCases(["C07"]);
  const c07 = results[0];
  assert.ok(c07);
  assert.equal(c07.gapTypes.includes("missing_patch_evidence"), true);
  assert.equal(c07.candidateActions.includes("fetch_commit_patch"), true);
  assert.equal(c07.candidateActions.includes("inspect_changed_files"), true);
  assert.equal(c07.decision.selectedActions.includes("fetch_commit_patch"), true);
  assert.equal(c07.metrics.coveredGapTypes.includes("missing_patch_evidence"), true);
});

test("Case C08 does not select a PR-creating action", () => {
  const results = evaluatePhase12FocusCases(["C08"]);
  const c08 = results[0];
  assert.ok(c08);
  assert.equal(c08.gapTypes.includes("insufficient_resolution_context"), true);
  assert.equal(c08.candidateActions.includes("create_pull_request"), true);
  assert.equal(c08.decision.selectedActions.some(isPrCreatingAction), false);
  assert.equal(c08.decision.rejectedActions.includes("create_pull_request"), true);
  assert.ok(c08.decision.selectedActions.length > 0);
});

test("Case C10 only selects candidate discovery", () => {
  const results = evaluatePhase12FocusCases(["C10"]);
  const c10 = results[0];
  assert.ok(c10);
  assert.equal(c10.gapTypes.includes("missing_candidate"), true);
  assert.deepEqual(c10.decision.selectedActions, ["search_resolution_candidates"]);
  assert.equal(c10.decision.selectedActions.includes("fetch_commit_patch"), false);
  assert.equal(c10.decision.selectedActions.some(isPrCreatingAction), false);
});

test("Phase 12.0 evaluation does not leak ground truth and does not execute recovery", () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const gaps: ResolutionGap[] = [gap("missing_patch_evidence")];
  const intents = deriveRecoveryIntents(gaps);
  const observation = evaluateRecoveryPolicyDecision({
    gaps,
    intents,
    candidates: toRecoveryActionCandidatesFromIntents(intents),
    budget: createRecoveryBudget(),
    actionProfiles: DEFAULT_RECOVERY_ACTION_PROFILES,
  });
  assert.equal(observation.metrics.determinismHold, true);
  assert.equal(JSON.stringify(observation).includes("RecoveryExecutor"), false);
  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
  const again = decideRecoveryPolicy({
    gaps,
    intents,
    candidates: toRecoveryActionCandidatesFromIntents(intents),
    budget: createRecoveryBudget(),
    actionProfiles: DEFAULT_RECOVERY_ACTION_PROFILES,
  });
  assert.deepEqual(again.selectedActions, observation.decision.selectedActions);
});
