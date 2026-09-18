/**
 * Deterministic investigation benchmark runner.
 *
 * Evaluates the existing Harness. Does not reimplement verification semantics.
 * Calls investigate() with SnapshotGitHubProvider + scenario environment adapters.
 */
import { createInvestigationTask, type FailureType, type VerificationStatus } from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import { githubFixturePath, loadSnapshot } from "../github/snapshot-store.js";
import type { InvestigationSnapshot } from "../github/types.js";
import { investigate, type InvestigationAgentReport } from "../investigation/index.js";
import { convertCaseToScenario, loadCase, type BenchmarkDataset } from "./dataset/index.js";
import { evaluateScenarioContract, expectedFailureModes } from "./evaluate.js";
import { prepareScenarioEnvironment } from "./injection.js";
import { buildBenchmarkReport, isFalseCompletion } from "./metrics.js";
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

function recoveryAttemptedFrom(report: InvestigationAgentReport): boolean {
  return report.run.attempts.some((attempt) => Boolean(attempt.recovery && attempt.recovery.action !== "stop"));
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
    recoveryAttempted: recoveryAttemptedFrom(report),
  };
}

export function scoreScenario(scenario: BenchmarkScenario, report: InvestigationAgentReport): ScenarioResult {
  const observed = observeScenario(report);
  const expected = scenario.expectedOutcome.verificationStatus;
  const expectedModes = expectedFailureModes(scenario);
  const evaluation = evaluateScenarioContract(scenario, observed);
  const falseCompletion = isFalseCompletion(observed.agentClaimedComplete, observed.verificationStatus);
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    expectedOutcome: expected,
    observedOutcome: observed.verificationStatus,
    passed: evaluation.passed,
    attemptCount: observed.attemptCount,
    toolCallCount: observed.toolCallCount,
    verificationStatus: observed.verificationStatus,
    failureTypes: observed.failureTypes,
    expectedFailureModes: expectedModes,
    observedFailureModes: observed.failureTypes,
    agentClaimedComplete: observed.agentClaimedComplete,
    falseCompletion,
    recovered: observed.recovered,
    recoveryAttempted: observed.recoveryAttempted,
    evidenceCoverage: observed.evidenceCoverage,
    unsupportedClaimRate: observed.unsupportedClaimRate,
  };
}

export function resolveScenarioSnapshotPath(scenario: BenchmarkScenario): string {
  if (scenario.snapshotPath?.trim()) {
    return scenario.snapshotPath;
  }
  if (scenario.fixture) {
    return githubFixturePath(scenario.fixture);
  }
  throw new Error(`scenario ${scenario.id} is missing snapshotPath and fixture`);
}

export function loadScenarioSnapshot(scenario: BenchmarkScenario): InvestigationSnapshot {
  return loadSnapshot(resolveScenarioSnapshotPath(scenario));
}

export async function executeScenario(scenario: BenchmarkScenario): Promise<InvestigationAgentReport> {
  const inner = new SnapshotGitHubProvider(loadScenarioSnapshot(scenario));
  const env = prepareScenarioEnvironment(scenario, inner);
  return investigate({
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
    provider: env.provider,
    useTestDriver: env.useTestDriver,
    modelFactory: env.modelFactory,
  });
}

export async function runScenario(scenario: BenchmarkScenario): Promise<ScenarioResult> {
  const report = await executeScenario(scenario);
  return scoreScenario(scenario, report);
}

export async function runBenchmarkCase(dataset: BenchmarkDataset, caseId: string): Promise<ScenarioResult> {
  const datasetCase = loadCase(dataset, caseId);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  return runScenario(scenario);
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
