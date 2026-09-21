/**
 * Phase 11.1 — Controlled Recovery Execution Loop.
 *
 * Recovery is a new InvestigationAttempt. It does not overwrite the parent
 * attempt, set success, or modify IndependentCompletionVerifier internals.
 * Results still pass Evidence → Verifier.
 */
import { appendAttempt, graphFromRun, type InvestigationRun, type InvestigationStrategy, type InvestigationTask, type ResolutionGap, type VerificationResult } from "../domain/index.js";
import { IndependentCompletionVerifier } from "../verification/independent-completion-verifier.js";
import type { TraceCollector } from "../trace/trace-collector.js";
import { analyzeResolutionGapsForRun } from "./resolution-gap-analyzer.js";
import { buildResolutionAnalyses } from "./resolution-analysis.js";
import {
  blockingRecoveryIntents,
  canStartRecoveryRound,
  createRecoveryAttempt,
  createRecoveryBudget,
  deriveRecoveryIntents,
  recordRecoveryAttemptStarted,
  recordRecoveryExecutionCompleted,
  recordRecoveryIntentDecisions,
  recoveryAttemptId,
  remainingRecoveryActions,
  resolutionGapId,
  selectRecoveryActionCandidates,
  toRecoveryActionCandidatesFromIntents,
  toRecoveryIntentEvents,
  type RecoveryActionCandidate,
  type RecoveryAttempt,
  type RecoveryAttemptOutcome,
  type RecoveryBudget,
  type RecoveryBudgetUsage,
  type RecoveryExecutor,
  type RecoveryIntent,
} from "./recovery/index.js";

export const CONTROLLED_RECOVERY_NOTICE =
  "Controlled recovery is a budgeted re-investigation. It only adds Evidence. IndependentCompletionVerifier remains the only completion authority.";

const RECOVERY_STRATEGY: InvestigationStrategy = {
  type: "gather_resolution_evidence",
  reason: "Controlled recovery re-investigation driven by a blocking resolution gap.",
};

export interface ControlledRecoveryLoopInput {
  task: InvestigationTask;
  run: InvestigationRun;
  parentAttemptId: string;
  budget: RecoveryBudget;
  usage: RecoveryBudgetUsage;
  executor: RecoveryExecutor;
  trace: TraceCollector;
  verifier: IndependentCompletionVerifier;
  runId: string;
  step: number;
  /**
   * Runtime default is blocking-only auto-trigger.
   * Evaluation may pass false to measure a warning gap such as C07 missing_patch_evidence.
   */
  requireBlocking?: boolean;
  intents?: RecoveryIntent[];
  gaps?: ResolutionGap[];
}

export type ControlledRecoverySkipReason =
  | "no_blocking_gap"
  | "budget_exhausted"
  | "no_candidate"
  | "no_parent_attempt";

export interface ControlledRecoveryLoopResult {
  executed: boolean;
  skippedReason?: ControlledRecoverySkipReason;
  recoveryAttempt?: RecoveryAttempt;
  addedEvidenceIds: string[];
  gapsBefore: ResolutionGap[];
  gapsAfter: ResolutionGap[];
  /** Produced by IndependentCompletionVerifier after Evidence was added. Not by the executor. */
  verification?: VerificationResult;
  parentAttemptId: string;
}

function knownAddedEvidenceIds(run: InvestigationRun, ids: string[]): string[] {
  const known = new Set(run.evidence.map((item) => item.id));
  const seen = new Set<string>();
  const added: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id) || !known.has(id)) {
      continue;
    }
    seen.add(id);
    added.push(id);
  }
  return added;
}

function gapKey(gap: ResolutionGap): string {
  return `${gap.candidateId}:${gap.type}`;
}

function recoveryOutcome(
  executionStatus: "completed" | "failed",
  gapsBefore: ResolutionGap[],
  gapsAfter: ResolutionGap[],
  addedEvidenceIds: string[],
): RecoveryAttemptOutcome {
  if (executionStatus === "failed" && addedEvidenceIds.length === 0) {
    return "failed";
  }
  const beforeKeys = new Set(gapsBefore.map(gapKey));
  const afterKeys = new Set(gapsAfter.map(gapKey));
  const reduced = [...beforeKeys].some((key) => !afterKeys.has(key)) || afterKeys.size < beforeKeys.size;
  if (reduced || addedEvidenceIds.length > 0) {
    return reduced ? "improved" : "unchanged";
  }
  return "unchanged";
}

function executableIntents(input: {
  intents: RecoveryIntent[];
  requireBlocking: boolean;
}): RecoveryIntent[] {
  if (input.requireBlocking) {
    return blockingRecoveryIntents(input.intents);
  }
  return input.intents;
}

function selectActionsForIntents(
  intents: RecoveryIntent[],
  budget: RecoveryBudget,
  usage: RecoveryBudgetUsage,
  requireBlocking: boolean,
): RecoveryActionCandidate[] {
  if (requireBlocking) {
    return selectRecoveryActionCandidates(intents, budget, usage);
  }
  const remaining = remainingRecoveryActions(budget, usage);
  if (remaining <= 0) {
    return [];
  }
  return toRecoveryActionCandidatesFromIntents(intents).slice(0, remaining);
}

