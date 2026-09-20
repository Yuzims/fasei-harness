/**
 * Phase 11.1 Recovery Execution trace helpers.
 *
 * Records RecoveryAttempt start and execution completion.
 * Does not record verifier verdicts or completion.
 */
import type { TraceCollector } from "../../trace/trace-collector.js";
import type { RecoveryAttempt } from "./recovery-attempt.js";
import type { RecoveryExecutionResult } from "./recovery-executor.js";

export interface RecoveryAttemptStartedEvent {
  parentAttemptId: string;
  recoveryIntentIds: string[];
  actions: string[];
}

export interface RecoveryExecutionCompletedEvent {
  recoveryAttemptId: string;
  addedEvidenceIds: string[];
  status: RecoveryExecutionResult["status"];
}

export function recordRecoveryAttemptStarted(
  trace: TraceCollector,
  runId: string,
  step: number,
  payload: RecoveryAttemptStartedEvent,
): void {
  trace.record(runId, step, "recovery_attempt_started", {
    parentAttemptId: payload.parentAttemptId,
    recoveryIntentIds: [...payload.recoveryIntentIds],
    actions: [...payload.actions],
  });
}

export function recordRecoveryExecutionCompleted(
  trace: TraceCollector,
  runId: string,
  step: number,
  payload: RecoveryExecutionCompletedEvent,
): void {
  trace.record(runId, step, "recovery_execution_completed", {
    recoveryAttemptId: payload.recoveryAttemptId,
    addedEvidenceIds: [...payload.addedEvidenceIds],
    status: payload.status,
  });
}

export function recoveryAttemptStartedPayload(attempt: RecoveryAttempt): RecoveryAttemptStartedEvent {
  return {
    parentAttemptId: attempt.parentAttemptId,
    recoveryIntentIds: [...attempt.recoveryIntentIds],
    actions: [...attempt.selectedActions],
  };
}
