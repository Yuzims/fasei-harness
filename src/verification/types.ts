/**
 * Workspace verification types for synthetic file/count/citation demos.
 * Not the investigation domain VerificationResult in src/domain/types.ts.
 */
import type { AgentResult, Task } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import type { TraceEvent } from "../trace/trace-collector.js";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
}

export interface VerificationResult {
  status: "pass" | "fail";
  checks: VerificationCheck[];
  // Agent 说做完了，但文件/数量这类客观检查没过
  prematureCompletion: boolean;
}

export interface VerifyContext {
  task: Task;
  result: AgentResult;
  events: TraceEvent[];
  workspace: Workspace;
}

export interface Check {
  name: string;
  run(ctx: VerifyContext): VerificationCheck | null;
}
