/**
 * Legacy workspace recovery injection tests.
 * Product recovery tests: tests/investigation-recovery.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryPlanner } from "../src/legacy/recovery/recovery-planner.js";
import { GenericRetryPlanner } from "../src/eval/generic-retry-planner.js";
import type { Failure, FailureType } from "../src/legacy/failure/failure-types.js";

function failure(type: FailureType): Failure {
  return { type, rootCause: type, evidence: [] };
}

const planner = new RecoveryPlanner();

test("Recovery：提前完成保留工作区", () => {
  const plan = planner.plan(failure("premature_completion"));
  assert.equal(plan.action, "continue_execution");
  assert.equal(plan.resetWorkspace, false);
});

test("Recovery：工具失败 → retry_tool", () => {
  assert.equal(planner.plan(failure("tool_failure")).action, "retry_tool");
});

test("Recovery：检索失败 → change_retrieval_strategy", () => {
  assert.equal(
    planner.plan(failure("retrieval_failure")).action,
    "change_retrieval_strategy",
  );
});

test("Recovery：循环失败 → stop", () => {
  assert.equal(planner.plan(failure("loop_failure")).action, "stop");
});

test("Recovery：未知失败 → stop，避免无脑重试", () => {
  assert.equal(planner.plan(failure("unknown")).action, "stop");
});

test("盲重试：不管什么失败都 retry_tool 并清空工作区", () => {
  const generic = new GenericRetryPlanner();
  for (const type of [
    "premature_completion",
    "tool_failure",
    "retrieval_failure",
    "loop_failure",
  ] as const) {
    const plan = generic.plan(failure(type));
    assert.equal(plan.action, "retry_tool");
    assert.equal(plan.resetWorkspace, true);
  }
});
