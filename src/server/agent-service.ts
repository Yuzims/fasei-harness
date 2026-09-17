import { AgentLoop } from "../agent/agent-loop.js";
import { createModel } from "../agent/create-model.js";
import { describeLlm, readLlmConfig } from "../agent/llm-config.js";
import { WorkspaceAgentModel } from "../agent/workspace-agent.js";
import { AGENT_EXAMPLES, inferTask } from "../agent/task-intent.js";
import type { AgentSessionDTO, AgentStreamEvent } from "../api/dto.js";
import { WorkspaceCompletionVerifier } from "../verification/completion-verifier.js";
import { Harness } from "../core/harness.js";
import { RecoveryPlanner } from "../legacy/recovery/recovery-planner.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { Workspace } from "../core/workspace.js";
import { calculatorTool } from "../tools/calculator.js";
import { createWriteJsonTool } from "../tools/write-json.js";
import { createSearchTool } from "../tools/search.js";
import { LiveGitHubProvider } from "../github/live-provider.js";
import {
  createGithubReadmeTool,
  createGithubSearchTool,
  createInvestigationGithubTools,
} from "../tools/github.js";
import { toRunView } from "./serialize.js";

export function agentExamples() {
  return AGENT_EXAMPLES.map((item) => ({ ...item }));
}

type Env = Record<string, string | undefined>;

export function agentStatus(env: Env = process.env) {
  return describeLlm(env);
}

export function createProductModel(tools: ToolRegistry, env: Env = process.env) {
  const config = readLlmConfig(env);
  if (config.kind === "openai") {
    return {
      kind: "openai" as const,
      modelId: config.model,
      model: createModel({ tools: tools.list(), env }),
    };
  }
  return {
    kind: "workspace" as const,
    modelId: "workspace",
    model: new WorkspaceAgentModel(),
  };
}

export async function runAgentSession(input: {
  description: string;
  failureAware?: boolean;
  env?: Env;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}): Promise<AgentSessionDTO> {
  const description = input.description.trim();
  if (!description) {
    throw new Error("任务描述不能为空");
  }

  let writes = Promise.resolve();
  const emit = (event: AgentStreamEvent) => {
    if (!input.onEvent) {
      return;
    }
    writes = writes.then(() => Promise.resolve(input.onEvent?.(event))).then(() => undefined);
  };

  const failureAware = input.failureAware !== false;
  const task = inferTask(description);
  const workspace = new Workspace();
  const tools = new ToolRegistry();
  const github = new LiveGitHubProvider({ env: input.env });
  tools.register(createWriteJsonTool(workspace));
  tools.register(createSearchTool(workspace));
  tools.register(createGithubSearchTool(workspace, { provider: github }));
  tools.register(createGithubReadmeTool(workspace, { provider: github }));
  for (const tool of createInvestigationGithubTools({ provider: github })) {
    tools.register(tool);
  }
  tools.register(calculatorTool);

  const created = createProductModel(tools, input.env);
  const trace = new TraceCollector();
  trace.on((event) => {
    if (event.type === "tool_call") {
      emit({
        type: "tool_call",
        name: String(event.data.tool ?? ""),
        arguments:
          event.data.arguments && typeof event.data.arguments === "object"
            ? (event.data.arguments as Record<string, unknown>)
            : {},
      });
    }
    if (event.type === "tool_result") {
      emit({
        type: "tool_result",
        name: String(event.data.callId ?? ""),
        success: event.data.success !== false,
        preview: JSON.stringify(event.data.output ?? event.data.error ?? "").slice(0, 400),
      });
    }
    if (event.type === "recovery") {
      emit({
        type: "log",
        message: `恢复：${String(event.data.action ?? "")} — ${String(event.data.reason ?? "")}`,
      });
    }
  });

  emit({ type: "log", message: `开始任务 · ${created.modelId}` });

  const loop = new AgentLoop(created.model, tools, trace);
  const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier(), {
    maxAttempts: failureAware ? 3 : 1,
    planner: new RecoveryPlanner(),
    onDelta: (text) => emit({ type: "delta", text }),
  });

  const run = await harness.run(task);
  const mode = failureAware ? "failure_aware" : "baseline";

  const session = {
    task: {
      id: task.id,
      description: task.description,
      expected: task.expected,
    },
    modelKind: created.kind,
    modelId: created.modelId,
    failureAware,
    run: toRunView("agent", task.description, mode, run),
    files: workspace.listFiles(),
    retrieval: workspace.lastRetrieval
      ? {
          strategy: workspace.lastRetrieval.strategy,
          hits: workspace.lastRetrieval.hits.map((hit) => ({
            id: hit.id,
            title: hit.title,
            score: hit.score,
            relevant: hit.relevant,
          })),
        }
      : undefined,
  };
  await writes;
  return session;
}
