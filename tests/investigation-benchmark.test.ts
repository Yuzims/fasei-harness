import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FASEI_BENCHMARK_NAME,
  FASEI_BENCHMARK_SCENARIOS,
  FASEI_BENCHMARK_VERSION,
  FASEI_REGRESSION_SCENARIOS,
  compareOutcome,
  computeBenchmarkMetrics,
  isFalseCompletion,
  runFaseiBenchmark,
  runScenario,
  serializeBenchmarkReport,
  type ScenarioResult,
} from "../src/benchmark/index.js";

function sample(overrides: Partial<ScenarioResult> & Pick<ScenarioResult, "scenarioId" | "observedOutcome">): ScenarioResult {
  const observed = overrides.observedOutcome;
  const agentClaimedComplete = overrides.agentClaimedComplete ?? false;
  const failureTypes = overrides.failureTypes ?? [];
  return {
    kind: overrides.kind ?? "normal",
    expectedOutcome: overrides.expectedOutcome ?? observed,
    passed: overrides.passed ?? true,
    attemptCount: overrides.attemptCount ?? 1,
    toolCallCount: overrides.toolCallCount ?? 1,
    verificationStatus: overrides.verificationStatus ?? observed,
    failureTypes,
    expectedFailureModes: overrides.expectedFailureModes ?? [],
    observedFailureModes: overrides.observedFailureModes ?? failureTypes,
    agentClaimedComplete,
    falseCompletion: overrides.falseCompletion ?? isFalseCompletion(agentClaimedComplete, observed),
    recovered: overrides.recovered ?? false,
    recoveryAttempted: overrides.recoveryAttempted ?? false,
    evidenceCoverage: overrides.evidenceCoverage ?? 0,
    unsupportedClaimRate: overrides.unsupportedClaimRate ?? 0,
    ...overrides,
    observedOutcome: observed,
  };
}

test("Benchmark：合法 scenario 可以执行并产出结果", async () => {
  const scenario = FASEI_BENCHMARK_SCENARIOS.find((item) => item.id === "resolved");
  assert.ok(scenario);
  const result = await runScenario(scenario);
  assert.equal(result.scenarioId, "resolved");
  assert.equal(result.observedOutcome, "verified_complete");
  assert.equal(result.verificationStatus, "verified_complete");
  assert.equal(result.passed, true);
  assert.ok(result.attemptCount >= 1);
  assert.ok(result.toolCallCount >= 1);
});

test("Benchmark：expected vs observed 决定 passed", () => {
  assert.equal(compareOutcome("verified_complete", "verified_complete"), true);
  assert.equal(compareOutcome("verified_complete", "not_verified"), false);
  assert.equal(compareOutcome("not_verified", "insufficient_evidence"), false);
  assert.equal(compareOutcome("insufficient_evidence", "insufficient_evidence"), true);
});

test("Benchmark：期望 verified_complete 但观察到 not_verified 则 failed", async () => {
  const closed = FASEI_BENCHMARK_SCENARIOS.find((item) => item.id === "closed-unmerged");
  assert.ok(closed);
  const result = await runScenario({
    ...closed,
    expectedOutcome: { verificationStatus: "verified_complete" },
  });
  assert.equal(result.expectedOutcome, "verified_complete");
  assert.equal(result.observedOutcome, "not_verified");
  assert.equal(result.passed, false);
});

test("Benchmark：false completion 是 Agent 宣称完成且 Verifier 拒绝", () => {
  assert.equal(isFalseCompletion(true, "not_verified"), true);
  assert.equal(isFalseCompletion(true, "insufficient_evidence"), true);
  assert.equal(isFalseCompletion(true, "verified_complete"), false);
  assert.equal(isFalseCompletion(false, "not_verified"), false);
});

