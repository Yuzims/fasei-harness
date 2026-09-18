/**
 * Phase 8.8.2 — Controlled Strategy Evaluation.
 *
 * Deterministic comparison of unconstrained vs Evidence-Gap investigation.
 * Does not reimplement IndependentCompletionVerifier, EvidenceRequirement
 * evaluation, FailureAnalyzer, or RecoveryPlanner.
 *
 * Baseline is an approximation of pre-8.8 tool-selection behavior. It is
 * not a strict historical replay of a live LLM trajectory.
 */
import { randomUUID } from "node:crypto";
import { profileRequestMessages } from "../agent/llm-context-profile.js";
import { DEFAULT_LLM_RUNTIME_BUDGET } from "../agent/llm-runtime.js";
import type { HistoryMessage, Model, ModelContext, ModelResponse } from "../agent/model.js";
import { isFalseCompletion, isVerifierFalsePositive } from "../benchmark/metrics.js";
import {
  convertCaseToScenario,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadCaseSnapshot,
  loadDataset,
  realDatasetManifestPath,
} from "../benchmark/dataset/index.js";
import type { ExpectedOutcome } from "../benchmark/types.js";
import { MAX_STEPS_REACHED } from "../agent/agent-loop.js";
import type { Task, ToolCall, ToolResult } from "../core/types.js";
import {
  createEvidence,
  createInvestigationTask,
  createRelation,
  type EvidenceRequirementCondition,
  type VerificationStatus,
} from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import { githubFixturePath, type GithubFixtureId } from "../github/snapshot-store.js";
import type { GitHubDataProvider } from "../github/provider.js";
import {
  computeEvidenceGap,
  investigate,
  isLegalInvestigationAction,
  matchLegalAction,
  nextInvestigationAction,
  proposeCandidateActions,
  unresolvedRequiredGaps,
  type InvestigateOptions,
  type InvestigationAgentReport,
  type InvestigationSession,
} from "../investigation/index.js";
import { buildDriverClaims } from "../investigation/test-driver.js";
import {
  resourceKey,
  resourceKeyForTool,
  type InvestigationState,
} from "../investigation/state.js";

export const STRATEGY_EVALUATION_VERSION = "8.8.2";

export const STRATEGY_EVALUATION_BASELINE_NOTE =
  "Baseline is an approximation of pre-8.8 tool-selection behavior. It reuses the observation-based SnapshotInvestigationDriver policy with the Evidence-Gap legal-action constraint disabled. It is not a strict historical replay of a live LLM trajectory.";

export type StrategyEvaluationMode = "unconstrained" | "evidence_gap";

export type StrategyEvaluationFailureMode =
  | "over_constraint"
  | "missing_candidate_mapping"
  | "strategy_exhaustion"
  | "unnecessary_exploration"
  | "duplicate_action";

export interface StrategyEvaluationMetrics {
  llmCalls: number;
  toolCalls: number;
  duplicateInvestigationActions: number;
  exactDuplicateActions: number;
  repeatedToolCalls: number;
  unnecessaryInvestigationActions: number;
  exploratoryActions: number;
  /** Local heuristic (message chars / 4). Not provider tokens. */
  estimatedInputTokens: number | null;
  estimatedMessageChars: number;
  estimatedToolResultChars: number;
  inputTokensEstimated: true;
  evidenceCoverage: number;
  unsupportedClaimRate: number;
  falseCompletionRate: number;
  verifierFalsePositiveRate: number;
  finalVerificationStatus: VerificationStatus;
  attempts: number;
  recoveryEvents: number;
  budgetExhaustion: boolean;
  strategyExhausted: boolean;
  agentDecision?: string;
  toolSequence: string[];
  missingRequirementIds: string[];
  missingConditions: EvidenceRequirementCondition[];
  observedFailureModes: StrategyEvaluationFailureMode[];
}

export interface StrategyEvaluationRun {
  caseId: string;
  mode: StrategyEvaluationMode;
  metrics: StrategyEvaluationMetrics;
  report: InvestigationAgentReport;
}

