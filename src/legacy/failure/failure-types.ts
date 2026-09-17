/**
 * Legacy workspace failure injection types.
 *
 * Legacy Failure Injection ≠ Investigation Recovery
 *
 * Product domain types live in src/domain/types.ts (FailureType, FailureEvent, RecoveryPlan).
 */
export type FailureType =
  | "tool_failure"
  | "retrieval_failure"
  | "premature_completion"
  | "loop_failure"
  | "unknown";

export interface Failure {
  type: FailureType;
  rootCause: string;
  evidence: unknown[];
}
