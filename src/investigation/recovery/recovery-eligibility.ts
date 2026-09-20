/**
 * Phase 15 — Recovery Eligibility boundary.
 *
 * Failure Intelligence may gate whether the existing Controlled Recovery path
 * is allowed to start; it must not become a Recovery planner. This module
 * answers only "may Recovery run?", never "what should Recovery do?".
 * Action selection stays in the existing path:
 * ControlledRecoveryLoop → deriveRecoveryIntents → RecoveryPolicy.
 */
import type { ResolutionGap, VerificationResult } from "../../domain/index.js";
import type { FailureReport } from "../../failure/report/failure-report-types.js";

export type RecoveryEligibilityReason =
  | "verified_complete"
  | "no_failure_report"
  | "no_blocking_resolution_gap"
  | "recovery_allowed";

export interface RecoveryEligibility {
  eligible: boolean;
  reason: RecoveryEligibilityReason;
}

export interface RecoveryEligibilityInput {
  verification: VerificationResult;
  /** Phase 14.4 FailureReport for this run, when one was produced. */
  failureReport?: FailureReport;
  /** ResolutionGaps from the existing analyzer; passed in, never re-derived here. */
  gaps: ResolutionGap[];
}

export function evaluateRecoveryEligibility(
  input: RecoveryEligibilityInput,
): RecoveryEligibility {
  if (input.verification.status === "verified_complete") {
    return { eligible: false, reason: "verified_complete" };
  }
  if (!input.failureReport) {
    return { eligible: false, reason: "no_failure_report" };
  }
  if (!input.gaps.some((gap) => gap.severity === "blocking")) {
    return { eligible: false, reason: "no_blocking_resolution_gap" };
  }
  return { eligible: true, reason: "recovery_allowed" };
}
