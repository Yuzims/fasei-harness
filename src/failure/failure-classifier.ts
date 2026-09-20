/**
 * FailureClassifier: VerificationResult → FailureEvent[].
 *
 * Consumes only the VerificationResult. It does not re-run or reimplement
 * verification, does not inspect the Evidence Graph, ClaimEvidence, GitHub
 * data, or raw investigation state, and never decides recovery.
 *
 * Deterministic mapping from VerificationCheck semantics to failure categories:
 *
 * - VerificationCheck.status "unknown"  → required evidence was not observed.
 * - VerificationCheck.status "fail"     → evidence is sufficient to reject the check.
 *
 * | Check                  | unknown                    | fail               |
 * |------------------------|----------------------------|--------------------|
 * | claims-supported       | unsupported_claim          | contradicted_claim |
 * | evidence-requirements  | missing_evidence (per req) | missing_evidence   |
 * | resolution chain stage | missing_evidence if no evidence was observed for the stage, else resolution_gap | resolution_gap |
 *
 * If verification failed but no check maps to a more specific category, the
 * fallback category is verification_incomplete.
 */
import type { VerificationCheck, VerificationResult } from "../domain/types.js";
import type { TraceCollector } from "../trace/trace-collector.js";
import { createFailureEvent } from "./failure-factory.js";
import type { FailureEvent, FailureSeverity } from "./failure-types.js";
import { FAILURE_LOCALIZED_TRACE_TYPE } from "./failure-types.js";

const CLAIMS_SUPPORTED_CHECK_ID = "claims-supported";
const EVIDENCE_REQUIREMENTS_CHECK_ID = "evidence-requirements";

/** VerificationCheck id → Resolution Chain condition name. */
const RESOLUTION_STAGE_BY_CHECK_ID: Record<string, string> = {
  "issue-identity": "issue_identity",
  "issue-state": "issue_closed",
  "closure-semantics": "eligible_closure",
  "resolution-candidate": "resolution_candidate",
  "pr-merged": "resolution_merged",
  "code-commit": "resolution_code_evidence",
  "resolution-effect": "resolution_effect",
};

export interface FailureClassificationContext {
  /** Investigation run id the failures belong to. */
  investigationId: string;
  step?: number;
  trace?: TraceCollector;
}

function severityOf(check: VerificationCheck): FailureSeverity {
  return check.severity === "optional" || check.severity === "info" ? "warning" : "blocking";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function failedChecks(result: VerificationResult): VerificationCheck[] {
  return result.checks.filter((check) => check.status !== "pass");
}

function classifyCheck(
  check: VerificationCheck,
  result: VerificationResult,
  investigationId: string,
): FailureEvent[] {
  if (check.id === CLAIMS_SUPPORTED_CHECK_ID) {
    if (check.status === "fail") {
      return [
        createFailureEvent({
          investigationId,
          category: "contradicted_claim",
          severity: severityOf(check),
          claimIds: stringArray(check.actual),
          explanation: `Completion-relevant claim support was rejected: ${check.message}`,
        }),
      ];
    }
    return [
      createFailureEvent({
        investigationId,
        category: "unsupported_claim",
        severity: severityOf(check),
        claimIds: result.unsupportedClaimIds,
        explanation: `Completion-relevant claim support is not established: ${check.message}`,
      }),
    ];
  }

  if (check.id === EVIDENCE_REQUIREMENTS_CHECK_ID) {
    const requirementIds =
      stringArray(check.actual).length > 0 ? stringArray(check.actual) : result.missingRequirementIds;
    if (requirementIds.length === 0) {
      return [
        createFailureEvent({
          investigationId,
          category: "missing_evidence",
          severity: severityOf(check),
          explanation: `Required evidence is missing: ${check.message}`,
        }),
      ];
    }
    return requirementIds.map((requirementId) =>
      createFailureEvent({
        investigationId,
        category: "missing_evidence",
        severity: severityOf(check),
        requirementId,
        explanation: `Required evidence for ${requirementId} is missing: ${check.message}`,
      }),
    );
  }

  const resolutionStage = RESOLUTION_STAGE_BY_CHECK_ID[check.id];
  if (resolutionStage) {
    if (check.status === "fail") {
      return [
        createFailureEvent({
          investigationId,
          category: "resolution_gap",
          severity: severityOf(check),
          resolutionStage,
          explanation: `The resolution chain is broken at ${resolutionStage}: ${check.message}`,
        }),
      ];
    }
    if (check.evidenceIds.length > 0) {
      return [
        createFailureEvent({
          investigationId,
          category: "resolution_gap",
          severity: severityOf(check),
          resolutionStage,
          explanation: `The resolution chain is incomplete at ${resolutionStage}: ${check.message}`,
        }),
      ];
    }
    return [
      createFailureEvent({
        investigationId,
        category: "missing_evidence",
        severity: severityOf(check),
        resolutionStage,
        explanation: `Evidence for resolution stage ${resolutionStage} is missing: ${check.message}`,
      }),
    ];
  }

  return [];
}

/**
 * Pure classification: VerificationResult → FailureEvent[]. No trace side effects.
 */
export function classifyVerificationFailures(
  result: VerificationResult,
  investigationId: string,
): FailureEvent[] {
  if (result.status === "verified_complete") {
    return [];
  }
  const events = failedChecks(result).flatMap((check) =>
    classifyCheck(check, result, investigationId),
  );
  if (events.length > 0) {
    return events;
  }
  return [
    createFailureEvent({
      investigationId,
      category: "verification_incomplete",
      severity: "blocking",
      explanation: `Verification ended as ${result.status} without a more specific failing check (${
        failedChecks(result).map((check) => check.id).join(", ") || "no failed checks"
      }).`,
    }),
  ];
}

export class FailureClassifier {
  /**
   * Classify a VerificationResult into FailureEvents and emit one
   * `failure_localized` trace event (reference only) per produced event.
   */
  classify(
    result: VerificationResult,
    context: FailureClassificationContext,
  ): FailureEvent[] {
    const events = classifyVerificationFailures(result, context.investigationId);
    for (const event of events) {
      context.trace?.record(
        context.investigationId,
        context.step ?? 0,
        FAILURE_LOCALIZED_TRACE_TYPE,
        { failureId: event.id },
      );
    }
    return events;
  }
}

export function localizeVerificationFailures(
  result: VerificationResult,
  context: FailureClassificationContext,
): FailureEvent[] {
  return new FailureClassifier().classify(result, context);
}
