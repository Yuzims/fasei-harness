import { appendAttempt, createInvestigationRun, createInvestigationTask, RECOVERY_BOUNDS } from "../domain/index.js";
import type {
  FailureEvent,
  InvestigationAttemptStatus,
  InvestigationStrategy,
  InvestigationTask,
  RecoveryBounds,
  RecoveryPlan,
  VerificationResult,
} from "../domain/index.js";
import type { Model, ModelContext, ModelResponse } from "../agent/model.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { OpenAICompatModel } from "../agent/openai-compat-model.js";
import { readLlmConfig } from "../agent/llm-config.js";
import {
  formatLlmProfilingSummary,
  formatLlmUsageSummary,
  llmCallTraceData,
  LlmUsageCollector,
} from "../agent/llm-usage.js";
import {
  isLlmRuntimeError,
  isRuntimeBudgetFailure,
  LlmRuntimeGuard,
  type LlmRuntimeBudget,
} from "../agent/llm-runtime.js";
import type { HistoryMessage } from "../agent/model.js";
import type { AgentResult, Task, ToolResult } from "../core/types.js";
import type { GitHubDataProvider } from "../github/provider.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { IndependentCompletionVerifier } from "../verification/independent-completion-verifier.js";
import type { AnalysisContext } from "./analysis-context.js";
import { applyRecoveryPlan, defaultInvestigationStrategy, waitBackoff } from "./apply-recovery.js";
import { FailureAnalyzer } from "./failure-analyzer.js";
import { createInvestigationToolList } from "./investigation-tools.js";
import type { InvestigationSession } from "./investigation-tools.js";
import {
  toAgentReport,
  type InvestigationActor,
  type InvestigationAgentReport,
} from "./investigation-report.js";
import { INVESTIGATION_SYSTEM_PROMPT } from "./policy.js";
import { RecoveryPlanner } from "./recovery-planner.js";
import { formatStateForModel, investigationFingerprint, InvestigationState } from "./state.js";
import { SnapshotInvestigationDriver, TEST_DRIVER_NOTICE } from "./test-driver.js";

export interface InvestigateInput {
  owner: string;
  repository: string;
  issueNumber: number;
  question?: InvestigationTask["question"];
  description?: string;
}

export interface InvestigateOptions {
  task: InvestigationTask | InvestigateInput;
  provider: GitHubDataProvider;
  trace?: TraceCollector;
  maxSteps?: number;
  /** Injected model (tests / LLM). */
  model?: Model;
  /**
   * Use the deterministic snapshot test driver.
   * This is NOT a real Investigation Agent — tests and offline fixtures only.
   */
  useTestDriver?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  maxRecoveryAttempts?: number;
  maxToolRetries?: number;
  analyzer?: FailureAnalyzer;
  planner?: RecoveryPlanner;
  /** Sleep during retry_with_backoff. Default false so tests stay fast. */
  executeBackoff?: boolean;
  /** Build a model that can see investigation state (tests / recovery scenarios). */
  modelFactory?: (session: InvestigationSession) => Model;
  /**
   * Extra LLM runtime cap on top of maxSteps / maxAttempts.
   * Defaults: maxLlmCalls=8, maxWallClockMs=120_000.
   */
  llmRuntimeBudget?: Partial<LlmRuntimeBudget>;
  /**
   * Optional parent abort (e.g. HTTP client disconnect).
   * Deadline abort is owned by FASEI even when this is omitted.
   */
  signal?: AbortSignal;
}

class InvestigationLoopModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly session: InvestigationSession,
    private readonly injectState: boolean,
  ) {}

  async decide(
    task: Task,
    history: HistoryMessage[],
    toolResults: ToolResult[],
    context?: ModelContext,
  ): Promise<ModelResponse> {
    this.session.currentAttempt = context?.attempt ?? this.session.currentAttempt;
    this.session.state.currentStep += 1;
    const nextHistory =
      this.injectState && history.length > 0
        ? [...history, { role: "user" as const, content: formatStateForModel(this.session.state) }]
        : history;
    const response = await this.inner.decide(task, nextHistory, toolResults, context);
    if (response.type === "tool_call") {
      const reason =
        this.session.state.consumeReason() ??
        `Model chose ${response.call.name} after ${this.session.state.toolHistory.length} tool observation(s).`;
      this.session.state.lastDecisionReason = reason;
      this.session.trace.record(this.session.runId, this.session.state.currentStep, "agent_step", {
        tool: response.call.name,
        arguments: response.call.arguments,
        reason,
        evidenceIds: this.session.state.run.evidence.map((item) => item.id),
        candidatePrs: [...this.session.state.candidatePrs],
        unresolvedQuestions: [...this.session.state.unresolvedQuestions],
        investigatedResources: [...this.session.state.investigatedResources],
      });
    }
    return response;
  }
}

function asTask(input: InvestigationTask | InvestigateInput): InvestigationTask {
  if ("target" in input && "id" in input && "question" in input) {
    return input;
  }
  return createInvestigationTask({
    target: {
      owner: input.owner,
      repository: input.repository,
      issueNumber: input.issueNumber,
    },
    question: input.question,
    description: input.description,
  });
}

function resolveActorAndModel(input: {
  options: InvestigateOptions;
  state: InvestigationState;
  session: InvestigationSession;
  tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>;
}): { actor: InvestigationActor; model: Model | undefined; notice?: string } {
  if (input.options.useTestDriver) {
    return {
      actor: "test_driver",
      model: new SnapshotInvestigationDriver(input.state),
      notice: TEST_DRIVER_NOTICE,
    };
  }
  if (input.options.modelFactory) {
    return { actor: "llm", model: input.options.modelFactory(input.session) };
  }
  if (input.options.model) {
    return { actor: "llm", model: input.options.model };
  }
  const config = readLlmConfig(input.options.env ?? process.env);
  if (config.kind === "openai" && config.apiKey) {
    return {
      actor: "llm",
      model: new OpenAICompatModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        tools: input.tools,
        fetchImpl: input.options.fetchImpl,
        systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
        usageCollector: input.session.llmUsage,
        runtime: input.session.llmRuntime,
        onLlmCall: (record) => {
          input.session.trace.record(
            input.session.runId,
            record.agentStep ?? input.session.state.currentStep,
            "model_call_completed",
            llmCallTraceData(record, {
              investigationRunId: input.session.runId,
              attempt: record.attempt ?? input.session.currentAttempt,
              agentStep: record.agentStep,
            }),
          );
        },
      }),
    };
  }
  return { actor: "unconfigured", model: undefined };
}

function llmUsageTraceFields(usage: ReturnType<LlmUsageCollector["aggregate"]>): Record<string, unknown> {
  return {
    model: usage.model,
    llmCalls: usage.llmCalls,
    totalInputTokens: usage.totalInputTokens,
    totalCachedInputTokens: usage.totalCachedInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens,
    overallCacheHitRate: usage.overallCacheHitRate,
    averageInputTokensPerCall: usage.averageInputTokensPerCall,
    averageOutputTokensPerCall: usage.averageOutputTokensPerCall,
  };
}

function stopRuntimeBudgetRecovery(failure: FailureEvent, attempt: number): RecoveryPlan {
  return {
    action: "stop",
    reason:
      failure.reason ||
      "LLM runtime budget exceeded; recovery must not start another LLM call.",
    nextStep: "Stop.",
    id: `attempt-${attempt}:recovery:stop`,
    failureEventId: failure.id,
  };
}

