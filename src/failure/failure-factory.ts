/**
 * FailureEvent construction. The factory is the only place a Phase 14.3
 * FailureEvent is shaped, so the diagnostic-only contract (source is always
 * "verification"; no action-bearing fields) holds by construction.
 */
import { randomUUID } from "node:crypto";
import type {
  FailureCategory,
  FailureEvent,
  FailureLocalizedTracePayload,
  FailureSeverity,
} from "./failure-types.js";
import { FAILURE_LOCALIZED_TRACE_TYPE } from "./failure-types.js";

export interface FailureEventInput {
  investigationId: string;
  category: FailureCategory;
  severity: FailureSeverity;
  explanation: string;
  requirementId?: string;
  claimIds?: string[];
  resolutionStage?: string;
  id?: string;
}

export function createFailureEvent(input: FailureEventInput): FailureEvent {
  const event: FailureEvent = {
    id: input.id ?? `failure-${randomUUID()}`,
    investigationId: input.investigationId,
    category: input.category,
    source: "verification",
    severity: input.severity,
    explanation: input.explanation,
  };
  if (input.requirementId !== undefined) {
    event.requirementId = input.requirementId;
  }
  if (input.claimIds && input.claimIds.length > 0) {
    event.claimIds = [...input.claimIds];
  }
  if (input.resolutionStage !== undefined) {
    event.resolutionStage = input.resolutionStage;
  }
  return event;
}

/** Reference-only trace payload for a localized failure. */
export function toFailureLocalizedTrace(event: FailureEvent): FailureLocalizedTracePayload {
  return { type: FAILURE_LOCALIZED_TRACE_TYPE, failureId: event.id };
}
