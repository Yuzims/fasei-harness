/**
 * Product RecoveryPlanner. Decision layer only.
 * Does not call GitHub, LLM, or mutate Evidence.
 * Harness / investigation loop executes the returned RecoveryPlan.
 *
 * This is the Investigation Recovery path, not src/legacy/recovery.
 */
import {
  isRetryableToolCode,
  type FailureEvent,
  type FailureType,
  type RecoveryPlan,
} from "../domain/index.js";
import { isRuntimeBudgetFailure } from "../agent/llm-runtime.js";
import type { AnalysisContext } from "./analysis-context.js";
import { computeEvidenceGap, missingRequiredGaps } from "./evidence-gap.js";
import { remainingEvidenceSources, type RetrievalStrategy } from "./state.js";

export interface RecoveryContext extends AnalysisContext {
  failure: FailureEvent;
}

function uniqueRequirementIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function knownRequirementIds(ctx: RecoveryContext): Set<string> {
  const ids = new Set(ctx.task.requirements.map((item) => item.id));
  for (const item of computeEvidenceGap(ctx.task, ctx.state.run).items) {
    ids.add(item.requirementId);
  }
  return ids;
}

function onlyKnownRequirementIds(ids: string[] | undefined, known: Set<string>): string[] {
  if (!ids) {
    return [];
  }
  return uniqueRequirementIds(ids.filter((id) => known.has(id)));
}

function optionalRequirementIds(ids: string[]): string[] | undefined {
  return ids.length > 0 ? ids : undefined;
}

/**
 * Verifier missing IDs plus EvidenceGap missing task requirements.
 * Never fabricates IDs and never treats resolution_effect as a retrieval target.
 */
function actionableMissingRequirementIds(failure: FailureEvent, ctx: RecoveryContext): string[] {
  const known = knownRequirementIds(ctx);
  const fromVerifier = onlyKnownRequirementIds(
    failure.missingRequirementIds ?? ctx.verification.missingRequirementIds,
    known,
  );
  if (fromVerifier.length > 0) {
    return fromVerifier;
  }
  const taskIds = new Set(ctx.task.requirements.map((item) => item.id));
  const fromGap = missingRequiredGaps(computeEvidenceGap(ctx.task, ctx.state.run))
    .filter((item) => item.condition !== "resolution_effect")
    .filter((item) => taskIds.has(item.requirementId))
    .map((item) => item.requirementId);
  return onlyKnownRequirementIds(fromGap, known);
}

/**
 * Propagate requirement IDs already identified by the failure or verifier.
 * Does not invent a tool-to-requirement mapping.
 */
function propagatedMissingRequirementIds(failure: FailureEvent, ctx: RecoveryContext): string[] {
  return onlyKnownRequirementIds(
    failure.missingRequirementIds ?? ctx.verification.missingRequirementIds,
    knownRequirementIds(ctx),
  );
}

/**
 * Map invalid evidence onto existing requirements when the association is
 * already present in EvidenceGap, satisfiedBy, or verification checks.
 * Evidence IDs are never used as requirement IDs.
 */
function invalidEvidenceRequirementIds(failure: FailureEvent, ctx: RecoveryContext): string[] {
  const invalid = new Set(failure.evidenceIds);
  if (invalid.size === 0) {
    return [];
  }
  const known = knownRequirementIds(ctx);
  const gap = computeEvidenceGap(ctx.task, ctx.state.run);
  const fromGap = gap.items
    .filter((item) => item.evidenceIds.some((id) => invalid.has(id)))
    .map((item) => item.requirementId);
  const fromSatisfiedBy = ctx.task.requirements
    .filter((item) => (item.satisfiedBy ?? []).some((id) => invalid.has(id)))
    .map((item) => item.id);
  const fromChecks = ctx.verification.checks
    .filter((check) => check.evidenceIds.some((id) => invalid.has(id)))
    .map((check) => check.id);
  return onlyKnownRequirementIds([...fromGap, ...fromSatisfiedBy, ...fromChecks], known);
}

function nextRetrievalStrategy(current: RetrievalStrategy, remaining: string[]): RetrievalStrategy {
  if (remaining.includes("comments") && current !== "comments") {
    return "comments";
  }
  if (remaining.some((item) => item.startsWith("pull/")) && current !== "linked_pr") {
    return "linked_pr";
  }
  if (remaining.includes("timeline") && current !== "timeline") {
    return "timeline";
  }
  return "broaden";
}

function alreadyChose(
  ctx: RecoveryContext,
  action: RecoveryPlan["action"],
): boolean {
  return ctx.previousRecoveries.some((plan) => plan.action === action);
}

