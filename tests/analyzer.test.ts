/**
 * Legacy workspace FailureAnalyzer tests.
 * Product analyzer tests: tests/investigation-recovery.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FailureAnalyzer } from "../src/legacy/failure/failure-analyzer.js";
import { MAX_STEPS_REACHED } from "../src/agent/agent-loop.js";
import type { TraceEvent } from "../src/trace/trace-collector.js";
import type { AgentResult } from "../src/core/types.js";
import type { VerificationResult } from "../src/verification/types.js";

function event(
  type: TraceEvent["type"],
  data: Record<string, unknown>,
): TraceEvent {
  return {
    id: "e",
    runId: "r",
    step: 1,
    timestamp: 0,
    type,
    data,
  };
}

const analyzer = new FailureAnalyzer();
const failedResult: AgentResult = { status: "completed", output: "done", steps: 2 };

test("Analyzer：工具结果失败 → tool_failure", () => {
  const verification: VerificationResult = {
    status: "fail",
    prematureCompletion: false,
    checks: [{ name: "tool_result", passed: false, reason: "工具失败" }],
  };
  const failure = analyzer.analyze(failedResult, verification, [
    event("tool_result", { success: false, error: "temporary write failure" }),
  ]);
  assert.equal(failure?.type, "tool_failure");
});

test("Analyzer：召回不足 → retrieval_failure / recall_insufficient", () => {
  const verification: VerificationResult = {
    status: "fail",
    prematureCompletion: false,
    checks: [{ name: "evidence", passed: false, reason: "相关文档不足" }],
  };
  const failure = analyzer.analyze(failedResult, verification, []);
  assert.equal(failure?.type, "retrieval_failure");
  assert.equal(failure?.rootCause, "recall_insufficient");
});

test("Analyzer：召回够但终答没引用 → retrieval_failure / evidence_unused", () => {
  const verification: VerificationResult = {
    status: "fail",
    prematureCompletion: false,
    checks: [
      { name: "evidence", passed: true, reason: "相关文档 3 条" },
      { name: "citation", passed: false, reason: "终答未引用" },
    ],
  };
  const failure = analyzer.analyze(failedResult, verification, []);
  assert.equal(failure?.type, "retrieval_failure");
  assert.equal(failure?.rootCause, "evidence_unused");
});

test("Analyzer：Verifier 标了提前完成 → premature_completion", () => {
  const verification: VerificationResult = {
    status: "fail",
    prematureCompletion: true,
    checks: [{ name: "count", passed: false, expected: 5, actual: 3 }],
  };
  const failure = analyzer.analyze(failedResult, verification, []);
  assert.equal(failure?.type, "premature_completion");
  assert.equal(failure?.rootCause, "agent_claimed_success_but_outcome_unmet");
});

test("Analyzer：步数耗尽 → loop_failure", () => {
  const verification: VerificationResult = {
    status: "fail",
    prematureCompletion: false,
    checks: [{ name: "agent_status", passed: false }],
  };
  const failure = analyzer.analyze(
    { status: "failed", output: MAX_STEPS_REACHED, steps: 4 },
    verification,
    [
      event("tool_call", { tool: "calculator" }),
      event("tool_call", { tool: "calculator" }),
      event("tool_call", { tool: "calculator" }),
      event("tool_call", { tool: "calculator" }),
    ],
  );
  assert.equal(failure?.type, "loop_failure");
});

test("Analyzer：Verifier 通过时不归因", () => {
  const verification: VerificationResult = {
    status: "pass",
    prematureCompletion: false,
    checks: [],
  };
  assert.equal(analyzer.analyze(failedResult, verification, []), null);
});
