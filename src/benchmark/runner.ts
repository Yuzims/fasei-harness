/**
 * Deterministic investigation benchmark runner.
 *
 * Evaluates the existing Harness. Does not reimplement verification semantics.
 * Calls investigate() with SnapshotGitHubProvider + SnapshotInvestigationDriver.
 */
import { createInvestigationTask, type FailureType, type VerificationStatus } from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import { githubFixturePath } from "../github/snapshot-store.js";
import { investigate, type InvestigationAgentReport } from "../investigation/index.js";
import { buildBenchmarkReport, compareOutcome, isFalseCompletion } from "./metrics.js";
import { FASEI_BENCHMARK_SCENARIOS } from "./scenarios.js";
import {
  FASEI_BENCHMARK_NAME,
  FASEI_BENCHMARK_VERSION,
  type BenchmarkReport,
  type BenchmarkScenario,
  type ObservedOutcome,
  type ScenarioResult,
} from "./types.js";

function agentClaimedComplete(report: InvestigationAgentReport): boolean {
  return report.claims.some((claim) => claim.critical && claim.polarity === "resolved");
}

function failureTypesFrom(report: InvestigationAgentReport): FailureType[] {
  const types: FailureType[] = [];
  for (const attempt of report.run.attempts) {
    if (attempt.failure && !types.includes(attempt.failure.type)) {
      types.push(attempt.failure.type);
    }
  }
  return types;
}

function asVerificationStatus(status: string | undefined): VerificationStatus {
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return "not_verified";
}

function recoveredFrom(report: InvestigationAgentReport, finalStatus: VerificationStatus): boolean {
  const first = report.run.attempts[0]?.verification?.status;
  if (!first) {
    return false;
  }
  return first !== "verified_complete" && finalStatus === "verified_complete";
}

export function observeScenario(report: InvestigationAgentReport): ObservedOutcome {
  const observed = asVerificationStatus(report.verification?.status ?? report.run.status);
  const unsupported = report.verification?.unsupportedClaimIds.length ?? 0;
  return {
    verificationStatus: observed,
    agentClaimedComplete: agentClaimedComplete(report),
    attemptCount: Math.max(report.run.attempts.length, 1),
    toolCallCount: report.investigationSteps.length,
    evidenceCoverage: report.verification?.evidenceCoverage ?? 0,
    unsupportedClaimRate: unsupported / Math.max(report.claims.length, 1),
    failureTypes: failureTypesFrom(report),
    recovered: recoveredFrom(report, observed),
  };
}

export function scoreScenario(scenario: BenchmarkScenario, report: InvestigationAgentReport): ScenarioResult {
  const observed = observeScenario(report);
  const expected = scenario.expectedOutcome.verificationStatus;
  const falseCompletion = isFalseCompletion(observed.agentClaimedComplete, observed.verificationStatus);
  return {
    scenarioId: scenario.id,
    expectedOutcome: expected,
    observedOutcome: observed.verificationStatus,
    passed: compareOutcome(expected, observed.verificationStatus),
    attemptCount: observed.attemptCount,
    toolCallCount: observed.toolCallCount,
    verificationStatus: observed.verificationStatus,
    failureTypes: observed.failureTypes,
    agentClaimedComplete: observed.agentClaimedComplete,
    falseCompletion,
    recovered: observed.recovered,
    evidenceCoverage: observed.evidenceCoverage,
    unsupportedClaimRate: observed.unsupportedClaimRate,
  };
}

export async function executeScenario(scenario: BenchmarkScenario): Promise<InvestigationAgentReport> {
  return investigate({
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
    provider: new SnapshotGitHubProvider(githubFixturePath(scenario.fixture)),
    useTestDriver: true,
  });
}

export async function runScenario(scenario: BenchmarkScenario): Promise<ScenarioResult> {
  const report = await executeScenario(scenario);
  return scoreScenario(scenario, report);
}

export async function runFaseiBenchmark(
  scenarios: readonly BenchmarkScenario[] = FASEI_BENCHMARK_SCENARIOS,
): Promise<BenchmarkReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  return buildBenchmarkReport(FASEI_BENCHMARK_NAME, FASEI_BENCHMARK_VERSION, results);
}

export function serializeBenchmarkReport(report: BenchmarkReport): string {
  return JSON.stringify(report);
}
