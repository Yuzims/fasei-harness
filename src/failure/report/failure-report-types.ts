/**
 * Phase 14.4 Failure Reporting types.
 *
 * A FailureReport is the stable aggregation + representation artifact over
 * FailureEvent[]: it explains WHY verification failed in report form. It is
 * never diagnosis (categories come from Phase 14.3 events, unchanged) and
 * never action: no next action, no suggested tool, no recovery intent, no
 * retry or execution plan. Future phases consume FailureReport to produce
 * RecoveryIntent; this layer never does.
 */
import type { FailureCategory, FailureSeverity } from "../failure-types.js";

/** "failed": at least one blocking failure. "incomplete": warnings only. */
export type FailureReportStatus = "failed" | "incomplete";

export interface FailureSummary {
  category: FailureCategory;
  severity: FailureSeverity;
  description: string;
  relatedClaimIds?: string[];
  relatedRequirementIds?: string[];
}

export interface FailureReport {
  id: string;
  investigationId: string;
  status: FailureReportStatus;
  failures: FailureSummary[];
  createdAt: string;
}