function planToolFailure(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const retryable =
    failure.retryable ?? isRetryableToolCode(failure.errorCode) ?? false;
  const nextRequirementIds = optionalRequirementIds(propagatedMissingRequirementIds(failure, ctx));
  if (!retryable) {
    return {
      action: "stop",
      reason: `Tool error ${failure.errorCode ?? failure.httpStatus ?? "non-retryable"} is not recoverable; no blind retry.`,
      nextStep: "Stop. Recheck credentials or the target identity instead of repeating the same tool.",
      maxRetries: ctx.bounds.maxToolRetries,
      nextRequirementIds,
    };
  }
  if (ctx.state.toolRetryCount >= ctx.bounds.maxToolRetries) {
    return {
      action: "stop",
      reason: "Tool retry budget exhausted.",
      nextStep: "Stop. Further retries would loop.",
      maxRetries: ctx.bounds.maxToolRetries,
      nextRequirementIds,
    };
  }
  if (ctx.attempt >= ctx.bounds.maxInvestigationAttempts) {
    return {
      action: "stop",
      reason: "Investigation attempt budget exhausted after retryable tool failure.",
      maxRetries: ctx.bounds.maxToolRetries,
      nextRequirementIds,
    };
  }
  const backoffMs = 10 * 2 ** ctx.state.toolRetryCount;
  return {
    action: "retry_with_backoff",
    reason: "Retryable GitHub tool failure (timeout / 429 / 5xx / network). Bounded backoff, keep existing evidence.",
    resetEvidence: false,
    nextStep: failure.tool
      ? `Retry ${failure.tool} after backoff; do not restart the whole investigation.`
      : "Retry the failed GitHub tool after backoff.",
    maxRetries: ctx.bounds.maxToolRetries,
    backoffMs,
    nextRequirementIds,
  };
}

function planRetrievalFailure(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const remaining = remainingEvidenceSources(ctx.state);
  if (remaining.length === 0) {
    return {
      action: "stop",
      reason: "Retrieval produced no useful evidence and no further sources remain.",
      nextStep: "Stop and keep insufficient_evidence.",
      nextRequirementIds: failure.missingRequirementIds,
    };
  }
  const strategy = nextRetrievalStrategy(ctx.state.retrievalStrategy, remaining);
  const action =
    ctx.state.retrievalStrategy === "default" ? "change_retrieval_strategy" : "refine_query";
  return {
    action,
    reason: "Do not replay the same query. Change retrieval strategy to inspect unused sources.",
    resetEvidence: false,
    nextStep: `Use strategy ${strategy} next. Remaining sources: ${remaining.join(", ")}.`,
    nextRequirementIds: failure.missingRequirementIds,
    retrievalStrategy: strategy,
  };
}

function planPrematureCompletion(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const remaining = remainingEvidenceSources(ctx.state);
  const missing = failure.missingRequirementIds ?? ctx.verification.missingRequirementIds;
  const strategy = nextRetrievalStrategy(ctx.state.retrievalStrategy, remaining);
  return {
    action: "continue_investigation",
    reason:
      "Agent finished early. Continue the same investigation and gather the missing evidence instead of restarting.",
    resetEvidence: false,
    nextRequirementIds: missing,
    nextStep:
      remaining.length > 0
        ? `Gather missing evidence (${[...new Set([...(missing ?? []), ...remaining])].join(", ")}).`
        : "Continue investigation focusing on missing evidence requirements.",
    retrievalStrategy: remaining.length > 0 ? strategy : undefined,
  };
}

function planLoopFailure(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const nextRequirementIds = optionalRequirementIds(actionableMissingRequirementIds(failure, ctx));
  const hasTarget = (nextRequirementIds?.length ?? 0) > 0;
  if (!alreadyChose(ctx, "replan") && ctx.attempt < ctx.bounds.maxInvestigationAttempts) {
    return {
      action: "replan",
      reason: hasTarget
        ? "Same state detected. Replan toward the current missing evidence requirements."
        : "Same state detected. Change strategy once before stopping.",
      resetEvidence: false,
      nextStep: hasTarget
        ? `Replan focusing on missing requirements: ${nextRequirementIds?.join(", ")}. Do not repeat the previous tool sequence.`
        : "Replan: broaden retrieval and do not repeat the previous tool sequence.",
      nextRequirementIds,
      retrievalStrategy: "broaden",
    };
  }
  return {
    action: "stop",
    reason: "Loop detected after a replan; stopping to avoid A→B→A→B recovery.",
    nextStep: "Stop.",
    nextRequirementIds,
  };
}