export interface StrategyMetricDifference {
  llmCalls: number;
  toolCalls: number;
  duplicateInvestigationActions: number;
  exactDuplicateActions: number;
  repeatedToolCalls: number;
  unnecessaryInvestigationActions: number;
  exploratoryActions: number;
  estimatedInputTokens: number | null;
  estimatedMessageChars: number;
  estimatedToolResultChars: number;
  evidenceCoverage: number;
  unsupportedClaimRate: number;
  falseCompletionRate: number;
  verifierFalsePositiveRate: number;
  attempts: number;
  recoveryEvents: number;
}

export interface StrategyComparison {
  caseId: string;
  baseline: StrategyEvaluationMetrics;
  strategy: StrategyEvaluationMetrics;
  difference: StrategyMetricDifference;
  baselineOutcome: VerificationStatus;
  strategyOutcome: VerificationStatus;
}

export interface StrategyEvaluationCaseConfig {
  caseId: string;
  fixture: GithubFixtureId;
  expected?: ExpectedOutcome;
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
  prematureOnFirstAttempt?: boolean;
  prepareState?: (state: InvestigationState) => void;
}

interface ActionObservation {
  tool: string;
  arguments: Record<string, unknown>;
  resourceKey?: string;
  signature: string;
  unnecessary: boolean;
  exploratory: boolean;
  recoveryRequired: boolean;
  revalidation: boolean;
  contributed: boolean;
  unmatchedCandidate: boolean;
}

interface EvaluationCollector {
  llmCalls: number;
  estimatedInputTokens: number | null;
  estimatedMessageChars: number;
  estimatedToolResultChars: number;
  actions: ActionObservation[];
  missingCandidateMapping: boolean;
}

const SEED_TIME = "2026-09-18T00:00:00.000Z";

