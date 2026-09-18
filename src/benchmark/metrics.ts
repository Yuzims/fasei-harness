import type { VerificationStatus } from "../domain/index.js";
import type { BenchmarkMetrics, BenchmarkReport, ScenarioResult } from "./types.js";

export function compareOutcome(
  expected: VerificationStatus,
  observed: VerificationStatus,
): boolean {
  return expected === observed;
}

export function isFalseCompletion(
  agentClaimedComplete: boolean,
  verificationStatus: VerificationStatus,
): boolean {
  return agentClaimedComplete && verificationStatus !== "verified_complete";
}

/**
 * Verifier false positive: harness verified_complete when ground truth says
 * the task should not be considered verified. Distinct from agent-side
 * falseCompletionRate.
 */
export function isVerifierFalsePositive(
  expected: VerificationStatus,
  observed: VerificationStatus,
): boolean {
  return observed === "verified_complete" && expected !== "verified_complete";
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

/** Verifier status is the only success signal. Agent prose is ignored. */
export function computeBenchmarkMetrics(results: readonly ScenarioResult[]): BenchmarkMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      taskSuccessRate: 0,
      falseCompletionRate: 0,
      insufficientEvidenceRate: 0,
      evidenceCoverage: 0,
      unsupportedClaimRate: 0,
      recoveryRate: 0,
      averageAttempts: 0,
      averageToolCalls: 0,
      verifierFalsePositiveRate: 0,
    };
  }

  const failedFirst = results.filter(
    (item) => item.recovered || item.observedOutcome !== "verified_complete",
  );
  const recovered = results.filter((item) => item.recovered).length;
  const shouldNotVerify = results.filter((item) => item.expectedOutcome !== "verified_complete");
  const verifierFalsePositives = shouldNotVerify.filter((item) =>
    isVerifierFalsePositive(item.expectedOutcome, item.observedOutcome),
  ).length;

  return {
    taskSuccessRate: results.filter((item) => item.observedOutcome === "verified_complete").length / n,
    falseCompletionRate: results.filter((item) => item.falseCompletion).length / n,
    insufficientEvidenceRate:
      results.filter((item) => item.observedOutcome === "insufficient_evidence").length / n,
    evidenceCoverage: mean(results.map((item) => item.evidenceCoverage)),
    unsupportedClaimRate: mean(results.map((item) => item.unsupportedClaimRate)),
    recoveryRate: failedFirst.length === 0 ? 0 : recovered / failedFirst.length,
    averageAttempts: mean(results.map((item) => item.attemptCount)),
    averageToolCalls: mean(results.map((item) => item.toolCallCount)),
    verifierFalsePositiveRate:
      shouldNotVerify.length === 0 ? 0 : verifierFalsePositives / shouldNotVerify.length,
  };
}

export function buildBenchmarkReport(
  name: string,
  version: string,
  results: ScenarioResult[],
): BenchmarkReport {
  const passedScenarios = results.filter((item) => item.passed).length;
  return {
    name,
    version,
    scenarioCount: results.length,
    passedScenarios,
    failedScenarios: results.length - passedScenarios,
    metrics: computeBenchmarkMetrics(results),
    results,
  };
}
