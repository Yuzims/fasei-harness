/**
 * Adapter only: ResolutionGap → Recovery Action Candidate.
 *
 * Does not call RecoveryPlanner, applyRecoveryPlan, GitHub, or the LLM.
 * Suggestions are not executed.
 */
import type { RecoveryAction, ResolutionGap } from "../domain/index.js";

export const RESOLUTION_GAP_RECOVERY_AUTO_EXECUTE = false;

export interface ResolutionGapRecoveryCandidate {
  candidateId: string;
  gapType: ResolutionGap["type"];
  severity: ResolutionGap["severity"];
  /** Suggested RecoveryPlanner action. Never applied by this adapter. */
  recoveryAction: RecoveryAction;
  recommendedActions: ResolutionGap["recommendedActions"];
  reason: string;
  evidenceIds: string[];
  /** Always false. Recovery signal is a suggestion, not an execution. */
  autoExecute: false;
}

function recoveryActionFor(gap: ResolutionGap): RecoveryAction {
  if (gap.type === "missing_candidate") {
    return "change_retrieval_strategy";
  }
  return "gather_missing_evidence";
}

export function toRecoveryActionCandidates(gaps: ResolutionGap[]): ResolutionGapRecoveryCandidate[] {
  return gaps.map((gap) => ({
    candidateId: gap.candidateId,
    gapType: gap.type,
    severity: gap.severity,
    recoveryAction: recoveryActionFor(gap),
    recommendedActions: [...gap.recommendedActions],
    reason: gap.explanation,
    evidenceIds: [...gap.evidenceIds],
    autoExecute: RESOLUTION_GAP_RECOVERY_AUTO_EXECUTE,
  }));
}
