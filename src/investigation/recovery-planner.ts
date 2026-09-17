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
import type { AnalysisContext } from "./analysis-context.js";
import { remainingEvidenceSources, type RetrievalStrategy } from "./state.js";

export interface RecoveryContext extends AnalysisContext {
  failure: FailureEvent;
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
  if (!retryable) {
    return {
      action: "stop",
      reason: `Tool error ${failure.errorCode ?? failure.httpStatus ?? "non-retryable"} is not recoverable; no blind retry.`,
      nextStep: "Stop. Recheck credentials or the target identity instead of repeating the same tool.",
      maxRetries: ctx.bounds.maxToolRetries,
    };
  }
  if (ctx.state.toolRetryCount >= ctx.bounds.maxToolRetries) {
    return {
      action: "stop",
      reason: "Tool retry budget exhausted.",
      nextStep: "Stop. Further retries would loop.",
      maxRetries: ctx.bounds.maxToolRetries,
    };
  }
  if (ctx.attempt >= ctx.bounds.maxInvestigationAttempts) {
    return {
      action: "stop",
      reason: "Investigation attempt budget exhausted after retryable tool failure.",
      maxRetries: ctx.bounds.maxToolRetries,
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
  };
}

function planLoopFailure(_failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  if (!alreadyChose(ctx, "replan") && ctx.attempt < ctx.bounds.maxInvestigationAttempts) {
    return {
      action: "replan",
      reason: "Same state detected. Change strategy once before stopping.",
      resetEvidence: false,
      nextStep: "Replan: broaden retrieval and do not repeat the previous tool sequence.",
      retrievalStrategy: "broaden",
    };
  }
  return {
    action: "stop",
    reason: "Loop detected after a replan; stopping to avoid A→B→A→B recovery.",
    nextStep: "Stop.",
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
  return {
    action: "gather_missing_evidence",
    reason: "Required evidence is missing. Collect only the missing kinds; do not retry the whole investigation.",
    resetEvidence: false,
    nextRequirementIds: failure.missingRequirementIds,
    nextStep: `Gather missing evidence: ${remaining.join(", ")}.`,
  };
}

function planInvalidEvidence(failure: FailureEvent, ctx: RecoveryContext): RecoveryPlan {
  const discardEvidenceIds = failure.evidenceIds.filter((id) =>
    ctx.state.run.evidence.some((item) => item.id === id),
  );
  return {
    action: "revalidate_evidence",
    reason: "Discard invalid evidence and refetch the source. Invalid GitHub text cannot become trusted evidence.",
    resetEvidence: false,
    discardEvidenceIds,
    nextStep: "Revalidate: drop invalid items, refetch their source, never upgrade trust to harness_derived.",
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
  unknown: () => planUnknown(),
};

export class RecoveryPlanner {
  plan(failure: FailureEvent, ctx: AnalysisContext): RecoveryPlan {
    const recoveryCtx: RecoveryContext = { ...ctx, failure };
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
    return planned;
  }
}
