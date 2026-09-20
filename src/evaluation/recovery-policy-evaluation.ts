/**
 * Phase 12.0 — Recovery Policy evaluation.
 *
 * Observes constrained action selection: budget compliance, gap coverage,
 * determinism, and invalid-action rejection. This is not completion rate
 * and does not execute recovery.
 */
import type { ResolutionGap } from "../domain/index.js";
import {
  DEFAULT_RECOVERY_ACTION_PROFILES,
  createRecoveryBudget,
  decideRecoveryPolicy,
  deriveRecoveryIntents,
  remainingPolicyBudget,
  selectedEstimatedCost,
  toRecoveryActionCandidatesFromIntents,
  type RecoveryActionCandidate,
  type RecoveryActionProfile,
  type RecoveryBudget,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "../investigation/index.js";

export const RECOVERY_POLICY_EVALUATION_VERSION = "12.0";

export const RECOVERY_POLICY_FOCUS_CASES = ["C07", "C08", "C10"] as const;

export const RECOVERY_POLICY_EVALUATION_NOTE =
  "Phase 12.0 observes Recovery Policy as a constrained decision layer. It is not learning, does not execute recovery, and does not optimize completion rate.";

const PR_CREATING_ACTION = /create_pull_request|github_create_pull_request|mint_pull_request|open_pull_request/i;

const DISTRACTOR_PROFILES: RecoveryActionProfile[] = [
  {
    action: "create_pull_request",
    estimatedCost: 4,
    resolvesGapTypes: [],
  },
];

export interface RecoveryPolicyEvaluationMetrics {
  budgetCompliant: boolean;
  selectedCost: number;
  remainingBudget: number;
  coveredGapTypes: string[];
  requiredGapTypes: string[];
  gapCoverageHold: boolean;
  determinismHold: boolean;
  invalidRejected: boolean;
}

export interface RecoveryPolicyObservation {
  caseId: string;
  gapTypes: ResolutionGap["type"][];
  candidateActions: string[];
  decision: RecoveryDecision;
  metrics: RecoveryPolicyEvaluationMetrics;
  notes: string[];
}

interface PolicyCaseConfig {
  caseId: (typeof RECOVERY_POLICY_FOCUS_CASES)[number];
  gapType: ResolutionGap["type"];
  severity: ResolutionGap["severity"];
  extraActions: string[];
}

const FOCUS_CASES: PolicyCaseConfig[] = [
  {
    caseId: "C07",
    gapType: "missing_patch_evidence",
    severity: "warning",
    extraActions: [],
  },
  {
    caseId: "C08",
    gapType: "insufficient_resolution_context",
    severity: "warning",
    extraActions: ["create_pull_request"],
  },
  {
    caseId: "C10",
    gapType: "missing_candidate",
    severity: "blocking",
    extraActions: ["fetch_commit_patch", "create_pull_request"],
  },
];

function gap(type: ResolutionGap["type"], severity: ResolutionGap["severity"]): ResolutionGap {
  return {
    candidateId: "primary",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-1"],
    explanation: "policy evaluation gap",
    recommendedActions: [],
  };
}

function extraCandidate(action: string): RecoveryActionCandidate {
  return {
    action: action as RecoveryActionCandidate["action"],
    reason: `Evaluation distractor ${action}`,
    intentId: "recovery-policy-evaluation",
    autoExecute: false,
  };
}

export function isPrCreatingAction(action: string): boolean {
  return PR_CREATING_ACTION.test(action);
}

export function buildRecoveryPolicyInput(
  gaps: ResolutionGap[],
  extraActions: string[] = [],
  budget: RecoveryBudget = createRecoveryBudget(),
  actionProfiles: RecoveryActionProfile[] = [...DEFAULT_RECOVERY_ACTION_PROFILES, ...DISTRACTOR_PROFILES],
): RecoveryPolicyInput {
  const intents = deriveRecoveryIntents(gaps);
  const candidates = [
    ...toRecoveryActionCandidatesFromIntents(intents),
    ...extraActions.map(extraCandidate),
  ];
  return {
    gaps,
    intents,
    candidates,
    budget,
    actionProfiles,
  };
}

function unique(values: string[]): string[] {
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

export function evaluateRecoveryPolicyDecision(
  input: RecoveryPolicyInput,
  caseId = "synthetic",
): RecoveryPolicyObservation {
  const first = decideRecoveryPolicy(input);
  const second = decideRecoveryPolicy(input);
  const remainingBudget = remainingPolicyBudget(input.budget);
  const selectedCost = selectedEstimatedCost(first.selectedActions, input.actionProfiles);
  const requiredGapTypes = unique(input.gaps.map((item) => item.type));
  const selectedProfiles = input.actionProfiles.filter((item) => first.selectedActions.includes(item.action));
  const coveredGapTypes = unique(selectedProfiles.flatMap((item) => item.resolvesGapTypes));
  const coverable = requiredGapTypes.filter((type) =>
    input.candidates.some((candidate) => {
      const profile = input.actionProfiles.find((item) => item.action === candidate.action);
      if (!profile) {
        return false;
      }
      if (!Number.isFinite(profile.estimatedCost) || profile.estimatedCost > remainingBudget) {
        return false;
      }
      return profile.resolvesGapTypes.includes(type);
    }),
  );
  const gapCoverageHold = coverable.every((type) => coveredGapTypes.includes(type));
  const invalidRejected = first.selectedActions.every((action) => {
    const profile = input.actionProfiles.find((item) => item.action === action);
    if (!profile) {
      return false;
    }
    return input.gaps.some((item) => profile.resolvesGapTypes.includes(item.type));
  });
  const notes: string[] = [];
  if (selectedCost > remainingBudget) {
    notes.push("Selected estimated cost exceeds remaining budget.");
  }
  if (!gapCoverageHold) {
    notes.push("Selected actions do not cover a coverable required gap.");
  }
  if (!invalidRejected) {
    notes.push("An action that cannot resolve an input gap was selected.");
  }
  return {
    caseId,
    gapTypes: input.gaps.map((item) => item.type),
    candidateActions: unique(input.candidates.map((item) => item.action)),
    decision: {
      selectedActions: [...first.selectedActions],
      rejectedActions: [...first.rejectedActions],
      reason: first.reason,
    },
    metrics: {
      budgetCompliant: selectedCost <= remainingBudget,
      selectedCost,
      remainingBudget,
      coveredGapTypes,
      requiredGapTypes,
      gapCoverageHold,
      determinismHold:
        JSON.stringify(first.selectedActions) === JSON.stringify(second.selectedActions) &&
        JSON.stringify(first.rejectedActions) === JSON.stringify(second.rejectedActions) &&
        first.reason === second.reason,
      invalidRejected,
    },
    notes,
  };
}

export function evaluatePhase12FocusCases(
  caseIds: readonly string[] = RECOVERY_POLICY_FOCUS_CASES,
): RecoveryPolicyObservation[] {
  return FOCUS_CASES.filter((item) => caseIds.includes(item.caseId)).map((item) =>
    evaluateRecoveryPolicyDecision(
      buildRecoveryPolicyInput([gap(item.gapType, item.severity)], item.extraActions),
      item.caseId,
    ),
  );
}
