import { randomUUID } from "node:crypto";

export type TraceEventType =
  | "run_started"
  | "attempt_started"
  | "model_call"
  | "model_call_completed"
  | "tool_call"
  | "tool_result"
  | "run_completed"
  | "verification"
  /** Legacy workspace harness only. Investigation uses failure_detected / failure_analyzed. */
  | "failure"
  /** Legacy workspace harness only. Investigation uses recovery_planned / started / completed. */
  | "recovery"
  | "investigation_started"
  | "agent_step"
  | "evidence_added"
  | "claim_created"
  /** Phase 14.1 capture boundary. Identity only; not a verification judgement. */
  | "claim_recorded"
  /** Phase 14.1 capture boundary. Agent claims dropped for unknown Evidence IDs. */
  | "claims_dropped_at_capture"
  /** Phase 14.1 capture boundary. Capture failed; verification still runs. */
  | "claim_capture_failed"
  | "investigation_completed"
  | "verification_started"
  | "verification_check"
  | "verification_completed"
  /** Product investigation trace. Not emitted by the workspace Harness. */
  | "failure_detected"
  | "failure_analyzed"
  | "recovery_planned"
  | "recovery_started"
  | "recovery_applied"
  | "recovery_completed"
  | "investigation_attempt_started"
  | "illegal_investigation_action_rejected"
  | "investigation_blocked"
  | "retrieval_discovery_started"
  | "retrieval_candidate_discovered"
  | "retrieval_candidate_ranked"
  | "retrieval_candidate_selected"
  | "retrieval_candidate_rejected"
  | "retrieval_investigation_started";

export interface TraceEvent {
  id: string;
  runId: string;
  step: number;
  timestamp: number;
  type: TraceEventType;
  data: Record<string, unknown>;
}

export class TraceCollector {
  private events: TraceEvent[] = [];
  private listeners: Array<(event: TraceEvent) => void> = [];

  on(listener: (event: TraceEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  record(
    runId: string,
    step: number,
    type: TraceEventType,
    data: Record<string, unknown>,
  ): void {
    const event: TraceEvent = {
      id: randomUUID(),
      runId,
      step,
      timestamp: Date.now(),
      type,
      data,
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getEvents(): TraceEvent[] {
    return [...this.events];
  }
}
