import { AgentLoop } from "../agent/agent-loop.js";
import { WorkspaceCompletionVerifier } from "../verification/completion-verifier.js";
import { Harness, type HarnessRun } from "../core/harness.js";
import { RecoveryPlanner } from "../legacy/recovery/recovery-planner.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { Workspace } from "../core/workspace.js";
import { allCases, type ScenarioCase } from "./cases.js";
import { GenericRetryPlanner } from "./generic-retry-planner.js";

export type BenchmarkMode = "baseline" | "generic_retry" | "failure_aware";

export interface CaseScore {
  id: string;
  title: string;
  mode: BenchmarkMode;
  verifierPass: boolean;
  falseCompletion: boolean;
  recovered: boolean;
  attempts: number;
  modelCalls: number;
  toolCalls: number;
  latencyMs: number;
  firstFailure?: string;
}

export interface ModeScore {
  mode: BenchmarkMode;
  cases: CaseScore[];
  successRate: number;
  falseCompletionRate: number;
  recoveryRate: number;
  avgAttempts: number;
  avgModelCalls: number;
  avgToolCalls: number;
  avgLatencyMs: number;
}

function scoreRun(mode: BenchmarkMode, item: ScenarioCase, run: HarnessRun): CaseScore {
  const first = run.attempts[0];
  const agentSaidDone = run.result.status === "completed";
  const verifierPass = run.verification.status === "pass";

  return {
    id: item.id,
    title: item.title,
    mode,
    verifierPass,
    falseCompletion: agentSaidDone && !verifierPass,
    recovered: (first?.verification.status === "fail" && verifierPass) || false,
    attempts: run.attempts.length,
    modelCalls: run.modelCalls,
    toolCalls: run.toolCalls,
    latencyMs: run.latencyMs,
    firstFailure: first?.failure?.type,
  };
}

export async function executeCase(
  item: ScenarioCase,
  mode: BenchmarkMode,
): Promise<HarnessRun> {
  const workspace = new Workspace();
  const tools = new ToolRegistry();
  item.registerTools(tools, workspace);
  const trace = new TraceCollector();
  const loop = new AgentLoop(item.createModel(), tools, trace, item.maxSteps ?? 10);

  const maxAttempts = mode === "baseline" ? 1 : 3;
  const planner =
    mode === "generic_retry" ? new GenericRetryPlanner() : new RecoveryPlanner();

  const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier(), {
    maxAttempts,
    planner,
  });

  return harness.run(item.task);
}

async function runCase(
  item: ScenarioCase,
  mode: BenchmarkMode,
): Promise<CaseScore> {
  const run = await executeCase(item, mode);
  return scoreRun(mode, item, run);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function summarize(mode: BenchmarkMode, cases: CaseScore[]): ModeScore {
  const failedFirst = cases.filter((item) => item.firstFailure);
  const recovered = cases.filter((item) => item.recovered).length;

  return {
    mode,
    cases,
    successRate: cases.filter((item) => item.verifierPass).length / cases.length,
    falseCompletionRate:
      cases.filter((item) => item.falseCompletion).length / cases.length,
    recoveryRate: failedFirst.length === 0 ? 0 : recovered / failedFirst.length,
    avgAttempts: mean(cases.map((item) => item.attempts)),
    avgModelCalls: mean(cases.map((item) => item.modelCalls)),
    avgToolCalls: mean(cases.map((item) => item.toolCalls)),
    avgLatencyMs: mean(cases.map((item) => item.latencyMs)),
  };
}

export async function runBenchmark(cases: ScenarioCase[] = allCases()) {
  const modes: BenchmarkMode[] = ["baseline", "generic_retry", "failure_aware"];
  const results: ModeScore[] = [];

  for (const mode of modes) {
    const scores: CaseScore[] = [];
    for (const item of cases) {
      scores.push(await runCase(item, mode));
    }
    results.push(summarize(mode, scores));
  }

  return results;
}

export function assertBenchmark(results: ModeScore[]): void {
  const aware = results.find((row) => row.mode === "failure_aware");
  const baseline = results.find((row) => row.mode === "baseline");
  const generic = results.find((row) => row.mode === "generic_retry");

  if (!aware || !baseline || !generic) {
    throw new Error("benchmark 结果不完整");
  }

  if (!(aware.successRate > baseline.successRate && aware.successRate > generic.successRate)) {
    throw new Error("对症恢复的成功率应该高于 Baseline 和盲重试");
  }

  if (!(aware.falseCompletionRate < baseline.falseCompletionRate)) {
    throw new Error("对症恢复的误完成率应该低于 Baseline");
  }

  const loopAware = aware.cases.find((item) => item.id === "loop");
  const loopGeneric = generic.cases.find((item) => item.id === "loop");
  if (!loopAware || !loopGeneric) {
    throw new Error("缺少 loop 用例");
  }

  if (!(loopAware.modelCalls < loopGeneric.modelCalls)) {
    throw new Error("循环失败上，对症恢复的模型调用次数应该少于盲重试");
  }

  if (!(aware.avgModelCalls < generic.avgModelCalls)) {
    throw new Error("对症恢复的平均模型调用成本应该低于盲重试");
  }
}
