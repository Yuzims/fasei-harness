/**
 * Recovery Intent trace helpers.
 *
 * Records Failure → Gap → Intent decisions only.
 * Does not record execution results, tool calls, or API calls.
 */
import type { TraceCollector } from "../../trace/trace-collector.js";
import type { RecoveryIntent } from "./recovery-intent.js";
import type { RecoveryIntentEvent } from "./recovery-types.js";

export function toRecoveryIntentEvents(
  failureId: string,
  intents: RecoveryIntent[],
): RecoveryIntentEvent[] {
  return intents.map((intent) => ({
    failureId,
    gapTypes: [...intent.triggerGapTypes],
    intent: intent.objective,
  }));
}

export function recordRecoveryIntentDecisions(
  trace: TraceCollector,
  runId: string,
  step: number,
  events: RecoveryIntentEvent[],
): void {
  for (const event of events) {
    trace.record(runId, step, "recovery_intent", {
      failureId: event.failureId,
      gapTypes: [...event.gapTypes],
      intent: event.intent,
    });
  }
}
