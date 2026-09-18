import type {
  FailureType,
  RecoveryAction,
  RecoveryPlan,
} from "./types.js";

/** Hard caps so recovery cannot loop forever. */
export const RECOVERY_BOUNDS = {
  maxInvestigationAttempts: 3,
  maxRecoveryAttempts: 3,
  maxToolRetries: 2,
} as const;

export type RecoveryBounds = {
  maxInvestigationAttempts: number;
  maxRecoveryAttempts: number;
  maxToolRetries: number;
};

const NON_RETRYABLE_TOOL_CODES = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_argument",
  "malformed_response",
  "invalid_snapshot",
]);

const RETRYABLE_TOOL_CODES = new Set([
  "timeout",
  "rate_limited",
  "server_error",
  "network_error",
]);

export function isRetryableToolCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  if (NON_RETRYABLE_TOOL_CODES.has(code)) {
    return false;
  }
  return RETRYABLE_TOOL_CODES.has(code);
}

const POLICY: Record<FailureType, Omit<RecoveryPlan, "reason"> & { reason: string }> = {
  tool_failure: {
    action: "retry_with_backoff",
    reason: "工具失败，有限次退避重试，不清空已收集证据",
    resetEvidence: false,
  },
  retrieval_failure: {
    action: "change_retrieval_strategy",
    reason: "检索失败，换策略或收紧查询，而不是原查询重放",
    resetEvidence: false,
  },
  premature_completion: {
    action: "continue_investigation",
    reason: "Agent 声称完成但验证未过，保留证据继续调查",
    resetEvidence: false,
  },
  loop_failure: {
    action: "stop",
    reason: "调查在原地打转，停止以免无脑重试",
  },
  insufficient_evidence: {
    action: "gather_missing_evidence",
    reason: "关键证据不足，只补采集缺失类型",
    resetEvidence: false,
  },
  invalid_evidence: {
    action: "revalidate_evidence",
    reason: "证据无法支撑 Claim，断开无效边并复核",
    resetEvidence: false,
  },
  wrong_target: {
    action: "recheck_target",
    reason: "仓库或 Issue 身份不对，丢掉当前证据图后重解析",
    resetEvidence: true,
  },
  runtime_budget_exceeded: {
    action: "stop",
    reason: "LLM runtime budget exceeded; stop so recovery cannot start another LLM call",
  },
  unknown: {
    action: "stop",
    reason: "无法分类，停止以免统一重试",
  },
};

export function recoveryActionFor(type: FailureType): RecoveryAction {
  return POLICY[type].action;
}

export function planRecovery(type: FailureType): RecoveryPlan {
  return { ...POLICY[type] };
}
