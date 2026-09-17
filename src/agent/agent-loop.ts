import type { AgentResult, Task, ToolCall, ToolResult } from "../core/types.js";
import type { HistoryMessage, Model, ModelContext } from "./model.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TraceCollector } from "../trace/trace-collector.js";

/** AgentLoop emits this output when the step budget is exhausted. */
export const MAX_STEPS_REACHED = "Maximum step limit reached.";

export class AgentLoop {
  constructor(
    private readonly model: Model,
    private readonly tools: ToolRegistry,
    private readonly trace: TraceCollector,
    private readonly maxSteps = 10,
  ) {}

  async run(
    task: Task,
    runId: string,
    context: ModelContext = { attempt: 1 },
  ): Promise<AgentResult> {
    const history: HistoryMessage[] = [
      { role: "user", content: task.description },
    ];
    const toolResults: ToolResult[] = [];

    for (let step = 1; step <= this.maxSteps; step++) {
      this.trace.record(runId, step, "model_call", {
        attempt: context.attempt,
        task: task.description,
        historyLength: history.length,
      });

      const response = await this.model.decide(
        task,
        history,
        toolResults,
        context,
      );

      if (response.type === "final") {
        history.push({ role: "assistant", content: response.message });
        this.trace.record(runId, step, "run_completed", {
          attempt: context.attempt,
          message: response.message,
          historyLength: history.length,
        });

        return {
          status: "completed",
          output: response.message,
          steps: step,
        };
      }

      const { call } = response;
      history.push({
        role: "assistant",
        content: serializeToolCall(call),
      });

      this.trace.record(runId, step, "tool_call", {
        attempt: context.attempt,
        tool: call.name,
        arguments: call.arguments,
        historyLength: history.length,
      });

      const result = await this.executeTool(call);
      toolResults.push(result);
      history.push({
        role: "tool",
        content: serializeToolResult(result),
      });

      this.trace.record(runId, step, "tool_result", {
        attempt: context.attempt,
        callId: result.callId,
        success: result.success,
        output: result.output,
        error: result.error,
        historyLength: history.length,
      });
    }

    return {
      status: "failed",
      output: MAX_STEPS_REACHED,
      steps: this.maxSteps,
    };
  }

  private async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      return {
        callId: call.id,
        success: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    try {
      const output = await tool.execute(call.arguments);
      return {
        callId: call.id,
        success: true,
        output,
      };
    } catch (error) {
      return {
        callId: call.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function serializeToolCall(call: ToolCall): string {
  return JSON.stringify({
    id: call.id,
    tool: call.name,
    arguments: call.arguments,
  });
}

function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    callId: result.callId,
    success: result.success,
    output: result.output,
    error: result.error,
  });
}
