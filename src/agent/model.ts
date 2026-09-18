import type { Task, ToolCall, ToolResult } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import type { FailureEvent, InvestigationStrategy, RecoveryPlan } from "../domain/types.js";
import type { Failure } from "../legacy/failure/failure-types.js";
import type { RecoveryPlan as WorkspaceRecoveryPlan } from "../legacy/recovery/recovery-planner.js";
import type { LlmRuntimeGuard } from "./llm-runtime.js";

export type ModelResponse =
  | { type: "tool_call"; call: ToolCall }
  | { type: "final"; message: string };

export type HistoryRole = "user" | "assistant" | "tool";

export interface HistoryMessage {
  role: HistoryRole;
  content: string;
}

export interface ModelContext {
  attempt: number;
  /** AgentLoop step within the current attempt. Distinct from callIndex. */
  agentStep?: number;
  lastFailure?: Failure;
  lastRecovery?: WorkspaceRecoveryPlan;
  investigationFailure?: FailureEvent;
  investigationRecovery?: RecoveryPlan;
  investigationStrategy?: InvestigationStrategy;
  workspace?: Workspace;
  onDelta?: (text: string) => void;
  /** Investigation-owned LLM abort signal; OpenAICompatModel must pass this to fetch(). */
  signal?: AbortSignal;
  llmRuntime?: LlmRuntimeGuard;
}

export interface Model {
  decide(
    task: Task,
    history: HistoryMessage[],
    toolResults: ToolResult[],
    context?: ModelContext,
  ): Promise<ModelResponse>;
}
