import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FASEI_BENCHMARK_SCENARIOS,
  FASEI_FAILURE_SCENARIOS,
  FASEI_REGRESSION_SCENARIOS,
  compareFailureModes,
  compareOutcome,
  evaluateScenarioContract,
  executeScenario,
  isFalseCompletion,
  runFaseiBenchmark,
  runScenario,
  scoreScenario,
  type BenchmarkScenario,
  type ObservedOutcome,
} from "../src/benchmark/index.js";

function observed(partial: Partial<ObservedOutcome> & Pick<ObservedOutcome, "verificationStatus">): ObservedOutcome {
  return {
    agentClaimedComplete: false,
    attemptCount: 1,
    toolCallCount: 1,
    evidenceCoverage: 0,
    unsupportedClaimRate: 0,
    failureTypes: [],
    recovered: false,
    recoveryAttempted: false,
    ...partial,
  };
}

test("Scenario classification：normal vs failure + failureMode", () => {
  const resolved = FASEI_REGRESSION_SCENARIOS.find((item) => item.id === "resolved");
  const tool = FASEI_FAILURE_SCENARIOS.find((item) => item.id === "tool-failure");
  assert.ok(resolved && tool);
  assert.equal(resolved.kind, "normal");
  assert.equal(resolved.failureMode, undefined);
  assert.equal(tool.kind, "failure");
  assert.equal(tool.failureMode, "tool_failure");
});

test("Scenario contract：expected vs observed verification", () => {
  const scenario: BenchmarkScenario = {
    id: "synthetic-gap",
    description: "synthetic verification contract",
    kind: "normal",
    fixture: "insufficient-evidence",
    target: { owner: "acme", repository: "box", issueNumber: 7 },
    expectedOutcome: { verificationStatus: "insufficient_evidence" },
  };
  assert.equal(
    evaluateScenarioContract(scenario, observed({ verificationStatus: "insufficient_evidence" })).passed,
    true,
  );
  assert.equal(
    evaluateScenarioContract(scenario, observed({ verificationStatus: "verified_complete" })).passed,
    false,
  );
  assert.equal(compareOutcome("insufficient_evidence", "insufficient_evidence"), true);
  assert.equal(compareOutcome("insufficient_evidence", "verified_complete"), false);
});

test("Scenario contract：failure mode presence and recovery requirement", () => {
  const scenario: BenchmarkScenario = {
    id: "synthetic-tool",
    description: "synthetic",
    kind: "failure",
    failureMode: "tool_failure",
    fixture: "resolved",
    target: { owner: "acme", repository: "box", issueNumber: 42 },
    expectedOutcome: {
      verificationStatus: "verified_complete",
      failureModes: ["tool_failure"],
      recovery: { required: true },
    },
  };
  assert.equal(compareFailureModes(["tool_failure"], ["tool_failure", "insufficient_evidence"]), true);
  assert.equal(compareFailureModes(["tool_failure"], ["retrieval_failure"]), false);
  assert.equal(
    evaluateScenarioContract(
      scenario,
      observed({
        verificationStatus: "verified_complete",
        failureTypes: ["tool_failure"],
        recoveryAttempted: true,
        recovered: true,
      }),
    ).passed,
    true,
  );
  assert.equal(
    evaluateScenarioContract(
      scenario,
      observed({
        verificationStatus: "verified_complete",
        failureTypes: [],
        recoveryAttempted: true,
      }),
    ).passed,
    false,
  );
});

test("Premature completion：Agent claimed resolved and verifier rejected", async () => {
  const scenario = FASEI_FAILURE_SCENARIOS.find((item) => item.id === "premature-completion");
  assert.ok(scenario);
  const report = await executeScenario(scenario);
  const result = scoreScenario(scenario, report);
  assert.equal(result.agentClaimedComplete, true);
  assert.notEqual(result.verificationStatus, "verified_complete");
  assert.equal(result.falseCompletion, true);
  assert.equal(isFalseCompletion(result.agentClaimedComplete, result.verificationStatus), true);
  assert.equal(result.observedFailureModes.includes("premature_completion"), true);
  assert.equal(report.run.attempts.some((attempt) => attempt.failure?.type === "premature_completion"), true);
  assert.equal(result.passed, true);
});

test("Failure mode observation comes from production attempts, not scenario metadata", async () => {
  const scenario = FASEI_FAILURE_SCENARIOS.find((item) => item.id === "tool-failure");
  assert.ok(scenario);
  const report = await executeScenario(scenario);
  const fromHarness = report.run.attempts.map((attempt) => attempt.failure?.type).filter(Boolean);
  assert.equal(fromHarness.includes("tool_failure"), true);
  const result = scoreScenario(scenario, report);
  assert.deepEqual(result.observedFailureModes, result.failureTypes);
  assert.equal(result.failureTypes.includes("tool_failure"), true);
  assert.equal(result.failureTypes.includes("tool_failure"), fromHarness.includes("tool_failure"));
});

test("Injected failure scenarios execute against the production Harness", async () => {
  for (const id of ["insufficient-evidence", "wrong-target", "tool-failure", "retrieval-failure"]) {
    const scenario = FASEI_BENCHMARK_SCENARIOS.find((item) => item.id === id);
    assert.ok(scenario, id);
    const result = await runScenario(scenario);
    assert.equal(result.passed, true, `${id} expected=${result.expectedOutcome} observed=${result.observedOutcome} failures=${result.failureTypes.join(",")}`);
    if (scenario.failureMode) {
      assert.equal(result.observedFailureModes.includes(scenario.failureMode), true, id);
    }
  }
});

test("Phase 7.0 regression scenarios still pass in the combined suite", async () => {
  const report = await runFaseiBenchmark();
  for (const id of ["resolved", "closed-unmerged", "insufficient-evidence"]) {
    const row = report.results.find((item) => item.scenarioId === id);
    assert.ok(row, id);
    assert.equal(row.passed, true, id);
  }
});

test("Benchmark injection / evaluator do not reimplement production analysis", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/benchmark");
  for (const file of ["injection.ts", "evaluate.ts", "runner.ts"]) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.equal(source.includes("new IndependentCompletionVerifier"), false, file);
    assert.equal(source.includes("new FailureAnalyzer"), false, file);
    assert.equal(source.includes("new RecoveryPlanner"), false, file);
    assert.equal(source.includes("evaluateEvidenceRequirement"), false, file);
    assert.equal(source.includes("buildVerificationResult"), false, file);
  }
});
