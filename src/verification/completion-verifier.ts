/**
 * Legacy workspace completion verifier (file / count / citation / tool-result).
 *
 * This is not the product verifier. Investigation runs use IndependentCompletionVerifier.
 *
 * WorkspaceCompletionVerifier → pass/fail (synthetic demos)
 * IndependentCompletionVerifier → verified_complete / not_verified / insufficient_evidence
 */
import type { AgentResult, Task } from "../core/types.js";
import type { Workspace } from "../core/workspace.js";
import type { TraceEvent } from "../trace/trace-collector.js";
import { CitationCheck } from "./checks/citation-check.js";
import { CountCheck } from "./checks/count-check.js";
import { EvidenceCheck } from "./checks/evidence-check.js";
import { FileExistsCheck } from "./checks/file-exists-check.js";
import { ToolResultCheck } from "./checks/tool-result-check.js";
import type { Check, VerificationCheck, VerificationResult } from "./types.js";

export class WorkspaceCompletionVerifier {
  constructor(
    private readonly checks: Check[] = [
      new FileExistsCheck(),
      new CountCheck(),
      new EvidenceCheck(),
      new CitationCheck(),
      new ToolResultCheck(),
    ],
  ) {}

  verify(
    task: Task,
    result: AgentResult,
    events: TraceEvent[],
    workspace: Workspace,
  ): VerificationResult {
    const ctx = { task, result, events, workspace };
    const checks: VerificationCheck[] = [];

    if (result.status === "failed") {
      checks.push({
        name: "agent_status",
        passed: false,
        expected: "completed",
        actual: result.status,
        reason: String(result.output ?? "agent failed"),
      });
    }

    for (const check of this.checks) {
      const item = check.run(ctx);
      if (item) {
        checks.push(item);
      }
    }

    const status = checks.every((item) => item.passed) ? "pass" : "fail";
    const outcomeFailed = checks.some(
      (item) =>
        !item.passed && (item.name === "file_exists" || item.name === "count"),
    );
    const toolsPassed = !checks.some(
      (item) => item.name === "tool_result" && !item.passed,
    );

    return {
      status,
      checks,
      // 工具都成功了，Agent 还说完成，但产物不对，才叫提前完成
      prematureCompletion:
        result.status === "completed" && outcomeFailed && toolsPassed,
    };
  }
}
