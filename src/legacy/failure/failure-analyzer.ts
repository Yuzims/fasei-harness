/**
 * Legacy workspace FailureAnalyzer.
 *
 * Legacy Failure Injection ≠ Investigation Recovery
 *
 * Product analyzer: src/investigation/failure-analyzer.ts
 */
import { MAX_STEPS_REACHED } from "../../agent/agent-loop.js";
import type { AgentResult } from "../../core/types.js";
import type { Failure } from "./failure-types.js";
import type { TraceEvent } from "../../trace/trace-collector.js";
import type { VerificationResult } from "../../verification/types.js";

export class FailureAnalyzer {
  analyze(
    result: AgentResult,
    verification: VerificationResult,
    events: TraceEvent[],
  ): Failure | null {
    if (verification.status === "pass") {
      return null;
    }

    const toolCheck = verification.checks.find(
      (item) => item.name === "tool_result" && !item.passed,
    );
    if (toolCheck) {
      const failed = events.filter(
        (event) => event.type === "tool_result" && event.data.success === false,
      );
      return {
        type: "tool_failure",
        rootCause: "tool_result_failed",
        evidence: failed.map((event) => event.data),
      };
    }

    const citationCheck = verification.checks.find(
      (item) => item.name === "citation" && !item.passed,
    );
    if (citationCheck) {
      return {
        type: "retrieval_failure",
        rootCause: "evidence_unused",
        evidence: [citationCheck],
      };
    }

    const evidenceCheck = verification.checks.find(
      (item) => item.name === "evidence" && !item.passed,
    );
    if (evidenceCheck) {
      return {
        type: "retrieval_failure",
        rootCause: "recall_insufficient",
        evidence: [evidenceCheck],
      };
    }

    if (verification.prematureCompletion) {
      const countCheck = verification.checks.find((item) => item.name === "count");
      return {
        type: "premature_completion",
        rootCause: "agent_claimed_success_but_outcome_unmet",
        evidence: [
          result.output,
          countCheck ??
            verification.checks.find((item) => item.name === "file_exists"),
        ],
      };
    }

    const toolCalls = events.filter((event) => event.type === "tool_call");
    const repeated =
      toolCalls.length >= 4 &&
      toolCalls.every((event) => event.data.tool === toolCalls[0]?.data.tool);

    if (result.output === MAX_STEPS_REACHED || repeated) {
      return {
        type: "loop_failure",
        rootCause: repeated ? "repeated_tool_call" : "step_budget_exceeded",
        evidence: toolCalls.map((event) => event.data.tool),
      };
    }

    return {
      type: "unknown",
      rootCause: "unclassified_verification_failure",
      evidence: verification.checks.filter((item) => !item.passed),
    };
  }
}
