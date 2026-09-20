import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import { createInvestigationRun, createInvestigationTask } from "../src/domain/index.js";
import {
  NAIVE_RECOVERY_POLICY_NOTE,
  NaiveRecoveryPolicy,
  RECOVERY_POLICY_COMPARISON_FOCUS_CASES,
  aggregateRecoveryPolicyMetrics,
  buildPhase13ComparisonReport,
  buildPhase13PolicyInput,
  compareRecoveryPolicies,
  computeRecoveryPolicyDecisionMetrics,
  decideNaiveRecoveryPolicy,
  evaluatePhase13FocusCases,
  isPrCreatingAction,
} from "../src/evaluation/index.js";
import {
  IndependentCompletionVerifier,
  createRecoveryBudget,
  createRecoveryExecutor,
  decideRecoveryPolicy,
  remainingPolicyBudget,
} from "../src/investigation/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = join(ROOT, "src", "evaluation");
const PHASE13_FILES = [
  "recovery-policy-baseline.ts",
  "recovery-policy-comparison.ts",
  "recovery-policy-metrics.ts",
];

function fingerprint(result: { status: string; checks: Array<{ id: string; status: string }> }) {
  return `${result.status}|${result.checks.map((item) => `${item.id}:${item.status}`).join("|")}`;
}

function encoded(value: unknown): string {
  return JSON.stringify(value);
}

test("Test 1: Baseline deterministic", () => {
  const input = buildPhase13PolicyInput("C07");
  const first = decideNaiveRecoveryPolicy(input);
  const second = NaiveRecoveryPolicy.decide(input);
  const third = decideNaiveRecoveryPolicy(input);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(first.selectedActions, ["search_related_pr"]);
  assert.match(NAIVE_RECOVERY_POLICY_NOTE, /does not consider estimated cost/i);
  assert.equal("winner" in first, false);
});

test("Test 2: Policy comparison deterministic", () => {
  const input = buildPhase13PolicyInput("C08");
  const first = compareRecoveryPolicies(input, "C08");
  const second = compareRecoveryPolicies(input, "C08");
  assert.deepEqual(second, first);
  assert.deepEqual(first.baseline.decision, decideNaiveRecoveryPolicy(input));
  assert.deepEqual(first.policy.decision, decideRecoveryPolicy(input));
  assert.equal("winner" in first, false);
  assert.equal("bestPolicy" in first, false);
  assert.equal("superior" in first, false);
  assert.equal("completionRate" in first.baseline.metrics, false);
  assert.equal("completionRate" in first.policy.metrics, false);
});

test("Test 3: Cost calculation correct", () => {
  const c07 = compareRecoveryPolicies(buildPhase13PolicyInput("C07"), "C07");
  assert.equal(c07.baseline.metrics.selectedCost, 5);
  assert.equal(c07.policy.metrics.selectedCost, 1);
  assert.ok(c07.policy.metrics.selectedCost <= c07.baseline.metrics.selectedCost);
  const report = buildPhase13ComparisonReport();
  const baselineCostSum = report.cases.reduce((sum, item) => sum + item.baseline.metrics.selectedCost, 0);
  const policyCostSum = report.cases.reduce((sum, item) => sum + item.policy.metrics.selectedCost, 0);
  assert.equal(report.baselineAggregate.averageActionCost, baselineCostSum / report.cases.length);
  assert.equal(report.policyAggregate.averageActionCost, policyCostSum / report.cases.length);
  assert.equal(
    report.baselineAggregate.averageActionCost,
    aggregateRecoveryPolicyMetrics(report.cases.map((item) => item.baseline.metrics)).averageActionCost,
  );
});