function planInsufficientEvidence(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const remaining = remainingEvidenceSources(ctx.state);
  if (remaining.length === 0) {
    return {
      action: "stop",
      reason: "Required evidence is missing and no further useful evidence source remains.",
      nextStep: "Stop and keep insufficient_evidence.",
      nextRequirementIds: failure.missingRequirementIds,
    };
  }
  const resolutionSources = remaining.filter(
    (item) => item.startsWith("pull/") || item.startsWith("files/") || item.startsWith("commits/"),
  );
  const strategy =
    resolutionSources.length > 0 ? "linked_pr" : nextRetrievalStrategy(ctx.state.retrievalStrategy, remaining);
  return {
    action: "gather_missing_evidence",
    reason: "Required evidence is missing. Collect only the missing kinds; do not retry the whole investigation.",
    resetEvidence: false,
    nextRequirementIds: failure.missingRequirementIds,
    nextStep:
      resolutionSources.length > 0
        ? `Discover resolution candidates: ${resolutionSources.join(", ")}.`
        : `Gather missing evidence: ${remaining.join(", ")}.`,
    retrievalStrategy: strategy,
  };
}

function planInvalidEvidence(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const discardEvidenceIds = failure.evidenceIds.filter((id) =>
    ctx.state.run.evidence.some((item) => item.id === id),
  );
  const nextRequirementIds = optionalRequirementIds(invalidEvidenceRequirementIds(failure, ctx));
  return {
    action: "revalidate_evidence",
    reason: "Discard invalid evidence and refetch the source. Invalid GitHub text cannot become trusted evidence.",
    resetEvidence: false,
    discardEvidenceIds,
    nextRequirementIds,
    nextStep: nextRequirementIds
      ? `Revalidate: drop invalid items, refetch their source, and gather evidence for ${nextRequirementIds.join(", ")}.`
      : "Revalidate: drop invalid items, refetch their source, never upgrade trust to harness_derived.",
  };
}

function planWrongTarget(failure: FailureEvent): RecoveryPlan {
  return {
    action: "recheck_target",
    reason: "Observed issue identity does not match the task target. Stop accumulating evidence on the wrong issue.",
    resetEvidence: true,
    nextStep: `Recheck target ${failure.details && "expected" in failure.details ? JSON.stringify(failure.details.expected) : "task target"} and restart investigation with the correct issue.`,
  };
}

function planRuntimeBudget(failure: FailureEvent): RecoveryPlan {
  return {
    action: "stop",
    reason:
      failure.reason ||
      "LLM runtime budget exceeded; recovery must not start another LLM call.",
    nextStep: "Stop.",
  };
}

function planUnknown(): RecoveryPlan {
  return {
    action: "stop",
    reason: "Unclassified failure. Stop rather than blindly retry.",
    nextStep: "Stop.",
  };
}

const STRATEGIES: Record<
  FailureType,
  (failure: FailureEvent, ctx: RecoveryContext) => RecoveryPlan
> = {
  tool_failure: planToolFailure,
  retrieval_failure: planRetrievalFailure,
  premature_completion: planPrematureCompletion,
  loop_failure: planLoopFailure,
  insufficient_evidence: planInsufficientEvidence,
  invalid_evidence: planInvalidEvidence,
  wrong_target: (failure) => planWrongTarget(failure),
  runtime_budget_exceeded: (failure) => planRuntimeBudget(failure),
  unknown: () => planUnknown(),
};

export class RecoveryPlanner {
  plan(failure: FailureEvent, ctx: AnalysisContext): RecoveryPlan {
    const recoveryCtx: RecoveryContext = { ...ctx, failure };
    if (isRuntimeBudgetFailure(failure)) {
      return planRuntimeBudget(failure);
    }
    if (ctx.attempt >= ctx.bounds.maxInvestigationAttempts) {
      const specialized = STRATEGIES[failure.type](failure, recoveryCtx);
      if (specialized.action !== "stop" && failure.type !== "wrong_target") {
        return {
          ...specialized,
          action: "stop",
          reason: `${specialized.reason} Attempt budget reached; stopping.`,
          nextStep: "Stop.",
        };
      }
    }
    if (ctx.state.recoveryCount >= ctx.bounds.maxRecoveryAttempts) {
      return {
        action: "stop",
        reason: "Recovery attempt budget exhausted.",
        nextStep: "Stop.",
      };
    }
    const planned = STRATEGIES[failure.type](failure, recoveryCtx);
    if (failure.type === "wrong_target" || planned.action === "recheck_target") {
      return { ...planned, nextRequirementIds: undefined };
    }
    return planned;
  }
}
