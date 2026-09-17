import type { Task, ToolCall, ToolResult } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import type { FailureEvent, RecoveryPlan as InvestigationRecoveryPlan } from "../domain/types.js";
import type { Failure } from "../failure/failure-types.js";
import type { RecoveryPlan } from "../recovery/recovery-planner.js";

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
  lastRecovery?: RecoveryPlan;
  investigationFailure?: FailureEvent;
  investigationRecovery?: InvestigationRecoveryPlan;
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
