import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceCompletionVerifier } from "../src/verification/completion-verifier.js";
import { Workspace } from "../src/core/workspace.js";
import type { TraceEvent } from "../src/trace/trace-collector.js";
import type { AgentResult, Task } from "../src/core/types.js";

function event(
  type: TraceEvent["type"],
  data: Record<string, unknown>,
): TraceEvent {
  return {
    id: "e",
    runId: "r",
    step: 1,
    timestamp: 0,
    type,
    data,
  };
}

const productTask: Task = {
  id: "products",
  description: "创建 result.json，里面必须有 5 个商品。",
  expected: { file: "result.json", itemCount: 5 },
};

test("Verifier：产物数量不够时判 fail，并标成提前完成", () => {
  const workspace = new Workspace();
  workspace.writeFile(
    "result.json",
    JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
  );
  const result: AgentResult = { status: "completed", output: "已经完成", steps: 2 };
  const events = [event("tool_result", { success: true })];

  const verification = new WorkspaceCompletionVerifier().verify(
    productTask,
    result,
    events,
    workspace,
  );

  assert.equal(verification.status, "fail");
  assert.equal(verification.prematureCompletion, true);
  assert.equal(
    verification.checks.find((item) => item.name === "count")?.passed,
    false,
  );
});

test("Verifier：文件和数量都对、工具也成功时判 pass", () => {
  const workspace = new Workspace();
  workspace.writeFile("result.json", JSON.stringify([1, 2, 3, 4, 5]));
  const result: AgentResult = { status: "completed", output: "ok", steps: 2 };
  const events = [event("tool_result", { success: true })];

  const verification = new WorkspaceCompletionVerifier().verify(
    productTask,
    result,
    events,
    workspace,
  );

  assert.equal(verification.status, "pass");
  assert.equal(verification.prematureCompletion, false);
});

test("Verifier：工具失败时不叫提前完成", () => {
  const workspace = new Workspace();
  const result: AgentResult = { status: "completed", output: "已经完成", steps: 1 };
  const events = [event("tool_result", { success: false, error: "boom" })];

  const verification = new WorkspaceCompletionVerifier().verify(
    productTask,
    result,
    events,
    workspace,
  );

  assert.equal(verification.status, "fail");
  assert.equal(verification.prematureCompletion, false);
  assert.equal(
    verification.checks.find((item) => item.name === "tool_result")?.passed,
    false,
  );
});

test("Verifier：相关文档不够时 evidence 失败", () => {
  const workspace = new Workspace();
  workspace.lastRetrieval = {
    strategy: "embedding",
    hits: [
      { id: "d4", title: "天气", relevant: false },
      { id: "d5", title: "美食", relevant: false },
    ],
  };
  const task: Task = {
    id: "retrieval",
    description: "检索 Transformer",
    expected: { minRelevant: 3 },
  };
  const result: AgentResult = { status: "completed", output: "找到了", steps: 2 };
  const events = [event("tool_result", { success: true })];

  const verification = new WorkspaceCompletionVerifier().verify(
    task,
    result,
    events,
    workspace,
  );

  assert.equal(verification.status, "fail");
  assert.equal(
    verification.checks.find((item) => item.name === "evidence")?.passed,
    false,
  );
  assert.equal(
    verification.checks.find((item) => item.name === "citation"),
    undefined,
  );
});

test("Verifier：召回够但终答没引用时 citation 失败", () => {
  const workspace = new Workspace();
  workspace.lastRetrieval = {
    strategy: "hybrid",
    hits: [
      { id: "d1", title: "Attention Is All You Need", relevant: true },
      { id: "d2", title: "Transformer 架构综述", relevant: true },
      { id: "d3", title: "BERT: Pre-training of Deep Bidirectional Transformers", relevant: true },
    ],
  };
  const task: Task = {
    id: "retrieval",
    description: "检索 Transformer",
    expected: { minRelevant: 3 },
  };
  const result: AgentResult = {
    status: "completed",
    output: "已经完成，相关资料都找到了。",
    steps: 2,
  };
  const events = [event("tool_result", { success: true })];

  const verification = new WorkspaceCompletionVerifier().verify(
    task,
    result,
    events,
    workspace,
  );

  assert.equal(verification.status, "fail");
  assert.equal(
    verification.checks.find((item) => item.name === "evidence")?.passed,
    true,
  );
  assert.equal(
    verification.checks.find((item) => item.name === "citation")?.passed,
    false,
  );
});
