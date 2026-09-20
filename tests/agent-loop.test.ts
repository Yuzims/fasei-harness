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

    return {
      type: "final",
      message: "计算完成",
      claims: [{ text: "1 + 1 = 2", polarity: "resolved" }],
    };
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
  assert.deepEqual(result.claims, [{ text: "1 + 1 = 2", polarity: "resolved" }]);
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

test("Loop：illegal investigation action terminals without executing the tool", async () => {
  let executed = 0;
  let decides = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "github_get_issue",
    description: "spy issue tool",
    async execute() {
      executed += 1;
      return { ok: true };
    },
  });
  const model: Model = {
    async decide(): Promise<ModelResponse> {
      decides += 1;
      return {
        type: "tool_call",
        call: {
          id: "illegal-issue",
          name: "github_get_issue",
          arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        },
      };
    },
  };
  const trace = new TraceCollector();
  const loop = new AgentLoop(model, tools, trace, 8);
  const result = await loop.run(
    { id: "inv", description: "Investigate" },
    "run-illegal",
    {
      attempt: 1,
      legalInvestigationActions: [
        { tool: "github_list_commits", arguments: { owner: "acme", repo: "box" } },
      ],
    },
  );

  assert.equal(executed, 0);
  assert.equal(decides, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.decision, "illegal_investigation_action");
  assert.equal(
    trace.getEvents().some((event) => event.type === "illegal_investigation_action_rejected"),
    true,
  );
  assert.equal(
    trace.getEvents().some((event) => event.type === "investigation_blocked"),
    true,
  );
});

test("Loop：gap_closed is not an Agent final", async () => {
  const loop = new AgentLoop(
    {
      async decide(): Promise<ModelResponse> {
        return {
          type: "investigation_blocked",
          code: "GAP_CLOSED",
          reason: "Harness stopped: current evidence is sufficient to end investigation. Independent verification will judge completion.",
          legalTools: [],
        };
      },
    },
    new ToolRegistry(),
    new TraceCollector(),
  );
  const result = await loop.run({ id: "closed", description: "Investigate" }, "run-closed");
  assert.equal(result.status, "failed");
  assert.equal(result.decision, "gap_closed");
  assert.notEqual(result.decision, "final");
  assert.notEqual(result.decision, "strategy_exhausted");
  assert.notEqual(result.status, "completed");
});

test("Loop：gap_unresolvable is not an Agent final", async () => {
  const loop = new AgentLoop(
    {
      async decide(): Promise<ModelResponse> {
        return {
          type: "investigation_blocked",
          code: "GAP_OPEN_UNRESOLVABLE",
          reason: "Harness stopped: remaining evidence gap cannot be closed by current investigation actions. Not verified.",
          legalTools: [],
        };
      },
    },
    new ToolRegistry(),
    new TraceCollector(),
  );
  const result = await loop.run({ id: "unresolvable", description: "Investigate" }, "run-unresolvable");
  assert.equal(result.status, "failed");
  assert.equal(result.decision, "gap_unresolvable");
  assert.notEqual(result.decision, "final");
  assert.notEqual(result.status, "completed");
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
