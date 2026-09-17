import { appendAttempt, createInvestigationRun, createInvestigationTask, RECOVERY_BOUNDS } from "../domain/index.js";
import type { FailureEvent, InvestigationTask, RecoveryBounds, RecoveryPlan, VerificationResult } from "../domain/index.js";
import type { Model, ModelContext, ModelResponse } from "../agent/model.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { OpenAICompatModel } from "../agent/openai-compat-model.js";
import { readLlmConfig } from "../agent/llm-config.js";
import type { HistoryMessage } from "../agent/model.js";
import type { AgentResult, Task, ToolResult } from "../core/types.js";
import type { GitHubDataProvider } from "../github/provider.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { IndependentCompletionVerifier } from "../verification/independent-completion-verifier.js";
import type { AnalysisContext } from "./analysis-context.js";
import { applyRecoveryPlan, waitBackoff } from "./apply-recovery.js";
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
      }),
    };
  }
  return { actor: "unconfigured", model: undefined };
}

function unconfiguredReport(state: InvestigationState): InvestigationAgentReport {
  state.run.status = "not_verified";
  state.run.endedAt = new Date().toISOString();
  state.addQuestion("LLM is not configured; investigation did not run.");
  const report = toAgentReport({ state, actor: "unconfigured", status: "unconfigured" });
  report.report.conclusion =
    "Investigation Agent is unconfigured: no OpenAI-compatible API key. Not running WorkspaceAgentModel / keyword classifier. SnapshotInvestigationDriver is a test fixture only (pass useTestDriver: true).";
  report.report.uncertainty =
    "No autonomous investigation was performed. This is not a real Investigation Agent result.";
  return report;
}

/**
 * Run a bounded GitHub investigation.
 * Reuses AgentLoop + ToolRegistry + TraceCollector. Does not rewrite the loop.
 * Never lets the Agent set InvestigationRun.status to verified_complete.
 * IndependentCompletionVerifier alone produces VerificationResult.
 * FailureAnalyzer / RecoveryPlanner decide recovery; this loop executes the plan
 * as a new append-only attempt and re-verifies.
 */
export async function investigate(options: InvestigateOptions): Promise<InvestigationAgentReport> {
  const task = asTask(options.task);
  const trace = options.trace ?? new TraceCollector();
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  const session: InvestigationSession = { state, trace, runId: run.id };
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
  });

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
    const report = unconfiguredReport(state);
    trace.record(run.id, 0, "investigation_completed", {
      status: report.status,
      actor: report.actor,
      notice: report.report.conclusion,
      verifiedComplete: false,
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
  const recoveries: RecoveryPlan[] = [];

  for (let attempt = 1; attempt <= bounds.maxInvestigationAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    trace.record(run.id, state.currentStep, "attempt_started", { attempt });

    lastAgentResult = await loop.run(coreTask, run.id, {
      attempt,
      investigationFailure: lastFailure,
      investigationRecovery: lastRecovery,
    });

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
    });

    if (lastVerification.status === "verified_complete") {
      const next = appendAttempt(run, {
        startedAt,
        endedAt: new Date().toISOString(),
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
    };
    const fingerprint = investigationFingerprint(state);

    trace.record(run.id, state.currentStep, "failure_detected", {
      attempt,
      verificationStatus: lastVerification.status,
      missingRequirementIds: lastVerification.missingRequirementIds,
    });

    const failures = analyzer.analyze(ctx);
    const failure = analyzer.classify(ctx);
    trace.record(run.id, state.currentStep, "failure_analyzed", {
      attempt,
      types: failures.map((item) => item.type),
      primary: failure?.type,
      reason: failure?.reason,
      retryable: failure?.retryable,
      errorCode: failure?.errorCode,
      missingRequirementIds: failure?.missingRequirementIds,
    });

    const recovery = failure
      ? planner.plan(failure, ctx)
      : {
          action: "stop" as const,
          reason: "No recoverable investigation failure; keeping independent verification result.",
          nextStep: "Stop.",
        };

    trace.record(run.id, state.currentStep, "recovery_planned", {
      attempt,
      action: recovery.action,
      reason: recovery.reason,
      nextStep: recovery.nextStep,
      nextRequirementIds: recovery.nextRequirementIds,
      resetEvidence: recovery.resetEvidence === true,
      retrievalStrategy: recovery.retrievalStrategy,
    });

    const next = appendAttempt(run, {
      startedAt,
      endedAt: new Date().toISOString(),
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

    const bounded =
      attempt >= bounds.maxInvestigationAttempts ||
      state.recoveryCount >= bounds.maxRecoveryAttempts;
    if (!failure || recovery.action === "stop" || bounded) {
      run.status = lastVerification.status;
      break;
    }

    trace.record(run.id, state.currentStep, "recovery_started", {
      attempt,
      action: recovery.action,
      nextAttempt: attempt + 1,
    });
    applyRecoveryPlan(state, recovery, failure);
    await waitBackoff(recovery, options.executeBackoff === true);
    recoveries.push(recovery);
    lastFailure = failure;
    lastRecovery = recovery;
    trace.record(run.id, state.currentStep, "recovery_completed", {
      attempt,
      action: recovery.action,
      recoveryCount: state.recoveryCount,
      remainingAttempts: bounds.maxInvestigationAttempts - attempt,
    });
  }

  run.endedAt = new Date().toISOString();
  if (!lastVerification) {
    throw new Error("Investigation produced no verification result");
  }
  if (lastVerification.status === "verified_complete") {
    run.status = lastVerification.status;
  } else if (!run.status || run.status === "in_progress") {
    run.status = lastVerification.status;
  }

  const report = toAgentReport({
    state,
    actor: resolved.actor,
    agentResult: lastAgentResult,
    verification: lastVerification,
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