function unconfiguredReport(
  state: InvestigationState,
  llmUsage = new LlmUsageCollector().aggregate(),
  runtimeBudget?: LlmRuntimeBudget,
): InvestigationAgentReport {
  state.run.status = "not_verified";
  state.run.endedAt = new Date().toISOString();
  state.addQuestion("LLM is not configured; investigation did not run.");
  const report = toAgentReport({
    state,
    actor: "unconfigured",
    status: "unconfigured",
    llmUsage,
    runtimeBudget,
  });
  report.report.conclusion =
    "Investigation Agent is unconfigured: no OpenAI-compatible API key. Not running WorkspaceAgentModel / keyword classifier. SnapshotInvestigationDriver is a test fixture only (pass useTestDriver: true).";
  report.report.uncertainty =
    "No autonomous investigation was performed. This is not a real Investigation Agent result.";
  return report;
}

function withFailureId(failure: FailureEvent, attempt: number): FailureEvent {
  return { ...failure, id: failure.id ?? `attempt-${attempt}:failure:${failure.type}` };
}

function withRecoveryId(
  plan: RecoveryPlan,
  failure: FailureEvent | undefined,
  attempt: number,
): RecoveryPlan {
  return {
    ...plan,
    id: plan.id ?? `attempt-${attempt}:recovery:${plan.action}`,
    failureEventId: plan.failureEventId ?? failure?.id,
  };
}

function statusForAttempt(input: {
  verification?: VerificationResult;
  failure?: FailureEvent;
  recovery?: RecoveryPlan;
  exhausted?: boolean;
}): InvestigationAttemptStatus {
  if (input.verification?.status === "verified_complete") {
    return "verified";
  }
  if (input.exhausted) {
    return "recovery_exhausted";
  }
  if (input.recovery?.action === "stop") {
    return "stopped";
  }
  if (input.failure) {
    return "failed";
  }
  return "incomplete";
}

/**
 * Recovery Contract (Phase 7.3):
 * 1. Trigger: Independent verifier did not produce verified_complete.
 * 2. FailureAnalyzer classifies structured state into FailureEvent (not error.message).
 * 3. RecoveryPlanner maps FailureType → RecoveryPlan action ("what to do").
 * 4. applyRecoveryPlan mutates InvestigationState and installs InvestigationStrategy
 *    for the next attempt ("how to investigate next").
 * 5. The next AgentLoop iteration reads strategy + recovery context from state / ModelContext.
 * 6. Provenance: Attempt N.parentAttemptId / recoveryPlanId / failureEventId → Attempt N-1.
 * 7. Bounds: RECOVERY_BOUNDS; exceeding them stops with recovery_exhausted.
 */
export async function investigate(options: InvestigateOptions): Promise<InvestigationAgentReport> {
  const task = asTask(options.task);
  const trace = options.trace ?? new TraceCollector();
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  const llmUsage = new LlmUsageCollector();
  const runtime = new LlmRuntimeGuard({
    budget: options.llmRuntimeBudget,
    signal: options.signal,
  });
  const session: InvestigationSession = {
    state,
    trace,
    runId: run.id,
    llmUsage,
    llmRuntime: runtime,
  };
  const tools = createInvestigationToolList(options.provider, session);
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }

  const bounds: RecoveryBounds = {
    maxInvestigationAttempts: options.maxAttempts ?? RECOVERY_BOUNDS.maxInvestigationAttempts,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? RECOVERY_BOUNDS.maxRecoveryAttempts,
    maxToolRetries: options.maxToolRetries ?? RECOVERY_BOUNDS.maxToolRetries,
  };
  const analyzer = options.analyzer ?? new FailureAnalyzer();
  const planner = options.planner ?? new RecoveryPlanner();
  const verifier = new IndependentCompletionVerifier();

  trace.record(run.id, 0, "investigation_started", {
    taskId: task.id,
    target: task.target,
    question: task.question,
    description: task.description,
    runtimeBudget: runtime.budget,
  });

  try {
    return await runInvestigationAttempts({
      options,
      task,
      trace,
      run,
      state,
      session,
      tools,
      registry,
      bounds,
      analyzer,
      planner,
      verifier,
      runtime,
      llmUsage,
    });
  } finally {
    runtime.dispose();
  }
}

