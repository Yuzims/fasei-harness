/**
 * FailureReportBuilder: FailureEvent[] → FailureReport.
 *
 * Aggregation + representation only. The builder consumes FailureEvent fields
 * verbatim — event.category is copied to summary.category, never re-derived —
 * and performs no inspection of EvidenceGraph, ClaimEvidence, GitHub data, or
 * raw investigation state. It emits no trace events and carries no recovery
 * semantics: everything here answers "why did verification fail", never
 * "what should happen next".
 */
import { randomUUID } from "node:crypto";
import type { FailureEvent } from "../failure-types.js";
import type { FailureReport, FailureReportStatus, FailureSummary } from "./failure-report-types.js";

export interface FailureReportInput {
  /** Injectable for deterministic tests; a UUID is generated otherwise. */
  id?: string;
  /** Injectable for deterministic tests; the current time is used otherwise. */
  createdAt?: string;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function collectClaimIds(events: readonly FailureEvent[]): string[] {
  return dedupe(events.flatMap((event) => event.claimIds ?? []));
}

function collectRequirementIds(events: readonly FailureEvent[]): string[] {
  return dedupe(
    events
      .map((event) => event.requirementId)
      .filter((requirementId): requirementId is string => requirementId !== undefined),
  );
}

function aggregateGroup(events: readonly FailureEvent[]): FailureSummary {
  const first = events[0] as FailureEvent;
  const summary: FailureSummary = {
    category: first.category,
    severity: events.some((event) => event.severity === "blocking") ? "blocking" : "warning",
    description: events.map((event) => event.explanation).join(" "),
  };
  const claimIds = collectClaimIds(events);
  if (claimIds.length > 0) {
    summary.relatedClaimIds = claimIds;
  }
  const requirementIds = collectRequirementIds(events);
  if (requirementIds.length > 0) {
    summary.relatedRequirementIds = requirementIds;
  }
  return summary;
}

export class FailureReportBuilder {
  /**
   * Returns undefined for an empty event list: no failures, no report.
   * Events are grouped by category in first-seen order; references from all
   * events in a group are merged and deduplicated.
   */
  build(
    events: readonly FailureEvent[],
    input: FailureReportInput = {},
  ): FailureReport | undefined {
    if (events.length === 0) {
      return undefined;
    }
    const investigationId = (events[0] as FailureEvent).investigationId;
    for (const event of events) {
      if (event.investigationId !== investigationId) {
        throw new Error(
          `FailureReport events must share one investigationId, got ${investigationId} and ${event.investigationId}`,
        );
      }
    }

    const groups = new Map<FailureEvent["category"], FailureEvent[]>();
    for (const event of events) {
      const group = groups.get(event.category);
      if (group) {
        group.push(event);
      } else {
        groups.set(event.category, [event]);
      }
    }

    const failures = [...groups.values()].map(aggregateGroup);
    const status: FailureReportStatus = failures.some(
      (failure) => failure.severity === "blocking",
    )
      ? "failed"
      : "incomplete";

    return {
      id: input.id ?? `failure-report-${randomUUID()}`,
      investigationId,
      status,
      failures,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }
}
