import { AgentLoop } from "../src/agent/agent-loop.js";
import { WorkspaceCompletionVerifier } from "../src/verification/completion-verifier.js";
import { Harness, type HarnessRun } from "../src/core/harness.js";
import { Workspace } from "../src/core/workspace.js";
import { allCases } from "../src/eval/cases.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { writeTraceReport } from "../src/trace/html-report.js";
import { resolve } from "node:path";

function printRun(title: string, run: HarnessRun) {
  console.log(`\n======== ${title} ========`);
  for (const snapshot of run.attempts) {
    console.log(`\n第 ${snapshot.attempt} 次`);
    console.log(`  Agent: ${String(snapshot.result.output)}`);
    console.log(`  Verifier: ${snapshot.verification.status}`);
    for (const check of snapshot.verification.checks) {
      console.log(
        `    - ${check.name}: ${check.passed ? "PASS" : "FAIL"} ${check.reason ?? ""}`,
      );
    }
    if (snapshot.failure) {
      console.log(
        `  Analyzer: ${snapshot.failure.type} (${snapshot.failure.rootCause})`,
      );
    }
    if (snapshot.recovery) {
      console.log(
        `  Recovery: ${snapshot.recovery.action} — ${snapshot.recovery.reason}`,
      );
    }
  }
  console.log(
    `\n最终: verifier=${run.verification.status} recoveryCount=${run.recoveryCount}`,
  );
}

async function runScenario() {
  const results = [];

  for (const item of allCases()) {
    const workspace = new Workspace();
    const tools = new ToolRegistry();
    item.registerTools(tools, workspace);
    const trace = new TraceCollector();
    const loop = new AgentLoop(item.createModel(), tools, trace, item.maxSteps ?? 10);
    const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier());
    const run = await harness.run(item.task);
    printRun(item.title, run);
    results.push({ item, run });
  }

  const ok = results.every(({ item, run }) => {
    const firstType = run.attempts[0]?.failure?.type;
    const passed = run.verification.status === "pass";
    return firstType === item.expectedFailure && passed === item.shouldFinallyPass;
  });

  if (!ok) {
    throw new Error("完整主线没有按预期跑完");
  }

  const reportPath = writeTraceReport(
    resolve("reports", "mainline.html"),
    "Failure-Aware 主线 Trace",
    results.map(({ item, run }) => ({ title: item.title, run })),
  );

  console.log(
    "\n完整主线已跑通：提前完成会补全，工具失败会重试，检索失败会换 BM25 hybrid，循环失败会停止。",
  );
  console.log(`Trace 报告：${reportPath}`);
}

await runScenario();
