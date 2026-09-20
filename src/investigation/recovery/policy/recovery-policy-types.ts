/**
 * Phase 12.0 Recovery Policy domain model.
 *
 * Policy reads Recovery Intent + Action Candidates and emits a Decision.
 * estimatedCost is a policy input, not a runtime execution cost.
 */
import type { ResolutionGap } from "../../../domain/index.js";
import type { RecoveryActionCandidate } from "../resolution-recovery-adapter.js";
import type { RecoveryBudget } from "../recovery-budget.js";
import type { RecoveryIntent } from "../recovery-intent.js";

export interface RecoveryActionProfile {
  action: string;
  /** Policy input cost. Not the runtime actual cost. */
  estimatedCost: number;
  resolvesGapTypes: string[];
}

export interface RecoveryDecision {
  selectedActions: string[];
  rejectedActions: string[];
  reason: string;
}

/**
 * Policy input only. The decision layer does not call tools, create
 * Evidence, mutate the verifier, or execute recovery.
 */
export interface RecoveryPolicyInput {
  gaps: ResolutionGap[];
  intents: RecoveryIntent[];
  candidates: RecoveryActionCandidate[];
  budget: RecoveryBudget;
  actionProfiles: RecoveryActionProfile[];
}

export type RecoveryPolicyRejectCause =
  | "no_profile"
  | "no_gap_coverage"
  | "over_budget"
  | "redundant";

export interface RecoveryPolicyDecisionEvent {
  gapTypes: string[];
  candidateActions: string[];
  selectedActions: string[];
  rejectedActions: string[];
  reason: string;
}

export const RECOVERY_POLICY_NOTICE =
  "Phase 12.0 Recovery Policy is a constrained decision layer. It is not learning and does not execute recovery.";

export const RECOVERY_POLICY_EVENT_TYPE = "recovery_policy_decision" as const;