test("Test 4: Gap coverage calculation correct", () => {
  const c07 = compareRecoveryPolicies(buildPhase13PolicyInput("C07"), "C07");
  const c08 = compareRecoveryPolicies(buildPhase13PolicyInput("C08"), "C08");
  const c10 = compareRecoveryPolicies(buildPhase13PolicyInput("C10"), "C10");
  assert.equal(c07.baseline.metrics.targetGapCount, 1);
  assert.equal(c07.baseline.metrics.coveredGapCount, 1);
  assert.equal(c07.baseline.metrics.gapCoverage, 1);
  assert.equal(c07.policy.metrics.gapCoverage, 1);
  assert.equal(c08.baseline.metrics.coveredGapCount, 0);
  assert.equal(c08.baseline.metrics.gapCoverage, 0);
  assert.equal(c08.policy.metrics.coveredGapCount, 1);
  assert.equal(c08.policy.metrics.gapCoverage, 1);
  assert.equal(c10.baseline.metrics.gapCoverage, 0);
  assert.equal(c10.policy.metrics.gapCoverage, 1);
  const unknownDecision = {
    selectedActions: ["fetch_commit_patch"],
    rejectedActions: [],
    reason: "synthetic unknown coverage",
  };
  const unknownInput = buildPhase13PolicyInput("C10");
  const unknownMetrics = computeRecoveryPolicyDecisionMetrics(
    {
      ...unknownInput,
      actionProfiles: unknownInput.actionProfiles.map((item) =>
        item.action === "fetch_commit_patch" ? { ...item, resolvesGapTypes: [] } : item,
      ),
    },
    unknownDecision,
  );
  assert.equal(unknownMetrics.gapCoverage, 0);
});

test("Test 5: Budget compliance", () => {
  const c07 = compareRecoveryPolicies(buildPhase13PolicyInput("C07"), "C07");
  const remaining = remainingPolicyBudget(createRecoveryBudget());
  assert.equal(c07.baseline.metrics.budgetConstraint, remaining);
  assert.equal(c07.policy.metrics.budgetConstraint, remaining);
  assert.equal(c07.baseline.metrics.selectedCost <= remaining, c07.baseline.metrics.budgetCompliant);
  assert.equal(c07.policy.metrics.selectedCost <= remaining, c07.policy.metrics.budgetCompliant);
  assert.equal(c07.baseline.metrics.budgetCompliant, false);
  assert.equal(c07.policy.metrics.budgetCompliant, true);
  const tight = compareRecoveryPolicies(
    buildPhase13PolicyInput(
      "C10",
      createRecoveryBudget({ maxRecoveryRounds: 1, maxAdditionalActions: 1, maxAdditionalToolCalls: 1 }),
    ),
    "C10",
  );
  assert.equal(tight.policy.metrics.budgetCompliant, true);
  assert.ok(tight.policy.metrics.selectedCost <= tight.policy.metrics.budgetConstraint);
});

test("Test 6: Evaluation does not modify runtime state", () => {
  let executed = 0;
  const executor = createRecoveryExecutor(async () => {
    executed += 1;
    return { action: "fetch_commit_patch", addedEvidenceIds: ["ev-new"], status: "completed" };
  });
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task, run });
  const beforeGroundTruth = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const input = buildPhase13PolicyInput("C07");
  const gapSnapshot = input.gaps.map((item) => ({ ...item }));
  const candidateSnapshot = input.candidates.map((item) => ({ ...item }));
  Object.freeze(input.gaps);
  Object.freeze(input.candidates);
  Object.freeze(input.intents);
  Object.freeze(input.actionProfiles);
  const comparison = compareRecoveryPolicies(input, "C07");
  const after = verifier.verify({ task, run });
  const afterGroundTruth = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(executed, 0);
  assert.equal(typeof executor.execute, "function");
  assert.equal(fingerprint(after), fingerprint(before));
  assert.equal(run.evidence.length, 0);
  assert.equal(afterGroundTruth, beforeGroundTruth);
  assert.deepEqual(input.gaps, gapSnapshot);
  assert.deepEqual(input.candidates, candidateSnapshot);
  assert.equal("addedEvidenceIds" in comparison.baseline.decision, false);
  assert.equal("addedEvidenceIds" in comparison.policy.decision, false);
  assert.equal(/RecoveryExecutor|tool_call|github_get_/.test(encoded(comparison)), false);
});

