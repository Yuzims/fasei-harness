/**
 * Phase 13.0 — Recovery Policy decision-efficiency metrics.
 *
 * Measures estimated cost, gap coverage, unnecessary-action rate, and
 * budget compliance. Does not measure completion rate. unknown != resolved.
 */
import {
  remainingPolicyBudget,
  type RecoveryActionProfile,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "../investigation/index.js";

export const RECOVERY_POLICY_COMPARISON_METRICS_VERSION = "13.0";

export interface RecoveryPolicyDecisionMetrics {
  selectedCost: number;
  coveredGapCount: number;
  targetGapCount: number;
  /** coveredGapCount / targetGapCount. 0 when there is no target gap. */
  gapCoverage: number;
  selectedActionCount: number;
  unnecessaryActionCount: number;
  /** unnecessaryActionCount / selectedActionCount. 0 when nothing was selected. */
  unnecessaryActionRate: number;
  budgetConstraint: number;
  budgetCompliant: boolean;
}

export interface RecoveryPolicyAggregateMetrics {
  decisionCount: number;
  /** sum(selected estimatedCost) / number of decisions */
  averageActionCost: number;
  coveredGapCount: number;
  targetGapCount: number;
  gapCoverage: number;
  selectedActionCount: number;
  unnecessaryActionCount: number;
  unnecessaryActionRate: number;
  budgetCompliantDecisionCount: number;
  budgetComplianceRate: number;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function profileFor(
  action: string,
  profiles: readonly RecoveryActionProfile[],
): RecoveryActionProfile | undefined {
  return profiles.find((item) => item.action === action);
}

function targetGapTypes(input: RecoveryPolicyInput): string[] {
  return uniqueInOrder(input.gaps.map((item) => item.type));
}

function estimatedCostOf(
  action: string,
  profiles: readonly RecoveryActionProfile[],
): number {
  const profile = profileFor(action, profiles);
  if (!profile || !Number.isFinite(profile.estimatedCost)) {
    return 0;
  }
  return profile.estimatedCost;
}

function coversAnyTargetGap(
  action: string,
  targetTypes: readonly string[],
  profiles: readonly RecoveryActionProfile[],
): boolean {
  const profile = profileFor(action, profiles);
  if (!profile) {
    return false;
  }
  return targetTypes.some((type) => profile.resolvesGapTypes.includes(type));
}

function coveredTargetGapTypes(
  selectedActions: readonly string[],
  targetTypes: readonly string[],
  profiles: readonly RecoveryActionProfile[],
): string[] {
  const covered = new Set<string>();
  for (const action of selectedActions) {
    const profile = profileFor(action, profiles);
    if (!profile) {
      continue;
    }
    for (const type of targetTypes) {
      if (profile.resolvesGapTypes.includes(type)) {
        covered.add(type);
      }
    }
  }
  return targetTypes.filter((type) => covered.has(type));
}

/**
 * Per-decision efficiency metrics. A missing profile does not resolve a gap.
 */
export function computeRecoveryPolicyDecisionMetrics(
  input: RecoveryPolicyInput,
  decision: RecoveryDecision,
): RecoveryPolicyDecisionMetrics {
  const targetTypes = targetGapTypes(input);
  const selectedCost = decision.selectedActions.reduce(
    (sum, action) => sum + estimatedCostOf(action, input.actionProfiles),
    0,
  );
  const covered = coveredTargetGapTypes(decision.selectedActions, targetTypes, input.actionProfiles);
  const unnecessaryActionCount = decision.selectedActions.filter(
    (action) => !coversAnyTargetGap(action, targetTypes, input.actionProfiles),
  ).length;
  const selectedActionCount = decision.selectedActions.length;
  const budgetConstraint = remainingPolicyBudget(input.budget);
  return {
    selectedCost,
    coveredGapCount: covered.length,
    targetGapCount: targetTypes.length,
    gapCoverage: targetTypes.length === 0 ? 0 : covered.length / targetTypes.length,
    selectedActionCount,
    unnecessaryActionCount,
    unnecessaryActionRate: selectedActionCount === 0 ? 0 : unnecessaryActionCount / selectedActionCount,
    budgetConstraint,
    budgetCompliant: selectedCost <= budgetConstraint,
  };
}

export function aggregateRecoveryPolicyMetrics(
  items: readonly RecoveryPolicyDecisionMetrics[],
): RecoveryPolicyAggregateMetrics {
  const decisionCount = items.length;
  let selectedCostSum = 0;
  let coveredGapCount = 0;
  let targetGapCount = 0;
  let selectedActionCount = 0;
  let unnecessaryActionCount = 0;
  let budgetCompliantDecisionCount = 0;
  for (const item of items) {
    selectedCostSum += item.selectedCost;
    coveredGapCount += item.coveredGapCount;
    targetGapCount += item.targetGapCount;
    selectedActionCount += item.selectedActionCount;
    unnecessaryActionCount += item.unnecessaryActionCount;
    if (item.budgetCompliant) {
      budgetCompliantDecisionCount += 1;
    }
  }
  return {
    decisionCount,
    averageActionCost: decisionCount === 0 ? 0 : selectedCostSum / decisionCount,
    coveredGapCount,
    targetGapCount,
    gapCoverage: targetGapCount === 0 ? 0 : coveredGapCount / targetGapCount,
    selectedActionCount,
    unnecessaryActionCount,
    unnecessaryActionRate: selectedActionCount === 0 ? 0 : unnecessaryActionCount / selectedActionCount,
    budgetCompliantDecisionCount,
    budgetComplianceRate: decisionCount === 0 ? 0 : budgetCompliantDecisionCount / decisionCount,
  };
}
