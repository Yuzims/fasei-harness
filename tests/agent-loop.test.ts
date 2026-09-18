import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../src/agent/agent-loop.js";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { calculatorTool } from "../src/tools/calculator.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import type { Task, ToolResult } from "../src/core/types.js";

class HistorySpyModel implements Model {
  snapshots: HistoryMessage[][] = [];

  async decide(
    _task: Task,
    history: HistoryMessage[],
    toolResults: ToolResult[],
  ): Promise<ModelResponse> {
    this.snapshots.push(history.map((item) => ({ ...item })));

    if (toolResults.length === 0) {
      return {
        type: "tool_call",
        call: {
          id: "call-1",
          name: "calculator",
          arguments: { expression: "1 + 1" },
        },
      };
    }

    return { type: "final", message: "计算完成" };
  }
}

test("Loop：把 user / assistant(tool_call) / tool 写回下一轮 decide", async () => {
  const spy = new HistorySpyModel();
  const tools = new ToolRegistry();
  tools.register(calculatorTool);
  const loop = new AgentLoop(spy, tools, new TraceCollector());
  const result = await loop.run(
    { id: "calc", description: "计算 1 + 1" },
    "run-1",
  );

  assert.equal(result.status, "completed");
  assert.equal(spy.snapshots.length, 2);

  const first = spy.snapshots[0]!;
  assert.equal(first[0]?.role, "user");
  assert.equal(first[0]?.content, "计算 1 + 1");

  const second = spy.snapshots[1]!;
  assert.equal(second.some((item) => item.role === "assistant"), true);
  assert.equal(second.some((item) => item.role === "tool"), true);
  assert.match(
    second.find((item) => item.role === "tool")?.content ?? "",
    /success":true/,
  );
});

test("Loop：model_call trace 带上 historyLength", async () => {
  const spy = new HistorySpyModel();
  const tools = new ToolRegistry();
  tools.register(calculatorTool);
  const trace = new TraceCollector();
  const loop = new AgentLoop(spy, tools, trace);
  await loop.run({ id: "calc", description: "计算 1 + 1" }, "run-2");

  const modelCalls = trace
    .getEvents()
    .filter((event) => event.type === "model_call");
  assert.equal(modelCalls[0]?.data.historyLength, 1);
  assert.ok(Number(modelCalls[1]?.data.historyLength) > 1);
  assert.equal(modelCalls[0]?.data.agentStep, 1);
  assert.equal(modelCalls[1]?.data.agentStep, 2);
});
