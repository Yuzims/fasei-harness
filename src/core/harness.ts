/**
 * Workspace synthetic Harness (legacy failure injection).
 *
 * Legacy Failure Injection ≠ Investigation Recovery
 *
 * Product path: src/investigation/investigation-agent.ts
 */
import { randomUUID } from "node:crypto";
import type { Task, AgentResult } from "./types.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { TraceCollector, type TraceEvent } from "../trace/trace-collector.js";
import type { Workspace } from "./workspace.js";
import { WorkspaceCompletionVerifier } from "../verification/completion-verifier.js";
import type { VerificationResult } from "../verification/types.js";
import { FailureAnalyzer } from "../legacy/failure/failure-analyzer.js";
import type { Failure } from "../legacy/failure/failure-types.js";
import {
  RecoveryPlanner,
  type Planner,
  type RecoveryPlan,
} from "../legacy/recovery/recovery-planner.js";

export interface HarnessOptions {
  maxAttempts?: number;
  analyzer?: FailureAnalyzer;
  planner?: Planner;
  onDelta?: (text: string) => void;
}

export interface AttemptSnapshot {
  attempt: number;
  result: AgentResult;
  verification: VerificationResult;
  failure?: Failure;
  recovery?: RecoveryPlan;
}

export interface HarnessRun {
  runId: string;
  result: AgentResult;
  verification: VerificationResult;
  failure?: Failure;
  recovery?: RecoveryPlan;
  attempts: AttemptSnapshot[];
  recoveryCount: number;
  trace: TraceEvent[];
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
}

export class Harness {
  private readonly maxAttempts: number;
  private readonly analyzer: FailureAnalyzer;
  private readonly planner: Planner;
  private readonly onDelta?: (text: string) => void;

  constructor(
    private readonly loop: AgentLoop,
    private readonly trace: TraceCollector,
    private readonly workspace: Workspace,
    private readonly verifier = new WorkspaceCompletionVerifier(),
    options: HarnessOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.analyzer = options.analyzer ?? new FailureAnalyzer();
    this.planner = options.planner ?? new RecoveryPlanner();
    this.onDelta = options.onDelta;
  }

  async run(task: Task): Promise<HarnessRun> {
    const runId = randomUUID();
    const startedAt = process.hrtime.bigint();
    const attempts: AttemptSnapshot[] = [];
    let lastFailure: Failure | undefined;
    let lastRecovery: RecoveryPlan | undefined;

    this.trace.record(runId, 0, "run_started", {
      taskId: task.id,
      description: task.description,
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.trace.record(runId, 0, "attempt_started", { attempt });
      const attemptStart = this.trace.getEvents().length;

      const result = await this.loop.run(task, runId, {
        attempt,
        lastFailure,
        lastRecovery,
        workspace: this.workspace,
        onDelta: this.onDelta,
      });

      const attemptEvents = this.trace.getEvents().slice(attemptStart);
      const verification = this.verifier.verify(
        task,
        result,
        attemptEvents,
        this.workspace,
      );

      this.trace.record(runId, result.steps, "verification", {
        attempt,
        status: verification.status,
        prematureCompletion: verification.prematureCompletion,
        checks: verification.checks,
      });

      if (verification.status === "pass") {
        attempts.push({ attempt, result, verification });
        return this.finish(runId, result, verification, attempts, startedAt);
      }

      const failure = this.analyzer.analyze(result, verification, attemptEvents);
      if (failure) {
        this.trace.record(runId, result.steps, "failure", {
          attempt,
          type: failure.type,
          rootCause: failure.rootCause,
        });
      }

      const recovery = failure
        ? this.planner.plan(failure)
        : { action: "stop" as const, reason: "无法分类，停止" };

      this.trace.record(runId, result.steps, "recovery", {
        attempt,
        action: recovery.action,
        reason: recovery.reason,
      });

      attempts.push({
        attempt,
        result,
        verification,
        failure: failure ?? undefined,
        recovery,
      });

      if (recovery.action === "stop" || attempt === this.maxAttempts) {
        return this.finish(
          runId,
          result,
          verification,
          attempts,
          startedAt,
          failure ?? undefined,
          recovery,
        );
      }

      this.applyRecovery(recovery);
      lastFailure = failure ?? undefined;
      lastRecovery = recovery;
    }

    const last = attempts.at(-1);
    if (!last) {
      throw new Error("Harness 没有产生任何 attempt");
    }

    return this.finish(
      runId,
      last.result,
      last.verification,
      attempts,
      startedAt,
      last.failure,
      last.recovery,
    );
  }

  private applyRecovery(plan: RecoveryPlan): void {
    if (plan.resetWorkspace) {
      this.workspace.clearFiles();
    }
    if (plan.action === "change_retrieval_strategy") {
      this.workspace.retrievalStrategy = "hybrid";
    }
  }

  private finish(
    runId: string,
    result: AgentResult,
    verification: VerificationResult,
    attempts: AttemptSnapshot[],
    startedAt: bigint,
    failure?: Failure,
    recovery?: RecoveryPlan,
  ): HarnessRun {
    const trace = this.trace.getEvents().filter((event) => event.runId === runId);
    return {
      runId,
      result,
      verification,
      failure,
      recovery,
      attempts,
      recoveryCount: Math.max(0, attempts.length - 1),
      trace,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      modelCalls: trace.filter((event) => event.type === "model_call").length,
      toolCalls: trace.filter((event) => event.type === "tool_call").length,
    };
  }
}
