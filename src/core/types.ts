// 任务的客观完成条件。没有这些字段时，Verifier 只检查工具有没有报错。
export interface TaskExpectation {
  file?: string;
  itemCount?: number;
  minRelevant?: number;
  query?: string;
}

export interface Task {
  id: string;
  description: string;
  expected?: TaskExpectation;
}

/**
 * Why AgentLoop terminated.
 * Ordinary Agent finals use "final" or omit this field.
 * Investigation strategy terminals must not be treated as an Agent final answer.
 */
export type AgentLoopDecision =
  | "final"
  | "strategy_exhausted"
  | "gap_closed"
  | "gap_unresolvable"
  | "illegal_investigation_action";

export interface AgentResult {
  status: "completed" | "failed";
  output?: unknown;
  steps: number;
  decision?: AgentLoopDecision;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  success: boolean;
  output?: unknown;
  error?: string;
}