function remainingCalls(session: InvestigationSession): number | undefined {
  const runtime = session.llmRuntime;
  if (!runtime) {
    return undefined;
  }
  return Math.max(0, runtime.budget.maxLlmCalls - runtime.llmCallsSent);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

export function normalizedArgumentSignature(args: Record<string, unknown>): string {
  return JSON.stringify(stableValue(args));
}

export function exactActionSignature(tool: string, args: Record<string, unknown>): string {
  const key = resourceKeyForTool(tool, args) ?? "";
  return `${tool}::${key}::${normalizedArgumentSignature(args)}`;
}

function provenance(owner: string, repository: string, resource: string) {
  return {
    source: "github" as const,
    repository: `${owner}/${repository}`,
    resource,
    url: `https://github.com/${owner}/${repository}/${resource}`,
    retrievedAt: SEED_TIME,
    trust: "external_untrusted" as const,
  };
}

export function seedClosedIssue(
  state: InvestigationState,
  extra?: { body?: string; title?: string; stateReason?: string; markTimeline?: boolean },
) {
  const { owner, repository, issueNumber } = state.task.target;
  const evidence = createEvidence({
    kind: "issue",
    summary: `Issue #${issueNumber} is closed`,
    payload: {
      number: issueNumber,
      repository: `${owner}/${repository}`,
      state: "closed",
      stateReason: extra?.stateReason,
      title: extra?.title ?? "Null pointer when saving empty cart",
      body: extra?.body ?? "Saving an empty cart throws. Please fix.",
    },
    provenance: provenance(owner, repository, `issues/${issueNumber}`),
    contentRef: resourceKey("issue", String(issueNumber)),
  });
  state.addEvidence(evidence);
  state.investigatedResources.add(resourceKey("issue", String(issueNumber)));
  if (extra?.markTimeline) {
    state.investigatedResources.add(resourceKey("timeline", String(issueNumber)));
  }
  state.issueState = "closed";
  return evidence;
}

export function seedMergedPr(state: InvestigationState, issueId: string, pullNumber = 7, extra?: {
  title?: string;
  body?: string;
}) {
  const { owner, repository } = state.task.target;
  const pr = createEvidence({
    kind: "pull_request",
    summary: `PR #${pullNumber} merged=true`,
    payload: {
      number: pullNumber,
      repository: `${owner}/${repository}`,
      merged: true,
      state: "closed",
      title: extra?.title ?? "Fix empty cart save",
      body: extra?.body ?? "Fixes #42",
    },
    provenance: provenance(owner, repository, `pull/${pullNumber}`),
    contentRef: resourceKey("pr", String(pullNumber)),
  });
  const merge = createEvidence({
    kind: "pull_request",
    summary: `PR #${pullNumber} merged=true`,
    payload: { number: pullNumber, merged: true, mergeCommitSha: "abc123" },
    provenance: provenance(owner, repository, `pull/${pullNumber}`),
    contentRef: resourceKey("pr-merge", String(pullNumber)),
  });
  state.addEvidence(pr);
  state.addEvidence(merge);
  state.addRelation(createRelation({ fromEvidenceId: pr.id, toEvidenceId: issueId, type: "fixes" }));
  state.addCandidatePr(pullNumber);
  state.mergedPrs.add(pullNumber);
  state.investigatedResources.add(resourceKey("pull", String(pullNumber)));
  return pr;
}

export function seedFileAndCommit(
  state: InvestigationState,
  prId: string,
  pullNumber: number,
  extra?: { filename?: string; message?: string; sha?: string },
) {
  const { owner, repository } = state.task.target;
  const filename = extra?.filename ?? "src/cart.ts";
  const sha = extra?.sha ?? "abc123def456";
  const file = createEvidence({
    kind: "file",
    summary: `PR #${pullNumber} modified ${filename}`,
    payload: { filename, status: "modified" },
    provenance: provenance(owner, repository, `pull/${pullNumber}/files/${filename}`),
    contentRef: resourceKey("file", `${pullNumber}:${filename}`),
  });
  const commit = createEvidence({
    kind: "commit",
    summary: `Commit ${sha.slice(0, 6)}: ${extra?.message ?? "Fix empty cart save"}`,
    payload: {
      sha,
      repository: `${owner}/${repository}`,
      message: extra?.message ?? "Fix empty cart save\n\nFixes #42",
    },
    provenance: provenance(owner, repository, `commit/${sha.slice(0, 6)}`),
    contentRef: resourceKey("commit", sha),
  });
  state.addEvidence(file);
  state.addEvidence(commit);
  state.addRelation(createRelation({ fromEvidenceId: file.id, toEvidenceId: prId, type: "derived_from" }));
  state.addRelation(createRelation({ fromEvidenceId: commit.id, toEvidenceId: prId, type: "derived_from" }));
  state.investigatedResources.add(resourceKey("files", String(pullNumber)));
  state.investigatedResources.add(resourceKey("commits", String(pullNumber)));
  state.filesByPr.set(pullNumber, [filename]);
  return { file, commit };
}

function isRecoveryRequiredAction(state: InvestigationState, call: Pick<ToolCall, "name" | "arguments">): boolean {
  const strategy = state.investigationStrategy?.type;
  if (strategy === "retry_failed_tool") {
    return call.name === state.lastFailure?.tool;
  }
  if (strategy === "recheck_target" && call.name === "github_get_issue") {
    return true;
  }
  return false;
}

function isRevalidationAction(state: InvestigationState, call: Pick<ToolCall, "name" | "arguments">): boolean {
  const key = resourceKeyForTool(call.name, call.arguments);
  if (!key) {
    return false;
  }
  return state.refetchResources.has(key);
}

export function classifyExecutedAction(
  state: InvestigationState,
  call: Pick<ToolCall, "name" | "arguments">,
  remainingLlmCalls?: number,
): ActionObservation {
  const gap = computeEvidenceGap(state.task, state.run);
  const unresolved = unresolvedRequiredGaps(gap);
  const candidates = proposeCandidateActions(state, { gap, remainingLlmCalls });
  const matched = matchLegalAction(call, candidates);
  const recoveryRequired = isRecoveryRequiredAction(state, call);
  const revalidation = isRevalidationAction(state, call);
  const contributes = Boolean(
    matched &&
      matched.targetRequirementIds.some((id) => unresolved.some((item) => item.requirementId === id)),
  );
  const exploratory = matched?.exploratory === true;
  const unnecessary =
    !recoveryRequired &&
    !revalidation &&
    !exploratory &&
    !contributes;
  return {
    tool: call.name,
    arguments: call.arguments,
    resourceKey: resourceKeyForTool(call.name, call.arguments),
    signature: exactActionSignature(call.name, call.arguments),
    unnecessary,
    exploratory,
    recoveryRequired,
    revalidation,
    contributed: contributes,
    unmatchedCandidate: !matched,
  };
}

function countExactDuplicates(actions: ActionObservation[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const action of actions) {
    if (seen.has(action.signature)) {
      duplicates += 1;
    } else {
      seen.add(action.signature);
    }
  }
  return duplicates;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}

function profileDecide(history: HistoryMessage[], toolResults: ToolResult[]) {
  const messages = history.map((item) => ({ role: item.role, content: item.content }));
  const profile = profileRequestMessages(messages, history.length, []);
  const toolResultChars = toolResults.reduce((sum, item) => {
    try {
      return sum + JSON.stringify(item).length;
    } catch {
      return sum;
    }
  }, 0);
  return {
    estimatedInputTokens: profile.estimatedInputTokens,
    messageChars: profile.serializedMessagesChars,
    toolResultChars: profile.totalToolResultChars > 0 ? profile.totalToolResultChars : toolResultChars,
  };
}

function prematureFirstAttemptAction(session: InvestigationSession): ModelResponse {
  const target = session.state.task.target;
  const issueKey = resourceKey("issue", String(target.issueNumber));
  if (!session.state.investigatedResources.has(issueKey)) {
    return {
      type: "tool_call",
      call: {
        id: randomUUID(),
        name: "github_get_issue",
        arguments: { owner: target.owner, repo: target.repository, issueNumber: target.issueNumber },
      },
    };
  }
  if (!session.state.claimsRecorded) {
    return {
      type: "tool_call",
      call: {
        id: randomUUID(),
        name: "record_claim",
        arguments: {
          claims: [
            {
              text: `Issue #${target.issueNumber} is resolved.`,
              polarity: "resolved",
              critical: true,
              evidenceIds: session.state.run.evidence.map((item) => item.id),
              role: "supports",
            },
          ],
          conclusion: "Resolved.",
          polarity: "resolved",
        },
      },
    };
  }
  return { type: "final", message: "Done. Issue is resolved." };
}

function selectPreferredToolCall(
  session: InvestigationSession,
  context: ModelContext | undefined,
): ModelResponse {
  const preferred = nextInvestigationAction(session.state);
  session.state.pendingReason = preferred.reason;
  if (!context?.legalInvestigationActions) {
    if (preferred.type === "final") {
      return { type: "final", message: preferred.message };
    }
    return {
      type: "tool_call",
      call: { id: randomUUID(), name: preferred.name, arguments: preferred.arguments },
    };
  }

  const legal = context.legalInvestigationActions;
  if (preferred.type === "tool_call") {
    const allowed = isLegalInvestigationAction(
      { name: preferred.name, arguments: preferred.arguments },
      legal.map((item) => ({
        tool: item.tool,
        arguments: item.arguments,
        targetRequirementIds: item.targetRequirementIds ?? [],
        objective: item.objective ?? "",
        resourceKey: item.resourceKey,
      })),
    );
    if (allowed) {
      const argumentsForCall =
        preferred.name === "record_claim" ? buildDriverClaims(session.state) : preferred.arguments;
      return {
        type: "tool_call",
        call: { id: randomUUID(), name: preferred.name, arguments: argumentsForCall },
      };
    }
  }

  const github = legal.find((item) => item.tool.startsWith("github_"));
  if (github) {
    return {
      type: "tool_call",
      call: { id: randomUUID(), name: github.tool, arguments: github.arguments },
    };
  }
  const claim = legal.find((item) => item.tool === "record_claim");
  if (claim) {
    return {
      type: "tool_call",
      call: {
        id: randomUUID(),
        name: "record_claim",
        arguments: buildDriverClaims(session.state),
      },
    };
  }
  return { type: "final", message: "No legal investigation actions remain. Not verified." };
}

/**
 * Shared Fake Model policy for both evaluation arms.
 * Constraint presence is the experiment variable, not a second chooser.
 */
export function createStrategyEvaluationModel(
  session: InvestigationSession,
  collector: EvaluationCollector,
  options: { prematureOnFirstAttempt?: boolean } = {},
): Model {
  return {
    async decide(
      _task: Task,
      history: HistoryMessage[],
      toolResults: ToolResult[],
      context?: ModelContext,
    ): Promise<ModelResponse> {
      collector.llmCalls += 1;
      const profile = profileDecide(history, toolResults);
      collector.estimatedInputTokens = addNullable(
        collector.estimatedInputTokens,
        profile.estimatedInputTokens,
      );
      collector.estimatedMessageChars += profile.messageChars;
      collector.estimatedToolResultChars += profile.toolResultChars;

      const remainingLlmCalls = remainingCalls(session);
      const gap = computeEvidenceGap(session.state.task, session.state.run);
      const unresolved = unresolvedRequiredGaps(gap);
      const candidates = proposeCandidateActions(session.state, {
        gap,
        remainingLlmCalls,
      });
      if (
        unresolved.length > 0 &&
        !candidates.some((item) =>
          item.targetRequirementIds.some((id) => unresolved.some((gapItem) => gapItem.requirementId === id)),
        )
      ) {
        collector.missingCandidateMapping = true;
      }

      const attempt = context?.attempt ?? 1;
      const response =
        options.prematureOnFirstAttempt && attempt === 1
          ? prematureFirstAttemptAction(session)
          : selectPreferredToolCall(session, context);

      if (response.type === "tool_call") {
        collector.actions.push(
          classifyExecutedAction(session.state, response.call, remainingLlmCalls),
        );
      }
      return response;
    },
  };
}

function verificationStatusOf(report: InvestigationAgentReport): VerificationStatus {
  const status = report.verification?.status ?? report.run.status;
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return "not_verified";
}

function agentClaimedComplete(report: InvestigationAgentReport): boolean {
  return report.claims.some((claim) => claim.critical && claim.polarity === "resolved");
}

function recoveryEventCount(report: InvestigationAgentReport): number {
  return report.run.attempts.filter(
    (attempt) => Boolean(attempt.recovery) && attempt.recovery?.action !== "stop",
  ).length;
}

function budgetExhausted(report: InvestigationAgentReport): boolean {
  if (report.agentResult?.output === MAX_STEPS_REACHED) {
    return true;
  }
  return report.run.attempts.some(
    (attempt) =>
      attempt.failure?.type === "runtime_budget_exceeded" ||
      attempt.failure?.errorCode === "LLM_CALL_BUDGET_EXCEEDED" ||
      attempt.failure?.errorCode === "LLM_RUNTIME_TIMEOUT",
  );
}

function detectFailureModes(
  metrics: Omit<StrategyEvaluationMetrics, "observedFailureModes">,
  collector: EvaluationCollector,
): StrategyEvaluationFailureMode[] {
  const modes: StrategyEvaluationFailureMode[] = [];
  if (metrics.strategyExhausted) {
    modes.push("strategy_exhaustion");
  }
  if (metrics.strategyExhausted && metrics.missingRequirementIds.length > 0) {
    modes.push("over_constraint");
  }
  if (collector.missingCandidateMapping) {
    modes.push("missing_candidate_mapping");
  }
  if (metrics.unnecessaryInvestigationActions > 0) {
    modes.push("unnecessary_exploration");
  }
  if (metrics.duplicateInvestigationActions > 0) {
    modes.push("duplicate_action");
  }
  return modes;
}

function metricsFromRun(
  report: InvestigationAgentReport,
  collector: EvaluationCollector,
  expected?: ExpectedOutcome,
): StrategyEvaluationMetrics {
  const executed = report.investigationSteps;
  const observedActions = collector.actions.filter((action, index) => {
    const step = executed[index];
    return step !== undefined && step.tool === action.tool;
  });
  const classified = observedActions.length > 0 ? observedActions : collector.actions.filter((action) =>
    executed.some(
      (step) =>
        step.tool === action.tool &&
        exactActionSignature(step.tool, step.arguments) === action.signature,
    ),
  );
  const used = classified.length === executed.length ? classified : collector.actions.slice(0, executed.length);
  const exactDuplicates = countExactDuplicates(used);
  const finalStatus = verificationStatusOf(report);
  const claimed = agentClaimedComplete(report);
  const unsupported = report.verification?.unsupportedClaimIds.length ?? 0;
  const gap = computeEvidenceGap(report.task, report.run);
  const missing = unresolvedRequiredGaps(gap);
  const falseCompletion = isFalseCompletion(claimed, finalStatus);
  const verifierFalsePositive = expected
    ? isVerifierFalsePositive(expected.verificationStatus, finalStatus)
    : false;
  const partial = {
    llmCalls: collector.llmCalls,
    toolCalls: executed.length,
    duplicateInvestigationActions: exactDuplicates,
    exactDuplicateActions: exactDuplicates,
    repeatedToolCalls: exactDuplicates,
    unnecessaryInvestigationActions: used.filter((item) => item.unnecessary).length,
    exploratoryActions: used.filter((item) => item.exploratory).length,
    estimatedInputTokens: collector.estimatedInputTokens,
    estimatedMessageChars: collector.estimatedMessageChars,
    estimatedToolResultChars: collector.estimatedToolResultChars,
    inputTokensEstimated: true as const,
    evidenceCoverage: report.verification?.evidenceCoverage ?? 0,
    unsupportedClaimRate: unsupported / Math.max(report.claims.length, 1),
    falseCompletionRate: falseCompletion ? 1 : 0,
    verifierFalsePositiveRate: verifierFalsePositive ? 1 : 0,
    finalVerificationStatus: finalStatus,
    attempts: Math.max(report.run.attempts.length, 1),
    recoveryEvents: recoveryEventCount(report),
    budgetExhaustion: budgetExhausted(report),
    strategyExhausted: report.agentResult?.decision === "strategy_exhausted",
    agentDecision: report.agentResult?.decision,
    toolSequence: executed.map((step) => step.tool),
    missingRequirementIds: missing.map((item) => item.requirementId),
    missingConditions: missing.map((item) => item.condition),
  };
  return {
    ...partial,
    observedFailureModes: detectFailureModes(partial, collector),
  };
}

export function differenceOf(
  strategy: StrategyEvaluationMetrics,
  baseline: StrategyEvaluationMetrics,
): StrategyMetricDifference {
  const tokenDiff =
    strategy.estimatedInputTokens === null && baseline.estimatedInputTokens === null
      ? null
      : (strategy.estimatedInputTokens ?? 0) - (baseline.estimatedInputTokens ?? 0);
  return {
    llmCalls: strategy.llmCalls - baseline.llmCalls,
    toolCalls: strategy.toolCalls - baseline.toolCalls,
    duplicateInvestigationActions:
      strategy.duplicateInvestigationActions - baseline.duplicateInvestigationActions,
    exactDuplicateActions: strategy.exactDuplicateActions - baseline.exactDuplicateActions,
    repeatedToolCalls: strategy.repeatedToolCalls - baseline.repeatedToolCalls,
    unnecessaryInvestigationActions:
      strategy.unnecessaryInvestigationActions - baseline.unnecessaryInvestigationActions,
    exploratoryActions: strategy.exploratoryActions - baseline.exploratoryActions,
    estimatedInputTokens: tokenDiff,
    estimatedMessageChars: strategy.estimatedMessageChars - baseline.estimatedMessageChars,
    estimatedToolResultChars: strategy.estimatedToolResultChars - baseline.estimatedToolResultChars,
    evidenceCoverage: strategy.evidenceCoverage - baseline.evidenceCoverage,
    unsupportedClaimRate: strategy.unsupportedClaimRate - baseline.unsupportedClaimRate,
    falseCompletionRate: strategy.falseCompletionRate - baseline.falseCompletionRate,
    verifierFalsePositiveRate: strategy.verifierFalsePositiveRate - baseline.verifierFalsePositiveRate,
    attempts: strategy.attempts - baseline.attempts,
    recoveryEvents: strategy.recoveryEvents - baseline.recoveryEvents,
  };
}

export async function runStrategyEvaluation(input: {
  caseId: string;
  mode: StrategyEvaluationMode;
  provider: GitHubDataProvider;
  task?: InvestigateOptions["task"];
  expected?: ExpectedOutcome;
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
  prematureOnFirstAttempt?: boolean;
  prepareState?: (state: InvestigationState) => void;
}): Promise<StrategyEvaluationRun> {
  const collector: EvaluationCollector = {
    llmCalls: 0,
    estimatedInputTokens: null,
    estimatedMessageChars: 0,
    estimatedToolResultChars: 0,
    actions: [],
    missingCandidateMapping: false,
  };
  const report = await investigate({
    task: input.task ?? { owner: "acme", repository: "box", issueNumber: 42 },
    provider: input.provider,
    maxAttempts: input.maxAttempts ?? 3,
    maxSteps: input.maxSteps ?? 12,
    llmRuntimeBudget: {
      maxLlmCalls: input.maxLlmCalls ?? DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls,
      maxWallClockMs: input.maxWallClockMs ?? DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs,
    },
    investigationActionConstraint: input.mode === "unconstrained" ? "unconstrained" : "evidence_gap",
    prepareSession: input.prepareState
      ? (session) => {
          input.prepareState?.(session.state);
        }
      : undefined,
    modelFactory: (session) =>
      createStrategyEvaluationModel(session, collector, {
        prematureOnFirstAttempt: input.prematureOnFirstAttempt,
      }),
  });
  return {
    caseId: input.caseId,
    mode: input.mode,
    metrics: metricsFromRun(report, collector, input.expected),
    report,
  };
}

export async function compareStrategyEvaluation(input: {
  caseId: string;
  providerFactory: () => GitHubDataProvider;
  task?: InvestigateOptions["task"];
  expected?: ExpectedOutcome;
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
  prematureOnFirstAttempt?: boolean;
  prepareState?: (state: InvestigationState) => void;
}): Promise<StrategyComparison> {
  const shared = {
    caseId: input.caseId,
    task: input.task,
    expected: input.expected,
    maxAttempts: input.maxAttempts,
    maxSteps: input.maxSteps,
    maxLlmCalls: input.maxLlmCalls,
    maxWallClockMs: input.maxWallClockMs,
    prematureOnFirstAttempt: input.prematureOnFirstAttempt,
    prepareState: input.prepareState,
  };
  const baseline = await runStrategyEvaluation({
    ...shared,
    mode: "unconstrained",
    provider: input.providerFactory(),
  });
  const strategy = await runStrategyEvaluation({
    ...shared,
    mode: "evidence_gap",
    provider: input.providerFactory(),
  });
  return {
    caseId: input.caseId,
    baseline: baseline.metrics,
    strategy: strategy.metrics,
    difference: differenceOf(strategy.metrics, baseline.metrics),
    baselineOutcome: baseline.metrics.finalVerificationStatus,
    strategyOutcome: strategy.metrics.finalVerificationStatus,
  };
}

function fixtureProvider(id: GithubFixtureId): () => GitHubDataProvider {
  return () => new SnapshotGitHubProvider(githubFixturePath(id));
}

export function syntheticStrategyCases(): StrategyEvaluationCaseConfig[] {
  return [
    {
      caseId: "missing_resolution_evidence",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      prepareState: (state) => {
        seedClosedIssue(state);
      },
    },
    {
      caseId: "issue_already_satisfied",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      prepareState: (state) => {
        seedClosedIssue(state);
      },
    },
    {
      caseId: "missing_commit_evidence",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      prepareState: (state) => {
        const issue = seedClosedIssue(state, { markTimeline: true });
        seedMergedPr(state, issue.id, 7);
      },
    },
    {
      caseId: "missing_code_evidence",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      prepareState: (state) => {
        const issue = seedClosedIssue(state, { markTimeline: true });
        seedMergedPr(state, issue.id, 7);
      },
    },
    {
      caseId: "resolution_effect_gap",
      fixture: "resolved",
      expected: { verificationStatus: "insufficient_evidence" },
      prepareState: (state) => {
        const issue = seedClosedIssue(state, {
          title: "Null pointer when saving empty cart",
          body: "Saving an empty cart throws.",
          markTimeline: true,
        });
        const pr = seedMergedPr(state, issue.id, 7, {
          title: "Update changelog formatting",
          body: "Docs only. Fixes #42",
        });
        seedFileAndCommit(state, pr.id, 7, {
          filename: "CHANGELOG.md",
          message: "docs: changelog formatting",
          sha: "def456aaa111",
        });
      },
    },
    {
      caseId: "recovery",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      prematureOnFirstAttempt: true,
      maxAttempts: 3,
    },
    {
      caseId: "tight_budget",
      fixture: "resolved",
      expected: { verificationStatus: "verified_complete" },
      maxLlmCalls: 2,
      maxAttempts: 1,
      prepareState: (state) => {
        seedClosedIssue(state);
        state.addCandidatePr(7);
      },
    },
    {
      caseId: "no_legal_action",
      fixture: "insufficient-evidence",
      expected: { verificationStatus: "insufficient_evidence" },
      maxAttempts: 1,
    },
  ];
}

function taskForCase(config: StrategyEvaluationCaseConfig): InvestigateOptions["task"] {
  if (config.fixture === "insufficient-evidence") {
    return { owner: "acme", repository: "box", issueNumber: 7 };
  }
  if (config.fixture === "closed-unmerged") {
    return { owner: "acme", repository: "box", issueNumber: 99 };
  }
  return { owner: "acme", repository: "box", issueNumber: 42 };
}

export async function evaluateSyntheticCase(
  caseId: string,
): Promise<StrategyComparison> {
  const config = syntheticStrategyCases().find((item) => item.caseId === caseId);
  if (!config) {
    throw new Error(`unknown synthetic strategy evaluation case: ${caseId}`);
  }
  return compareStrategyEvaluation({
    caseId: config.caseId,
    providerFactory: fixtureProvider(config.fixture),
    task: taskForCase(config),
    expected: config.expected,
    maxAttempts: config.maxAttempts,
    maxSteps: config.maxSteps,
    maxLlmCalls: config.maxLlmCalls,
    maxWallClockMs: config.maxWallClockMs,
    prematureOnFirstAttempt: config.prematureOnFirstAttempt,
    prepareState: config.prepareState,
  });
}

export async function evaluateAllSyntheticCases(): Promise<StrategyComparison[]> {
  const results: StrategyComparison[] = [];
  for (const item of syntheticStrategyCases()) {
    results.push(await evaluateSyntheticCase(item.caseId));
  }
  return results;
}

const REAL_CASE_IDS = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"] as const;

export async function evaluateRealV1Case(caseId: string): Promise<StrategyComparison> {
  const dataset = loadDataset(realDatasetManifestPath());
  const datasetCase = loadCase(dataset, caseId);
  const snapshot = loadCaseSnapshot(dataset, datasetCase);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  if ("expectedOutcome" in scenario && scenario.expectedOutcome !== undefined) {
    throw new Error(`real dataset case ${caseId} leaked expectedOutcome into the agent scenario`);
  }
  const expected = expectedOutcomeForDatasetCase(dataset, caseId);
  return compareStrategyEvaluation({
    caseId,
    providerFactory: () => new SnapshotGitHubProvider(snapshot),
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
    expected,
  });
}

export async function evaluateRealV1Cases(
  caseIds: readonly string[] = REAL_CASE_IDS,
): Promise<StrategyComparison[]> {
  const results: StrategyComparison[] = [];
  for (const caseId of caseIds) {
    results.push(await evaluateRealV1Case(caseId));
  }
  return results;
}

export { REAL_CASE_IDS };
