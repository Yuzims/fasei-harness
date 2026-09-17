import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../src/agent/agent-loop.js";
import { PrematureCompletionModel } from "../src/agent/premature-model.js";
import { WorkspaceCompletionVerifier } from "../src/verification/completion-verifier.js";
import { Harness } from "../src/core/harness.js";
import { GenericRetryPlanner } from "../src/eval/generic-retry-planner.js";
import { RecoveryPlanner } from "../src/legacy/recovery/recovery-planner.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createWriteJsonTool } from "../src/tools/write-json.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { Workspace } from "../src/core/workspace.js";
import type { Task } from "../src/core/types.js";

const task: Task = {
  id: "products",
  description: "创建 result.json，里面必须有 5 个商品。",
  expected: { file: "result.json", itemCount: 5 },
};

function itemCount(workspace: Workspace): number {
  const raw = workspace.readFile("result.json");
  if (!raw) {
    return 0;
  }
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.length : 0;
}

test("Harness：对症恢复保留已写的 3 条，下一轮补到 5 条", async () => {
  const workspace = new Workspace();
  const tools = new ToolRegistry();
  tools.register(createWriteJsonTool(workspace));
  const trace = new TraceCollector();
  const harness = new Harness(
    new AgentLoop(new PrematureCompletionModel(), tools, trace),
    trace,
    workspace,
    new WorkspaceCompletionVerifier(),
    { planner: new RecoveryPlanner() },
  );

  const run = await harness.run(task);
  assert.equal(run.verification.status, "pass");
  assert.equal(itemCount(workspace), 5);
  assert.equal(run.attempts[0]?.failure?.type, "premature_completion");
});

test("Harness：盲重试会清空工作区，懒模型再次只写 3 条", async () => {
  const workspace = new Workspace();
  const tools = new ToolRegistry();
  tools.register(createWriteJsonTool(workspace));
  const trace = new TraceCollector();
  const harness = new Harness(
    new AgentLoop(new PrematureCompletionModel(), tools, trace),
    trace,
    workspace,
    new WorkspaceCompletionVerifier(),
    { planner: new GenericRetryPlanner() },
  );

  const run = await harness.run(task);
  assert.equal(run.verification.status, "fail");
  assert.equal(itemCount(workspace), 3);
  assert.equal(
    run.attempts.every((item) => item.verification.status === "fail"),
    true,
  );
});
