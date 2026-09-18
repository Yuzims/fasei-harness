import type { Task, ToolCall, ToolResult } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import type { FailureEvent, InvestigationStrategy, RecoveryPlan } from "../domain/types.js";
import type { Failure } from "../legacy/failure/failure-types.js";
import type { RecoveryPlan as WorkspaceRecoveryPlan } from "../legacy/recovery/recovery-planner.js";

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
  lastFailure?: Failure;
  lastRecovery?: WorkspaceRecoveryPlan;
  investigationFailure?: FailureEvent;
  investigationRecovery?: RecoveryPlan;
  investigationStrategy?: InvestigationStrategy;
  workspace?: Workspace;
  onDelta?: (text: string) => void;
}

export interface Model {
  decide(
    task: Task,
    history: HistoryMessage[],
    toolResults: ToolResult[],
    context?: ModelContext,
  ): Promise<ModelResponse>;
}
