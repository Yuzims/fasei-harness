/**
 * Recovery Action selection for the controlled loop.
 *
 * Only blocking intents auto-trigger execution. Warning intents are recorded.
 */
import type { ResolutionGap } from "../../domain/index.js";
import type { RecoveryIntent } from "./recovery-intent.js";
import {
  toRecoveryActionCandidatesFromIntents,
  type RecoveryActionCandidate,
} from "./resolution-recovery-adapter.js";
import { remainingRecoveryActions, type RecoveryBudget, type RecoveryBudgetUsage } from "./recovery-budget.js";

export function blockingResolutionGaps(gaps: ResolutionGap[]): ResolutionGap[] {
  return gaps.filter((item) => item.severity === "blocking");
}

export function warningResolutionGaps(gaps: ResolutionGap[]): ResolutionGap[] {
  return gaps.filter((item) => item.severity === "warning");
}

export function blockingRecoveryIntents(intents: RecoveryIntent[]): RecoveryIntent[] {
  return intents.filter((item) => item.priority === "blocking");
}

export function selectRecoveryActionCandidates(
  intents: RecoveryIntent[],
  budget: RecoveryBudget,
  usage: RecoveryBudgetUsage,
): RecoveryActionCandidate[] {
  const executable = blockingRecoveryIntents(intents);
  const remaining = remainingRecoveryActions(budget, usage);
  if (remaining <= 0) {
    return [];
  }
  return toRecoveryActionCandidatesFromIntents(executable).slice(0, remaining);
}
