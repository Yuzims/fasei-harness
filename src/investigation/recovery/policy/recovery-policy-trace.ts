/**
 * Recovery Policy trace helpers.
 *
 * Records the Decision only. Does not record execution results,
 * tool calls, Evidence IDs, or verifier verdicts.
 */
import type { TraceCollector } from "../../../trace/trace-collector.js";
import { orderedInputGapTypes } from "./recovery-policy.js";
import {
  RECOVERY_POLICY_EVENT_TYPE,
  type RecoveryDecision,
  type RecoveryPolicyDecisionEvent,
  type RecoveryPolicyInput,
} from "./recovery-policy-types.js";

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

export function toRecoveryPolicyDecisionEvent(
  input: RecoveryPolicyInput,
  decision: RecoveryDecision,
): RecoveryPolicyDecisionEvent {
  return {
    gapTypes: orderedInputGapTypes(input.gaps),
    candidateActions: uniqueInOrder(input.candidates.map((item) => item.action)),
    selectedActions: [...decision.selectedActions],
    rejectedActions: [...decision.rejectedActions],
    reason: decision.reason,
  };
}

export function recordRecoveryPolicyDecision(
  trace: TraceCollector,
  runId: string,
  step: number,
  payload: RecoveryPolicyDecisionEvent,
): void {
  trace.record(runId, step, RECOVERY_POLICY_EVENT_TYPE, {
    gapTypes: [...payload.gapTypes],
    candidateActions: [...payload.candidateActions],
    selectedActions: [...payload.selectedActions],
    rejectedActions: [...payload.rejectedActions],
    reason: payload.reason,
  });
}
