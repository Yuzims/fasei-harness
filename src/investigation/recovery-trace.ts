/**
 * Closed-loop recovery trace helpers.
 * Trace is the first-class proof that recovery changed the next attempt.
 */
import type { InvestigationAttempt, InvestigationStrategy } from "../domain/index.js";
import type { TraceEvent } from "../trace/trace-collector.js";

export const CLOSED_LOOP_TRACE_TYPES = [
  "investigation_attempt_started",
  "tool_call",
  "tool_result",
  "verification_completed",
  "failure_detected",
  "failure_analyzed",
  "recovery_planned",
  "recovery_applied",
] as const;

export type ClosedLoopTraceType = (typeof CLOSED_LOOP_TRACE_TYPES)[number];

export interface CanonicalRecoveryEvent {
  type: ClosedLoopTraceType;
  attempt?: number;
  action?: string;
  strategy?: string;
  tool?: string;
  success?: boolean;
  verificationStatus?: string;
  failureType?: string;
}

export function canonicalRecoveryTrace(events: readonly TraceEvent[]): CanonicalRecoveryEvent[] {
  const allowed = new Set<string>(CLOSED_LOOP_TRACE_TYPES);
  const canonical: CanonicalRecoveryEvent[] = [];
  for (const event of events) {
    if (!allowed.has(event.type)) {
      continue;
    }
    const strategy = event.data.strategy as InvestigationStrategy | undefined;
    canonical.push({
      type: event.type as ClosedLoopTraceType,
      attempt: typeof event.data.attempt === "number" ? event.data.attempt : undefined,
      action: typeof event.data.action === "string" ? event.data.action : undefined,
      strategy: strategy?.type,
      tool: typeof event.data.tool === "string" ? event.data.tool : undefined,
      success: typeof event.data.success === "boolean" ? event.data.success : undefined,
      verificationStatus:
        typeof event.data.status === "string"
          ? event.data.status
          : typeof event.data.verificationStatus === "string"
            ? event.data.verificationStatus
            : undefined,
      failureType:
        typeof event.data.primary === "string"
          ? event.data.primary
          : typeof event.data.failureType === "string"
            ? event.data.failureType
            : undefined,
    });
  }
  return canonical;
}

export function attemptToolNames(
  events: readonly TraceEvent[],
  attempt: number,
): string[] {
  return events
    .filter(
      (event) => event.type === "tool_call" && event.data.attempt === attempt,
    )
    .map((event) => String(event.data.tool ?? ""));
}

export function attemptProvenance(attempt: InvestigationAttempt): {
  attemptId: string;
  parentAttemptId?: string;
  recoveryPlanId?: string;
  failureEventId?: string;
  strategyType?: string;
} {
  return {
    attemptId: attempt.id,
    parentAttemptId: attempt.parentAttemptId,
    recoveryPlanId: attempt.recoveryPlanId,
    failureEventId: attempt.failureEventId,
    strategyType: attempt.strategy?.type,
  };
}