test("Benchmark：metrics 由合成结果计算", () => {
  const results: ScenarioResult[] = [
    sample({
      scenarioId: "ok",
      observedOutcome: "verified_complete",
      agentClaimedComplete: true,
      attemptCount: 1,
      toolCallCount: 4,
      evidenceCoverage: 1,
      unsupportedClaimRate: 0,
    }),
    sample({
      scenarioId: "false-complete",
      observedOutcome: "not_verified",
      agentClaimedComplete: true,
      attemptCount: 2,
      toolCallCount: 6,
      evidenceCoverage: 0.5,
      unsupportedClaimRate: 0.5,
    }),
    sample({
      scenarioId: "gap",
      observedOutcome: "insufficient_evidence",
      agentClaimedComplete: false,
      attemptCount: 3,
      toolCallCount: 8,
      evidenceCoverage: 0.25,
      unsupportedClaimRate: 1,
    }),
    sample({
      scenarioId: "recovered",
      observedOutcome: "verified_complete",
      agentClaimedComplete: true,
      recovered: true,
      attemptCount: 2,
      toolCallCount: 10,
      evidenceCoverage: 1,
      unsupportedClaimRate: 0,
    }),
  ];

  const metrics = computeBenchmarkMetrics(results);
  assert.equal(metrics.taskSuccessRate, 0.5);
  assert.equal(metrics.falseCompletionRate, 0.25);
  assert.equal(metrics.insufficientEvidenceRate, 0.25);
  assert.equal(metrics.recoveryRate, 1 / 3);
  assert.equal(metrics.averageAttempts, 2);
  assert.equal(metrics.averageToolCalls, 7);
  assert.equal(metrics.evidenceCoverage, 0.6875);
  assert.equal(metrics.unsupportedClaimRate, 0.375);
  assert.equal(metrics.verifierFalsePositiveRate, 0);
});

test("Benchmark：空结果的 metrics 为 0，不除零", () => {
  const metrics = computeBenchmarkMetrics([]);
  assert.equal(metrics.taskSuccessRate, 0);
  assert.equal(metrics.falseCompletionRate, 0);
  assert.equal(metrics.insufficientEvidenceRate, 0);
  assert.equal(metrics.recoveryRate, 0);
  assert.equal(metrics.averageAttempts, 0);
  assert.equal(metrics.averageToolCalls, 0);
  assert.equal(metrics.verifierFalsePositiveRate, 0);
});

test("Benchmark：三个现有 fixture 产出文档化的 verifier 结果", async () => {
  const report = await runFaseiBenchmark(FASEI_REGRESSION_SCENARIOS);
  assert.equal(report.name, FASEI_BENCHMARK_NAME);
  assert.equal(report.version, FASEI_BENCHMARK_VERSION);
  assert.equal(report.scenarioCount, 3);
  assert.equal(report.passedScenarios, 3);
  assert.equal(report.failedScenarios, 0);

  const byId = Object.fromEntries(report.results.map((item) => [item.scenarioId, item]));
  assert.equal(byId.resolved?.expectedOutcome, "verified_complete");
  assert.equal(byId.resolved?.observedOutcome, "verified_complete");
  assert.equal(byId.resolved?.passed, true);
  assert.equal(byId["closed-unmerged"]?.expectedOutcome, "not_verified");
  assert.equal(byId["closed-unmerged"]?.observedOutcome, "not_verified");
  assert.equal(byId["closed-unmerged"]?.passed, true);
  assert.equal(byId["insufficient-evidence"]?.expectedOutcome, "insufficient_evidence");
  assert.equal(byId["insufficient-evidence"]?.observedOutcome, "insufficient_evidence");
  assert.equal(byId["insufficient-evidence"]?.passed, true);

  assert.equal(byId.resolved?.falseCompletion, false);
  assert.equal(byId["closed-unmerged"]?.falseCompletion, false);
  assert.equal(byId["insufficient-evidence"]?.falseCompletion, false);

  const parsed = JSON.parse(serializeBenchmarkReport(report)) as typeof report;
  assert.equal(parsed.scenarioCount, 3);
  assert.equal(parsed.metrics.taskSuccessRate, 1 / 3);
  assert.equal(parsed.metrics.falseCompletionRate, 0);
  assert.equal(parsed.metrics.verifierFalsePositiveRate, 0);
  assert.equal(parsed.metrics.insufficientEvidenceRate, 1 / 3);
});

test("Benchmark：层只依赖 Harness，生产调查路径不依赖 Benchmark", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../src");
  const productionDirs = ["domain", "investigation", "verification", "github"];
  for (const dir of productionDirs) {
    const folder = join(root, dir);
    for (const file of readdirSync(folder)) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(folder, file), "utf8");
      assert.equal(source.includes("../benchmark/"), false, `${dir}/${file}`);
      assert.equal(source.includes('from "./benchmark'), false, `${dir}/${file}`);
    }
  }

  const runner = readFileSync(join(root, "benchmark/runner.ts"), "utf8");
  assert.match(runner, /investigate\(/);
  assert.equal(runner.includes("new IndependentCompletionVerifier"), false);
  assert.equal(runner.includes("evaluateEvidenceRequirement"), false);
  assert.equal(runner.includes("buildVerificationResult"), false);
});