export function analyzeGapsForRecovery(run: InvestigationRun): ResolutionGap[] {
  return analyzeResolutionGapsForRun(run, graphFromRun(run));
}

export async function runControlledRecoveryLoop(
  input: ControlledRecoveryLoopInput,
): Promise<ControlledRecoveryLoopResult> {
  const requireBlocking = input.requireBlocking !== false;
  const budget = createRecoveryBudget(input.budget);
  const parent = input.run.attempts.find((item) => item.id === input.parentAttemptId);
  const gapsBefore = input.gaps ?? analyzeGapsForRecovery(input.run);
  const intents = input.intents ?? deriveRecoveryIntents(gapsBefore);
  const empty: ControlledRecoveryLoopResult = {
    executed: false,
    addedEvidenceIds: [],
    gapsBefore,
    gapsAfter: gapsBefore,
    parentAttemptId: input.parentAttemptId,
  };

  if (!parent) {
    return { ...empty, skippedReason: "no_parent_attempt" };
  }

  recordRecoveryIntentDecisions(
    input.trace,
    input.runId,
    input.step,
    toRecoveryIntentEvents(input.parentAttemptId, intents),
  );

  if (!canStartRecoveryRound(budget, input.usage)) {
    return { ...empty, skippedReason: "budget_exhausted" };
  }

  const selectedIntents = executableIntents({ intents, requireBlocking });
  if (selectedIntents.length === 0) {
    return { ...empty, skippedReason: "no_blocking_gap" };
  }

  const actions = selectActionsForIntents(intents, budget, input.usage, requireBlocking);
  if (actions.length === 0) {
    return { ...empty, skippedReason: "no_candidate" };
  }

  const triggerGaps = requireBlocking
    ? gapsBefore.filter((item) => item.severity === "blocking")
    : gapsBefore.filter((item) => selectedIntents.some((intent) => intent.triggerGapTypes.includes(item.type)));

  const round = input.usage.rounds + 1;
  const attempt = createRecoveryAttempt({
    id: recoveryAttemptId(input.parentAttemptId, round),
    parentAttemptId: input.parentAttemptId,
    triggerGapIds: triggerGaps.map((item) => resolutionGapId(item.candidateId, item.type)),
    recoveryIntentIds: selectedIntents.map((item) => item.id),
    selectedActions: actions.map((item) => item.action),
    status: "planned",
  });

  recordRecoveryAttemptStarted(input.trace, input.runId, input.step, {
    parentAttemptId: attempt.parentAttemptId,
    recoveryIntentIds: attempt.recoveryIntentIds,
    actions: attempt.selectedActions,
  });

  attempt.status = "running";
  input.usage.rounds += 1;

  const addedEvidenceIds: string[] = [];
  let executionStatus: "completed" | "failed" = "completed";
  for (const action of actions) {
    if (input.usage.actions >= budget.maxAdditionalActions || input.usage.toolCalls >= budget.maxAdditionalToolCalls) {
      break;
    }
    let result;
    try {
      result = await input.executor.execute(action);
    } catch {
      executionStatus = "failed";
      attempt.status = "failed";
      break;
    }
    input.usage.actions += 1;
    input.usage.toolCalls += 1;
    const known = knownAddedEvidenceIds(input.run, result.addedEvidenceIds);
    addedEvidenceIds.push(...known);
    if (result.status === "failed") {
      executionStatus = "failed";
    }
  }

  recordRecoveryExecutionCompleted(input.trace, input.runId, input.step, {
    recoveryAttemptId: attempt.id,
    addedEvidenceIds,
    status: executionStatus,
  });

  input.run.resolutionAnalyses = buildResolutionAnalyses(input.run);
  const gapsAfter = analyzeGapsForRecovery(input.run);
  const verification = input.verifier.verify({ task: input.task, run: input.run }, input.trace);

  const next = appendAttempt(input.run, {
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    parentAttemptId: input.parentAttemptId,
    strategy: RECOVERY_STRATEGY,
    status: verification.status === "verified_complete" ? "verified" : executionStatus === "failed" ? "failed" : "incomplete",
    evidenceIds: input.run.evidence.map((item) => item.id),
    claimIds: input.run.claims.map((item) => item.id),
    verification,
  });
  input.run.attempts = next.attempts;
  input.run.status =
    verification.status === "verified_complete" ||
    verification.status === "not_verified" ||
    verification.status === "insufficient_evidence"
      ? verification.status
      : input.run.status;

  attempt.status = executionStatus === "failed" ? "failed" : "completed";
  attempt.outcome = recoveryOutcome(executionStatus, gapsBefore, gapsAfter, addedEvidenceIds);

  return {
    executed: true,
    recoveryAttempt: attempt,
    addedEvidenceIds,
    gapsBefore,
    gapsAfter,
    verification,
    parentAttemptId: input.parentAttemptId,
  };
}
