/**
 * Phase 14.3 Failure Localization types.
 *
 * A FailureEvent explains WHY a VerificationResult failed. It is diagnosis,
 * never action: no recovery intent, no next action, no tool, no retry plan,
 * no execution plan. Recovery layers consume these events; this layer never
 * decides what to do about them.
 */

export type FailureCategory =
  | "missing_evidence"
  | "unsupported_claim"
  | "contradicted_claim"
  | "resolution_gap"
  | "verification_incomplete";

/** Phase 14.3 localizes verification failures only. Runtime failures come later. */
export type FailureSource = "verification";

export type FailureSeverity = "blocking" | "warning";

export interface FailureEvent {
  id: string;
  investigationId: string;
  category: FailureCategory;
  source: FailureSource;
  /** EvidenceRequirement id named by the failed verification, when applicable. */
  requirementId?: string;
  /** Claim ids implicated by the failed verification, when applicable. */
  claimIds?: string[];
  /** Resolution Chain condition name, e.g. "resolution_code_evidence". */
  resolutionStage?: string;
  severity: FailureSeverity;
  explanation: string;
}

export const FAILURE_LOCALIZED_TRACE_TYPE = "failure_localized" as const;

/**
 * Trace payload for a localized failure. References only — trace is execution
 * history, not diagnostic storage. The FailureEvent itself is not embedded.
 */
export interface FailureLocalizedTracePayload {
  type: typeof FAILURE_LOCALIZED_TRACE_TYPE;
  failureId: string;
}