test("Case C07: Policy selected lower estimated cost actions", () => {
  const results = evaluatePhase13FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RECOVERY_POLICY_COMPARISON_FOCUS_CASES],
  );
  const c07 = results.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.deepEqual(c07.gapTypes, ["missing_patch_evidence"]);
  assert.deepEqual(c07.candidateActions, [
    "search_related_pr",
    "fetch_commit_patch",
    "inspect_changed_files",
  ]);
  assert.deepEqual(c07.baseline.decision.selectedActions, ["search_related_pr"]);
  assert.deepEqual(c07.policy.decision.selectedActions, ["fetch_commit_patch"]);
  assert.ok(c07.policy.metrics.selectedCost <= c07.baseline.metrics.selectedCost);
  assert.match(c07.notes.join(" "), /Policy selected lower estimated cost actions in C07/);
});

test("Case C08: Policy rejects invalid PR-creating action", () => {
  const c08 = evaluatePhase13FocusCases(["C08"])[0];
  assert.ok(c08);
  assert.deepEqual(c08.gapTypes, ["insufficient_resolution_context"]);
  assert.deepEqual(c08.baseline.decision.selectedActions, ["create_pull_request"]);
  assert.equal(c08.policy.decision.selectedActions.some(isPrCreatingAction), false);
  assert.equal(c08.policy.decision.rejectedActions.includes("create_pull_request"), true);
  assert.equal(c08.baseline.metrics.unnecessaryActionRate, 1);
  assert.equal(c08.policy.metrics.unnecessaryActionRate, 0);
  assert.equal(c08.policy.metrics.gapCoverage, 1);
  assert.equal(/fake resolution|resolved_complete|verified_complete/i.test(encoded(c08)), false);
});

test("Case C10: Policy selects candidate discovery", () => {
  const c10 = evaluatePhase13FocusCases(["C10"])[0];
  assert.ok(c10);
  assert.deepEqual(c10.gapTypes, ["missing_candidate"]);
  assert.deepEqual(c10.baseline.decision.selectedActions, ["fetch_commit_patch"]);
  assert.deepEqual(c10.policy.decision.selectedActions, ["search_resolution_candidates"]);
  assert.equal(c10.baseline.metrics.gapCoverage, 0);
  assert.equal(c10.policy.metrics.gapCoverage, 1);
  assert.equal(c10.baseline.metrics.unnecessaryActionRate, 1);
  assert.equal(c10.policy.metrics.unnecessaryActionRate, 0);
});

test("Phase 13.0 evaluation source does not import runtime execution", () => {
  for (const file of PHASE13_FILES) {
    const source = readFileSync(join(EVAL_DIR, file), "utf8");
    assert.equal(/from ["'][^"']*recovery-executor/.test(source), false, file);
    assert.equal(/from ["'][^"']*controlled-recovery-loop/.test(source), false, file);
    assert.equal(/from ["'][^"']*independent-completion-verifier/.test(source), false, file);
    assert.equal(/from ["'][^"']*github/.test(source), false, file);
    assert.equal(/Policy is better|Policy solves more issues/i.test(source), false, file);
  }
  const names = readdirSync(EVAL_DIR);
  assert.equal(names.includes("recovery-policy-baseline.ts"), true);
  assert.equal(names.includes("recovery-policy-comparison.ts"), true);
  assert.equal(names.includes("recovery-policy-metrics.ts"), true);
});

test("comparison report measures decision efficiency only", () => {
  const report = buildPhase13ComparisonReport();
  assert.equal(report.version, "13.0");
  assert.match(report.note, /does not measure completion improvement/i);
  assert.equal("winner" in report, false);
  assert.equal("bestPolicy" in report, false);
  assert.equal(report.cases.length, 3);
  for (const item of report.cases) {
    assert.equal("completionRate" in item.baseline.metrics, false);
    assert.equal("completionRate" in item.policy.metrics, false);
  }
});
