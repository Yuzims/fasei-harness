/**
 * Shared Recovery Intent types.
 *
 * Intent names a missing capability. It is not a tool name, API call,
 * or execution result.
 */
import type { ResolutionGapRecommendedAction, ResolutionGapType } from "../../domain/index.js";

export type RecoveryIntentObjective =
  | "collect_resolution_evidence"
  | "collect_validation_evidence"
  | "expand_candidate_discovery"
  | "improve_issue_change_alignment";

export type RecoveryIntentPriority = "blocking" | "warning";

export interface RecoveryIntentConstraints {
  maxActions: number;
  maxCost?: number;
}

/** Candidate action names are capability requests, not GitHub tool names. */
export type RecoveryCandidateAction = ResolutionGapRecommendedAction;

/**
 * Decision-only trace payload for Failure → Gap → Intent.
 * Must not include execution results, tool calls, or API calls.
 */
export interface RecoveryIntentEvent {
  failureId: string;
  gapTypes: string[];
  intent: string;
}

export const RECOVERY_INTENT_OBJECTIVES: readonly RecoveryIntentObjective[] = [
  "collect_resolution_evidence",
  "collect_validation_evidence",
  "expand_candidate_discovery",
  "improve_issue_change_alignment",
];

export const RESOLUTION_GAP_TYPE_ORDER: readonly ResolutionGapType[] = [
  "missing_patch_evidence",
  "missing_file_evidence",
  "insufficient_resolution_context",
  "missing_validation_evidence",
  "missing_candidate",
  "weak_issue_change_alignment",
];
