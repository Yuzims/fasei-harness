/**
 * Phase 13.0 — Naive baseline Recovery Policy.
 *
 * Selects the first legal candidate. Does not rank by cost, gap coverage,
 * or severity. Decision only: this module does not execute recovery.
 */
import {
  createRecoveryDecision,
  createRecoveryPolicyInput,
  type RecoveryActionCandidate,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "../investigation/index.js";

export const NAIVE_RECOVERY_POLICY_NAME = "naive_first_action";

export const NAIVE_RECOVERY_POLICY_NOTE =
  "Naive first-action policy selects the first legal candidate. It does not consider estimated cost, gap severity, or gap coverage, and it does not execute recovery.";

function uniqueInOrder(values: string[]): string[] {
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

function isLegalCandidate(candidate: RecoveryActionCandidate): boolean {
  return typeof candidate.action === "string" && candidate.action.trim().length > 0;
}

/**
 * First legal candidate in list order. No sorting. No cost. No coverage.
 */
export function decideNaiveRecoveryPolicy(input: RecoveryPolicyInput): RecoveryDecision {
  const snapshot = createRecoveryPolicyInput(input);
  const first = snapshot.candidates.find(isLegalCandidate);
  const selectedActions = first ? [first.action] : [];
  const selected = new Set<string>(selectedActions);
  const rejectedActions = uniqueInOrder(snapshot.candidates.map((item) => item.action)).filter(
    (action) => !selected.has(action),
  );
  const reason =
    selectedActions.length === 0
      ? "Naive first-action policy selected none."
      : `Naive first-action policy selected ${selectedActions[0]}.`;
  return createRecoveryDecision({
    selectedActions,
    rejectedActions,
    reason,
  });
}

export const NaiveRecoveryPolicy = {
  name: NAIVE_RECOVERY_POLICY_NAME,
  decide: decideNaiveRecoveryPolicy,
} as const;
