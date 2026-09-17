/**
 * Classifies investigation failures from structured state, not error.message matching.
 * Rules are ordered by specificity. The first matching rule is the primary FailureEvent.
 */
import { MAX_STEPS_REACHED } from "../failure/failure-types.js";
import { isRetryableToolCode, type FailureEvent } from "../domain/index.js";
import { agentClaimedResolved, type AnalysisContext } from "./analysis-context.js";
import {
  investigationFingerprint,
  remainingEvidenceSources,
  toolSignature,
  type ToolHistoryEntry,
} from "./state.js";

function event(partial: Omit<FailureEvent, "confidence"> & { confidence?: number }): FailureEvent {
  return { confidence: 0.8, ...partial };
}

function unresolvedToolFailures(history: ToolHistoryEntry[]): ToolHistoryEntry[] {
  return history.filter((entry) => {
    if (entry.success) {
      return false;
    }
    return !history.some(
      (later) =>
        later.success &&
        later.tool === entry.tool &&
        toolSignature(later) === toolSignature(entry),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function detectWrongTarget(ctx: AnalysisContext): FailureEvent | undefined {
  const identity = ctx.verification.checks.find((item) => item.type === "identity");
  if (identity?.status !== "fail") {
    return undefined;
  }
  const expected = {
    repository: `${ctx.task.target.owner}/${ctx.task.target.repository}`,
    issueNumber: ctx.task.target.issueNumber,
  };
  return event({
    type: "wrong_target",
    reason: identity.message,
    evidenceIds: identity.evidenceIds,
    confidence: 0.95,
    details: {
      expected,
      actual: identity.actual,
    },
  });
}

function detectInvalidEvidence(ctx: AnalysisContext): FailureEvent | undefined {
  const malformed = ctx.state.run.evidence.filter((item) => {
    if (!item.provenance?.source || !item.provenance.retrievedAt) {
      return true;
    }
    if (item.provenance.source === "github" && item.provenance.trust === "harness_derived") {
      return true;
    }
    if (item.kind === "issue" || item.kind === "pull_request") {
      const payload = isRecord(item.payload) ? item.payload : {};
      const number = payload.number;
      return typeof number !== "number" || !Number.isInteger(number) || number <= 0;
    }
    return false;
  });
  if (malformed.length > 0) {
    return event({
      type: "invalid_evidence",
      reason: "Evidence is malformed or has invalid provenance (GitHub data cannot become trusted).",
      evidenceIds: malformed.map((item) => item.id),
      confidence: 0.9,
      details: { kind: "malformed_or_provenance" },
    });
  }

  const expectedRepo = `${ctx.task.target.owner}/${ctx.task.target.repository}`;
  const wrongResource = ctx.state.run.evidence.filter((item) => {
    const payload = isRecord(item.payload) ? item.payload : {};
    const repository = typeof payload.repository === "string" ? payload.repository : item.provenance.repository;
    if (item.kind !== "issue") {
      return false;
    }
    const number = payload.number;
    if (typeof number === "number" && number !== ctx.task.target.issueNumber) {
      return false;
    }
    return Boolean(repository && repository !== expectedRepo && repository !== "");
  });
  if (wrongResource.length > 0) {
    return event({
      type: "invalid_evidence",
      reason: "Evidence provenance references a repository that is not the investigation target.",
      evidenceIds: wrongResource.map((item) => item.id),
      details: { kind: "wrong_resource" },
    });
  }

  const coverage = ctx.verification.checks.find(
    (item) => item.type === "claim_coverage" && item.status === "fail",
  );
  if (coverage) {
    return event({
      type: "invalid_evidence",
      reason: coverage.message,
      evidenceIds: coverage.evidenceIds,
      details: { kind: "contradiction" },
    });
  }

  const orphanLinks = ctx.state.run.claimEvidence.filter(
    (link) => !ctx.state.run.evidence.some((item) => item.id === link.evidenceId),
  );
  if (orphanLinks.length > 0) {
    return event({
      type: "invalid_evidence",
      reason: "ClaimEvidence references evidence that is not in this investigation.",
      evidenceIds: orphanLinks.map((link) => link.evidenceId),
      details: { kind: "orphan_link" },
    });
  }

  return undefined;
}

function detectToolFailure(ctx: AnalysisContext): FailureEvent | undefined {
  const failed = unresolvedToolFailures(ctx.state.toolHistory);
  if (failed.length === 0) {
    return undefined;
  }
  const last = failed[failed.length - 1];
  const retryable =
    last?.retryable ??
    isRetryableToolCode(last?.errorCode) ??
    false;
  return event({
    type: "tool_failure",
    reason: last?.error ?? "GitHub tool execution failed.",
    evidenceIds: [],
    confidence: 0.9,
    tool: last?.tool,
    errorCode: last?.errorCode,
    httpStatus: last?.httpStatus,
    retryable,
    details: { failedTools: failed.map((item) => item.tool) },
  });
}

function detectLoopFailure(ctx: AnalysisContext): FailureEvent | undefined {
  const fingerprint = investigationFingerprint(ctx.state);
  const sameState = ctx.previousFingerprints.includes(fingerprint);
  if (sameState && ctx.attempt > 1) {
    return event({
      type: "loop_failure",
      reason: "Investigation state repeated with no meaningful transition.",
      evidenceIds: ctx.state.run.evidence.map((item) => item.id),
      confidence: 0.92,
      details: { fingerprint, detector: "same_state" },
    });
  }

  const history = ctx.state.toolHistory;
  const keys = history.map(toolSignature);
  const n = keys.length;
  if (n >= 4 && keys[n - 1] === keys[n - 3] && keys[n - 2] === keys[n - 4] && keys[n - 1] !== keys[n - 2]) {
    return event({
      type: "loop_failure",
      reason: "Tool actions alternated without state change (A→B→A→B).",
      evidenceIds: [],
      details: { detector: "alternating_actions", keys: keys.slice(-4) },
    });
  }
  if (n >= 3 && keys[n - 1] === keys[n - 2] && keys[n - 2] === keys[n - 3]) {
    const recent = history.slice(-3);
    const noNewEvidence = recent.every(
      (entry) => !entry.success || entry.evidenceIds.length === 0 || entry.cached,
    );
    if (noNewEvidence) {
      return event({
        type: "loop_failure",
        reason: "The same tool and arguments were repeated without new evidence.",
        evidenceIds: [],
        details: { detector: "repeated_action", tool: recent[0]?.tool },
      });
    }
  }

  if (ctx.agentResult?.output === MAX_STEPS_REACHED && ctx.attempt >= ctx.bounds.maxInvestigationAttempts) {
    return event({
      type: "loop_failure",
      reason: "Maximum investigation attempts reached without a state transition that can complete verification.",
      evidenceIds: ctx.state.run.evidence.map((item) => item.id),
      details: { detector: "max_attempts" },
    });
  }

  return undefined;
}

function detectPrematureCompletion(ctx: AnalysisContext): FailureEvent | undefined {
  if (ctx.verification.status !== "insufficient_evidence") {
    return undefined;
  }
  if (!agentClaimedResolved(ctx) && ctx.verification.prematureCompletion !== true) {
    return undefined;
  }
  return event({
    type: "premature_completion",
    reason:
      "Agent claimed the issue was resolved, but the independent verifier found required evidence missing.",
    evidenceIds: ctx.state.run.evidence.map((item) => item.id),
    missingRequirementIds: ctx.verification.missingRequirementIds,
    confidence: 0.9,
    details: {
      missingRequirementIds: ctx.verification.missingRequirementIds,
      unsupportedClaimIds: ctx.verification.unsupportedClaimIds,
    },
  });
}

function detectRetrievalFailure(ctx: AnalysisContext): FailureEvent | undefined {
  const remaining = remainingEvidenceSources(ctx.state);
  if (remaining.length === 0) {
    return undefined;
  }
  const githubSuccess = ctx.state.toolHistory.filter(
    (item) => item.success && item.tool.startsWith("github_"),
  );
  if (githubSuccess.length === 0) {
    return undefined;
  }
  const useful =
    ctx.state.candidatePrs.size > 0 ||
    ctx.state.mergedPrs.size > 0 ||
    ctx.state.evidenceByKind("commit").length > 0 ||
    ctx.state.evidenceByKind("file").length > 0;
  if (useful) {
    return undefined;
  }
  return event({
    type: "retrieval_failure",
    reason:
      "Current retrieval produced no useful resolution evidence; remaining sources exist and should not be the same query replayed.",
    evidenceIds: ctx.state.run.evidence.map((item) => item.id),
    missingRequirementIds: ctx.verification.missingRequirementIds,
    details: { remaining, retrievalStrategy: ctx.state.retrievalStrategy },
  });
}

function detectInsufficientEvidence(ctx: AnalysisContext): FailureEvent | undefined {
  if (ctx.verification.status !== "insufficient_evidence") {
    return undefined;
  }
  return event({
    type: "insufficient_evidence",
    reason: "Required evidence is missing; the harness cannot prove completion.",
    evidenceIds: ctx.state.run.evidence.map((item) => item.id),
    missingRequirementIds: ctx.verification.missingRequirementIds,
    details: { remaining: remainingEvidenceSources(ctx.state) },
  });
}

const RULES: Array<(ctx: AnalysisContext) => FailureEvent | undefined> = [
  detectWrongTarget,
  detectInvalidEvidence,
  detectToolFailure,
  detectLoopFailure,
  detectPrematureCompletion,
  detectRetrievalFailure,
  detectInsufficientEvidence,
];

export class FailureAnalyzer {
  analyze(ctx: AnalysisContext): FailureEvent[] {
    if (ctx.verification.status === "verified_complete") {
      return [];
    }
    const events: FailureEvent[] = [];
    for (const rule of RULES) {
      const found = rule(ctx);
      if (found) {
        events.push(found);
      }
    }
    if (events.length === 0 && ctx.verification.status !== "not_verified") {
      events.push(
        event({
          type: "unknown",
          reason: "Verification did not pass and no specific failure rule matched.",
          evidenceIds: ctx.state.run.evidence.map((item) => item.id),
          confidence: 0.4,
        }),
      );
    }
    return events;
  }

  classify(ctx: AnalysisContext): FailureEvent | undefined {
    return this.analyze(ctx)[0];
  }
}
