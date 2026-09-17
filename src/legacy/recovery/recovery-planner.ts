/**
 * Legacy workspace RecoveryPlanner.
 *
 * Legacy Failure Injection ≠ Investigation Recovery
 *
 * Product planner: src/investigation/recovery-planner.ts
 */
import type { Failure } from "../failure/failure-types.js";

export type RecoveryAction =
  | "retry_tool"
  | "continue_execution"
  | "change_retrieval_strategy"
  | "stop";

export interface RecoveryPlan {
  action: RecoveryAction;
  reason: string;
  resetWorkspace?: boolean;
}

export interface Planner {
  plan(failure: Failure): RecoveryPlan;
}

export class RecoveryPlanner implements Planner {
  plan(failure: Failure): RecoveryPlan {
    switch (failure.type) {
      case "premature_completion":
        return {
          action: "continue_execution",
          reason: "产物不够，保留工作区继续补全，而不是从头重跑",
          resetWorkspace: false,
        };
      case "tool_failure":
        return {
          action: "retry_tool",
          reason: "工具失败，按原任务再试一次",
          resetWorkspace: false,
        };
      case "retrieval_failure":
        return {
          action: "change_retrieval_strategy",
          reason: "召回不足，改用 BM25 召回再 TF-IDF 重排",
          resetWorkspace: false,
        };
      case "loop_failure":
        return {
          action: "stop",
          reason: "已经在原地打转，再 Retry 只会烧步数",
        };
      default:
        return {
          action: "stop",
          reason: "没有对应恢复策略，停止以免无脑重试",
        };
    }
  }
}
