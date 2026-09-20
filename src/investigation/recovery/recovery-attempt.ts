/**
 * Recovery Attempt domain model.
 *
 * A RecoveryAttempt is a controlled re-investigation linked to an existing
 * InvestigationAttempt. It never replaces that parent attempt.
 */
export type RecoveryAttemptStatus = "planned" | "running" | "completed" | "failed";

export type RecoveryAttemptOutcome = "improved" | "unchanged" | "failed";

export interface RecoveryAttempt {
  id: string;
  parentAttemptId: string;
  triggerGapIds: string[];
  recoveryIntentIds: string[];
  selectedActions: string[];
  status: RecoveryAttemptStatus;
  outcome?: RecoveryAttemptOutcome;
}

export function recoveryAttemptId(parentAttemptId: string, round: number): string {
  return `recovery-attempt:${parentAttemptId}:${round}`;
}

export function resolutionGapId(candidateId: string, type: string): string {
  return `gap:${candidateId}:${type}`;
}

export function createRecoveryAttempt(input: {
  id?: string;
  parentAttemptId: string;
  triggerGapIds: string[];
  recoveryIntentIds: string[];
  selectedActions: string[];
  status: RecoveryAttemptStatus;
  outcome?: RecoveryAttemptOutcome;
}): RecoveryAttempt {
  const attempt: RecoveryAttempt = {
    id: input.id?.trim() || recoveryAttemptId(input.parentAttemptId, 1),
    parentAttemptId: input.parentAttemptId,
    triggerGapIds: [...input.triggerGapIds],
    recoveryIntentIds: [...input.recoveryIntentIds],
    selectedActions: [...input.selectedActions],
    status: input.status,
  };
  if (input.outcome) {
    attempt.outcome = input.outcome;
  }
  return attempt;
}