async function runInvestigationAttempts(input: {
  options: InvestigateOptions;
  task: InvestigationTask;
  trace: TraceCollector;
  run: ReturnType<typeof createInvestigationRun>;
  state: InvestigationState;
  session: InvestigationSession;
  tools: ReturnType<typeof createInvestigationToolList>;
  registry: ToolRegistry;
  bounds: RecoveryBounds;
  analyzer: FailureAnalyzer;
  planner: RecoveryPlanner;
  verifier: IndependentCompletionVerifier;
  runtime: LlmRuntimeGuard;
  llmUsage: LlmUsageCollector;
}): Promise<InvestigationAgentReport> {
  const {
    options,
    task,
    trace,
    run,
    state,
    session,
    tools,
    registry,
    bounds,
    analyzer,
    planner,
    verifier,
    runtime,
    llmUsage,
  } = input;

  const resolved = resolveActorAndModel({
    options,
    state,
    session,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  });

  if (!resolved.model) {
    const report = unconfiguredReport(state, llmUsage.aggregate(), runtime.budget);
    const usage = report.llmUsage;
    trace.record(run.id, 0, "investigation_completed", {
      status: report.status,
      actor: report.actor,
      notice: report.report.conclusion,
      verifiedComplete: false,
      llmUsage: llmUsageTraceFields(usage),
      llmUsageSummary: formatLlmUsageSummary(usage),
      llmProfilingSummary: formatLlmProfilingSummary(usage),
      runtimeBudget: runtime.budget,
    });
    return report;
  }

  const loopModel = new InvestigationLoopModel(
    resolved.model,
    session,
    resolved.actor === "llm",
  );
  const loop = new AgentLoop(loopModel, registry, trace, options.maxSteps ?? 12);
  const coreTask: Task = {
    id: task.id,
    description: [
      `Investigate ${task.target.owner}/${task.target.repository}#${task.target.issueNumber}.`,
      task.description,
      "Use read-only GitHub investigation tools, then record_claim.",
      "Do not declare VERIFIED_COMPLETE.",
    ].join(" "),
  };

  let lastAgentResult: AgentResult | undefined;
  let lastVerification: VerificationResult | undefined;
  let lastFailure: FailureEvent | undefined;
  let lastRecovery: RecoveryPlan | undefined;
  let previousAttemptId: string | undefined;
  const recoveries: RecoveryPlan[] = [];
  if (!state.investigationStrategy) {
    state.investigationStrategy = defaultInvestigationStrategy();
  }

  for (let attempt = 1; attempt <= bounds.maxInvestigationAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const attemptId = `attempt-${attempt}`;
    const strategy: InvestigationStrategy =
      state.investigationStrategy ?? defaultInvestigationStrategy();

    session.currentAttempt = attempt;
    trace.record(run.id, state.currentStep, "attempt_started", { attempt, attemptId });
    trace.record(run.id, state.currentStep, "investigation_attempt_started", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      parentAttemptId: previousAttemptId,
      recoveryPlanId: lastRecovery?.id,
      failureEventId: lastFailure?.id,
      strategy,
      sequence: attempt,
    });

    try {
      lastAgentResult = await loop.run(coreTask, run.id, {
        attempt,
        investigationFailure: lastFailure,
        investigationRecovery: lastRecovery,
        investigationStrategy: strategy,
        llmRuntime: runtime,
        signal: runtime.signal,
      });
    } catch (error) {
      if (!isLlmRuntimeError(error)) {
        throw error;
      }
      session.runtimeFailure = error.toFailureEvent();
      lastAgentResult = {
        status: "failed",
        output: error.message,
        steps: Math.max(1, state.currentStep),
      };
    }

    const claimedComplete = state.run.claims.some(
      (claim) => claim.critical && claim.polarity === "resolved",
    );
    lastVerification = verifier.verify(
      {
        task,
        run,
        agentFinalAnswer:
          typeof lastAgentResult.output === "string" ? lastAgentResult.output : undefined,
        agentClaimedComplete: claimedComplete,
      },
      trace,
    );

    const snapshot = toAgentReport({
      state,
      actor: resolved.actor,
      agentResult: lastAgentResult,
      verification: lastVerification,
      llmUsage: llmUsage.aggregate(),
      runtimeBudget: runtime.budget,
    });

    if (lastVerification.status === "verified_complete" && !session.runtimeFailure) {
      const next = appendAttempt(run, {
        id: attemptId,
        startedAt,
        endedAt: new Date().toISOString(),
        parentAttemptId: previousAttemptId,
        recoveryPlanId: lastRecovery?.id,
        failureEventId: lastFailure?.id,
        strategy,
        status: "verified",
        agentConclusion: snapshot.report.conclusion,
        report: snapshot.report,
        evidenceIds: snapshot.evidence.map((item) => item.id),
        claimIds: snapshot.claims.map((item) => item.id),
        verification: lastVerification,
      });
      run.attempts = next.attempts;
      run.status = lastVerification.status;
      break;
    }

    const ctx: AnalysisContext = {
      task,
      state,
      verification: lastVerification,
      agentResult: lastAgentResult,
      attempt,
      previousFingerprints: [...state.fingerprints],
      previousRecoveries: recoveries,
      bounds,
      runtimeFailure: session.runtimeFailure,
    };
    const fingerprint = investigationFingerprint(state);

    trace.record(run.id, state.currentStep, "failure_detected", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      verificationStatus: lastVerification.status,
      missingRequirementIds: lastVerification.missingRequirementIds,
      runtimeFailure: session.runtimeFailure?.errorCode,
    });

    const failures = analyzer.analyze(ctx);
    const classified = analyzer.classify(ctx);
    const failure = classified ? withFailureId(classified, attempt) : undefined;
    trace.record(run.id, state.currentStep, "failure_analyzed", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      failureEventId: failure?.id,
      types: failures.map((item) => item.type),
      primary: failure?.type,
      reason: failure?.reason,
      retryable: failure?.retryable,
      errorCode: failure?.errorCode,
      missingRequirementIds: failure?.missingRequirementIds,
    });

    let recovery = withRecoveryId(
      failure
        ? planner.plan(failure, ctx)
        : {
            action: "stop",
            reason: "No recoverable investigation failure; keeping independent verification result.",
            nextStep: "Stop.",
          },
      failure,
      attempt,
    );
    if (failure && isRuntimeBudgetFailure(failure) && recovery.action !== "stop") {
      recovery = withRecoveryId(stopRuntimeBudgetRecovery(failure, attempt), failure, attempt);
    }

    trace.record(run.id, state.currentStep, "recovery_planned", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      failureEventId: failure?.id,
      recoveryPlanId: recovery.id,
      action: recovery.action,
      reason: recovery.reason,
      nextStep: recovery.nextStep,
      nextRequirementIds: recovery.nextRequirementIds,
      resetEvidence: recovery.resetEvidence === true,
      retrievalStrategy: recovery.retrievalStrategy,
      sequence: recoveries.length + 1,
    });

    const bounded =
      attempt >= bounds.maxInvestigationAttempts ||
      state.recoveryCount >= bounds.maxRecoveryAttempts;
    const budgetStop = Boolean(failure && isRuntimeBudgetFailure(failure));
    const willStop = !failure || recovery.action === "stop" || bounded || budgetStop;
    const exhausted =
      willStop &&
      recoveries.length > 0 &&
      (attempt >= bounds.maxInvestigationAttempts ||
        state.recoveryCount >= bounds.maxRecoveryAttempts ||
        /budget exhausted|attempt budget/i.test(recovery.reason));

    const next = appendAttempt(run, {
      id: attemptId,
      startedAt,
      endedAt: new Date().toISOString(),
      parentAttemptId: previousAttemptId,
      recoveryPlanId: lastRecovery?.id,
      failureEventId: lastFailure?.id,
      strategy,
      status: statusForAttempt({
        verification: lastVerification,
        failure,
        recovery,
        exhausted,
      }),
      agentConclusion: snapshot.report.conclusion,
      report: snapshot.report,
      evidenceIds: snapshot.evidence.map((item) => item.id),
      claimIds: snapshot.claims.map((item) => item.id),
      verification: lastVerification,
      failure,
      recovery,
    });
    run.attempts = next.attempts;
    state.fingerprints.push(fingerprint);
    previousAttemptId = attemptId;

    if (willStop || !failure) {
      run.status = exhausted
        ? "recovery_exhausted"
        : budgetStop
          ? "stopped"
          : lastVerification.status;
      break;
    }

    trace.record(run.id, state.currentStep, "recovery_started", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      action: recovery.action,
      nextAttempt: attempt + 1,
      recoveryPlanId: recovery.id,
      failureEventId: failure.id,
    });
    applyRecoveryPlan(state, recovery, failure);
    await waitBackoff(recovery, options.executeBackoff === true);
    recoveries.push(recovery);
    lastFailure = failure;
    lastRecovery = recovery;
    trace.record(run.id, state.currentStep, "recovery_applied", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      failureEventId: failure.id,
      recoveryPlanId: recovery.id,
      sequence: recoveries.length,
      action: recovery.action,
      nextAttemptId: `attempt-${attempt + 1}`,
      nextStrategy: state.investigationStrategy,
    });
    trace.record(run.id, state.currentStep, "recovery_completed", {
      investigationRunId: run.id,
      attemptId,
      attempt,
      action: recovery.action,
      recoveryPlanId: recovery.id,
      recoveryCount: state.recoveryCount,
      remainingAttempts: bounds.maxInvestigationAttempts - attempt,
    });
  }

  run.endedAt = new Date().toISOString();
  if (!lastVerification) {
    throw new Error("Investigation produced no verification result");
  }
  if (session.runtimeFailure) {
    run.status = "stopped";
  } else if (lastVerification.status === "verified_complete") {
    run.status = lastVerification.status;
  } else if (!run.status || run.status === "in_progress") {
    run.status = lastVerification.status;
  }

  const report = toAgentReport({
    state,
    actor: resolved.actor,
    agentResult: lastAgentResult,
    verification: lastVerification,
    llmUsage: llmUsage.aggregate(),
    runtimeBudget: runtime.budget,
  });

  trace.record(run.id, state.currentStep, "investigation_completed", {
    status: report.status,
    actor: report.actor,
    steps: report.investigationSteps.length,
    evidenceIds: report.evidence.map((item) => item.id),
    claimIds: report.claims.map((item) => item.id),
    claimEvidence: report.claimEvidence,
    unresolvedQuestions: report.unresolvedQuestions,
    polarity: report.report.polarity,
    verificationStatus: lastVerification.status,
    attempts: run.attempts.length,
    recoveryCount: Math.max(0, run.attempts.length - 1),
    agentSetVerifiedComplete: false,
    notice: resolved.notice,
    llmUsage: llmUsageTraceFields(report.llmUsage),
    llmUsageSummary: formatLlmUsageSummary(report.llmUsage),
    llmProfilingSummary: formatLlmProfilingSummary(report.llmUsage),
    runtimeBudget: runtime.budget,
    runtimeFailure: session.runtimeFailure?.errorCode,
  });

  return report;
}

export class InvestigationAgent {
  constructor(private readonly defaults: Omit<InvestigateOptions, "task" | "provider"> = {}) {}

  run(
    task: InvestigationTask | InvestigateInput,
    provider: GitHubDataProvider,
    options: Partial<InvestigateOptions> = {},
  ): Promise<InvestigationAgentReport> {
    return investigate({
      ...this.defaults,
      ...options,
      task,
      provider,
    });
  }
}
