/**
 * Phase 13.0 — Recovery Policy comparison.
 *
 * Compares Naive first-action decisions with Phase 12 cost-aware Policy
 * decisions. Both sides emit RecoveryDecision only. This module does not
 * execute recovery, mutate runtime state, or pick a winner.
 */
import type { ResolutionGap } from "../domain/index.js";
import {
  createRecoveryBudget,
  createRecoveryPolicyInput,
  decideRecoveryPolicy,
  deriveRecoveryIntents,
  type RecoveryActionCandidate,
  type RecoveryActionProfile,
  type RecoveryBudget,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "../investigation/index.js";
import { NaiveRecoveryPolicy } from "./recovery-policy-baseline.js";
import {
  aggregateRecoveryPolicyMetrics,
  computeRecoveryPolicyDecisionMetrics,
  type RecoveryPolicyAggregateMetrics,
  type RecoveryPolicyDecisionMetrics,
} from "./recovery-policy-metrics.js";

export const RECOVERY_POLICY_COMPARISON_VERSION = "13.0";

export const RECOVERY_POLICY_COMPARISON_FOCUS_CASES = ["C07", "C08", "C10"] as const;

export const RECOVERY_POLICY_COMPARISON_NOTE =
  "Phase 13.0 measures Recovery decision efficiency: estimated cost, gap coverage, unnecessary-action rate, and budget compliance. It does not measure completion improvement and does not pick a winner.";

export type RecoveryPolicyComparisonCaseId =
  (typeof RECOVERY_POLICY_COMPARISON_FOCUS_CASES)[number];

export interface RecoveryPolicyMetricDifference {
  selectedCost: number;
  gapCoverage: number;
  unnecessaryActionRate: number;
}

export interface RecoveryPolicySideObservation {
  decision: RecoveryDecision;
  metrics: RecoveryPolicyDecisionMetrics;
}

export interface RecoveryPolicyCaseComparison {
  caseId: string;
  gapTypes: ResolutionGap["type"][];
  candidateActions: string[];
  baseline: RecoveryPolicySideObservation;
  policy: RecoveryPolicySideObservation;
  metricDifference: RecoveryPolicyMetricDifference;
  notes: string[];
}

export interface RecoveryPolicyComparisonReport {
  version: string;
  note: string;
  cases: RecoveryPolicyCaseComparison[];
  baselineAggregate: RecoveryPolicyAggregateMetrics;
  policyAggregate: RecoveryPolicyAggregateMetrics;
  aggregateDifference: RecoveryPolicyMetricDifference;
}

interface FocusCaseConfig {
  caseId: RecoveryPolicyComparisonCaseId;
  gapType: ResolutionGap["type"];
  severity: ResolutionGap["severity"];
  candidates: Array<{ action: string; estimatedCost: number; resolvesGapTypes: string[] }>;
}

const FOCUS_CASES: FocusCaseConfig[] = [
  {
    caseId: "C07",
    gapType: "missing_patch_evidence",
    severity: "warning",
    candidates: [
      {
        action: "search_related_pr",
        estimatedCost: 5,
        resolvesGapTypes: ["missing_patch_evidence"],
      },
      {
        action: "fetch_commit_patch",
        estimatedCost: 1,
        resolvesGapTypes: ["missing_patch_evidence"],
      },
      {
        action: "inspect_changed_files",
        estimatedCost: 1,
        resolvesGapTypes: ["missing_patch_evidence"],
      },
    ],
  },
  {
    caseId: "C08",
    gapType: "insufficient_resolution_context",
    severity: "warning",
    candidates: [
      {
        action: "create_pull_request",
        estimatedCost: 1,
        resolvesGapTypes: [],
      },
      {
        action: "fetch_commit_patch",
        estimatedCost: 2,
        resolvesGapTypes: ["insufficient_resolution_context"],
      },
      {
        action: "inspect_changed_files",
        estimatedCost: 2,
        resolvesGapTypes: ["insufficient_resolution_context"],
      },
    ],
  },
  {
    caseId: "C10",
    gapType: "missing_candidate",
    severity: "blocking",
    candidates: [
      {
        action: "fetch_commit_patch",
        estimatedCost: 1,
        resolvesGapTypes: ["missing_patch_evidence", "insufficient_resolution_context"],
      },
      {
        action: "search_resolution_candidates",
        estimatedCost: 2,
        resolvesGapTypes: ["missing_candidate"],
      },
    ],
  },
];

function gap(type: ResolutionGap["type"], severity: ResolutionGap["severity"]): ResolutionGap {
  return {
    candidateId: "primary",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-1"],
    explanation: "phase-13 policy comparison gap",
    recommendedActions: [],
  };
}

function candidate(action: string): RecoveryActionCandidate {
  return {
    action: action as RecoveryActionCandidate["action"],
    reason: `Phase 13 evaluation candidate ${action}`,
    intentId: "phase-13-policy-comparison",
    autoExecute: false,
  };
}

function profileOf(item: FocusCaseConfig["candidates"][number]): RecoveryActionProfile {
  return {
    action: item.action,
    estimatedCost: item.estimatedCost,
    resolvesGapTypes: [...item.resolvesGapTypes],
  };
}

function cloneDecision(decision: RecoveryDecision): RecoveryDecision {
  return {
    selectedActions: [...decision.selectedActions],
    rejectedActions: [...decision.rejectedActions],
    reason: decision.reason,
  };
}

function differenceOf(
  policy: RecoveryPolicyDecisionMetrics,
  baseline: RecoveryPolicyDecisionMetrics,
): RecoveryPolicyMetricDifference {
  return {
    selectedCost: policy.selectedCost - baseline.selectedCost,
    gapCoverage: policy.gapCoverage - baseline.gapCoverage,
    unnecessaryActionRate: policy.unnecessaryActionRate - baseline.unnecessaryActionRate,
  };
}

function comparisonNotes(comparison: Omit<RecoveryPolicyCaseComparison, "notes">): string[] {
  const notes: string[] = [];
  const baselineSelected = comparison.baseline.decision.selectedActions;
  const policySelected = comparison.policy.decision.selectedActions;
  if (comparison.metricDifference.selectedCost < 0) {
    notes.push(
      `Policy selected lower estimated cost actions in ${comparison.caseId} (${comparison.policy.metrics.selectedCost} vs ${comparison.baseline.metrics.selectedCost}).`,
    );
  } else if (comparison.metricDifference.selectedCost > 0) {
    notes.push(
      `Policy selected higher estimated cost actions in ${comparison.caseId} (${comparison.policy.metrics.selectedCost} vs ${comparison.baseline.metrics.selectedCost}).`,
    );
  } else {
    notes.push(`Policy and baseline selected the same estimated cost in ${comparison.caseId}.`);
  }
  notes.push(
    `Gap coverage: baseline ${comparison.baseline.metrics.gapCoverage}, policy ${comparison.policy.metrics.gapCoverage}.`,
  );
  notes.push(
    `Unnecessary action rate: baseline ${comparison.baseline.metrics.unnecessaryActionRate}, policy ${comparison.policy.metrics.unnecessaryActionRate}.`,
  );
  notes.push(
    `Budget compliance: baseline ${comparison.baseline.metrics.budgetCompliant}, policy ${comparison.policy.metrics.budgetCompliant}.`,
  );
  notes.push(`Baseline selected ${baselineSelected.join(", ") || "none"}.`);
  notes.push(`Policy selected ${policySelected.join(", ") || "none"}.`);
  return notes;
}

export function buildPhase13PolicyInput(
  caseId: RecoveryPolicyComparisonCaseId,
  budget: RecoveryBudget = createRecoveryBudget(),
): RecoveryPolicyInput {
  const config = FOCUS_CASES.find((item) => item.caseId === caseId);
  if (!config) {
    throw new Error(`Unknown Phase 13 comparison case: ${caseId}`);
  }
  const gaps = [gap(config.gapType, config.severity)];
  const intents = deriveRecoveryIntents(gaps);
  return {
    gaps,
    intents,
    candidates: config.candidates.map((item) => candidate(item.action)),
    budget,
    actionProfiles: config.candidates.map(profileOf),
  };
}

/**
 * Run Naive baseline and Phase 12 Policy on the same input. Decision only.
 */
export function compareRecoveryPolicies(
  input: RecoveryPolicyInput,
  caseId = "synthetic",
): RecoveryPolicyCaseComparison {
  const snapshot = createRecoveryPolicyInput(input);
  const baselineDecision = NaiveRecoveryPolicy.decide(snapshot);
  const policyDecision = decideRecoveryPolicy(snapshot);
  const baselineMetrics = computeRecoveryPolicyDecisionMetrics(snapshot, baselineDecision);
  const policyMetrics = computeRecoveryPolicyDecisionMetrics(snapshot, policyDecision);
  const comparison = {
    caseId,
    gapTypes: snapshot.gaps.map((item) => item.type),
    candidateActions: snapshot.candidates.map((item) => item.action),
    baseline: {
      decision: cloneDecision(baselineDecision),
      metrics: baselineMetrics,
    },
    policy: {
      decision: cloneDecision(policyDecision),
      metrics: policyMetrics,
    },
    metricDifference: differenceOf(policyMetrics, baselineMetrics),
  };
  return {
    ...comparison,
    notes: comparisonNotes(comparison),
  };
}

export function evaluatePhase13FocusCases(
  caseIds: readonly string[] = RECOVERY_POLICY_COMPARISON_FOCUS_CASES,
  budget: RecoveryBudget = createRecoveryBudget(),
): RecoveryPolicyCaseComparison[] {
  return FOCUS_CASES.filter((item) => caseIds.includes(item.caseId)).map((item) =>
    compareRecoveryPolicies(buildPhase13PolicyInput(item.caseId, budget), item.caseId),
  );
}

export function buildPhase13ComparisonReport(
  caseIds: readonly string[] = RECOVERY_POLICY_COMPARISON_FOCUS_CASES,
): RecoveryPolicyComparisonReport {
  const cases = evaluatePhase13FocusCases(caseIds);
  const baselineAggregate = aggregateRecoveryPolicyMetrics(cases.map((item) => item.baseline.metrics));
  const policyAggregate = aggregateRecoveryPolicyMetrics(cases.map((item) => item.policy.metrics));
  return {
    version: RECOVERY_POLICY_COMPARISON_VERSION,
    note: RECOVERY_POLICY_COMPARISON_NOTE,
    cases,
    baselineAggregate,
    policyAggregate,
    aggregateDifference: {
      selectedCost: policyAggregate.averageActionCost - baselineAggregate.averageActionCost,
      gapCoverage: policyAggregate.gapCoverage - baselineAggregate.gapCoverage,
      unnecessaryActionRate:
        policyAggregate.unnecessaryActionRate - baselineAggregate.unnecessaryActionRate,
    },
  };
}
