/**
 * Deterministic investigation benchmark runner.
 *
 * Evaluates the existing Harness. Does not reimplement verification semantics.
 * Calls investigate() with SnapshotGitHubProvider + scenario environment adapters.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInvestigationTask, type FailureEvent, type FailureType, type RecoveryPlan, type VerificationStatus } from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import { githubFixturePath, loadSnapshot } from "../github/snapshot-store.js";
import type { InvestigationSnapshot } from "../github/types.js";
import { investigate, type InvestigationAgentReport } from "../investigation/index.js";
import type { TraceCollector } from "../trace/trace-collector.js";
import {
  convertCaseToScenario,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadDataset,
  REAL_DATASET_ID,
  REAL_DATASET_RESULT_RELATIVE_PATH,
  realDatasetLatestResultPath,
  realDatasetManifestPath,
  type BenchmarkDataset,
} from "./dataset/index.js";
import { evaluateExpectedContract } from "./evaluate.js";
import { prepareScenarioEnvironment } from "./injection.js";
import { buildBenchmarkReport, computeBenchmarkMetrics, isFalseCompletion } from "./metrics.js";
import { FASEI_BENCHMARK_SCENARIOS } from "./scenarios.js";
import {
  FASEI_BENCHMARK_NAME,
  FASEI_BENCHMARK_VERSION,
  type BenchmarkReport,
  type BenchmarkScenario,
  type DatasetBenchmarkResult,
  type DatasetCaseResult,
  type ExpectedOutcome,
  type ObservedOutcome,
  type RecordedFailureEvent,
  type RecordedRecoveryEvent,
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

export function scoreScenario(
  scenario: BenchmarkScenario,
  report: InvestigationAgentReport,
  expectedOutcome: ExpectedOutcome | undefined = scenario.expectedOutcome,
): ScenarioResult {
  if (!expectedOutcome) {
    throw new Error(
      `scenario ${scenario.id} is missing expectedOutcome; load ground-truth.json for real dataset evaluation`,
    );
  }
  const observed = observeScenario(report);
  const evaluation = evaluateExpectedContract(expectedOutcome, observed);
  const falseCompletion = isFalseCompletion(observed.agentClaimedComplete, observed.verificationStatus);
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    expectedOutcome: expectedOutcome.verificationStatus,
    observedOutcome: observed.verificationStatus,
    passed: evaluation.passed,
    attemptCount: observed.attemptCount,
    toolCallCount: observed.toolCallCount,
    verificationStatus: observed.verificationStatus,
    failureTypes: observed.failureTypes,
    expectedFailureModes: expectedOutcome.failureModes ?? [],
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

export async function executeScenario(
  scenario: BenchmarkScenario,
  /** Optional external TraceCollector for live SSE observation; default: investigate creates its own. */
  trace?: TraceCollector,
): Promise<InvestigationAgentReport> {
  const inner = new SnapshotGitHubProvider(loadScenarioSnapshot(scenario));
  const env = prepareScenarioEnvironment(scenario, inner);
  if (scenario.kind === "normal" && !(env.provider instanceof SnapshotGitHubProvider)) {
    throw new Error(`scenario ${scenario.id} must execute through SnapshotGitHubProvider`);
  }
  return investigate({
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
    provider: env.provider,
    useTestDriver: env.useTestDriver,
    modelFactory: env.modelFactory,
    trace,
  });
}

export async function runScenario(scenario: BenchmarkScenario): Promise<ScenarioResult> {
  const report = await executeScenario(scenario);
  return scoreScenario(scenario, report);
}

export async function runBenchmarkCase(dataset: BenchmarkDataset, caseId: string): Promise<ScenarioResult> {
  const datasetCase = loadCase(dataset, caseId);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  const report = await executeScenario(scenario);
  return scoreScenario(scenario, report, expectedOutcomeForDatasetCase(dataset, caseId));
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

const GROUND_TRUTH_AGENT_MARKERS = ["expectedOutcome", "expectedFailureModes", "ground-truth.json"];

export function assertRealScenarioHasNoGroundTruth(scenario: BenchmarkScenario, caseId: string): void {
  if ("expectedOutcome" in scenario && scenario.expectedOutcome !== undefined) {
    throw new Error(`real dataset case ${caseId} leaked expectedOutcome into the agent scenario`);
  }
  const serialized = JSON.stringify(scenario);
  for (const marker of GROUND_TRUTH_AGENT_MARKERS) {
    if (serialized.includes(marker)) {
      throw new Error(`real dataset case ${caseId} leaked ${marker} into the agent scenario`);
    }
  }
}

function recordedFailure(failure: FailureEvent): RecordedFailureEvent {
  return {
    type: failure.type,
    reason: failure.reason,
    ...(failure.tool ? { tool: failure.tool } : {}),
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
    ...(failure.missingRequirementIds ? { missingRequirementIds: [...failure.missingRequirementIds] } : {}),
  };
}

function recordedRecovery(recovery: RecoveryPlan): RecordedRecoveryEvent {
  return {
    action: recovery.action,
    reason: recovery.reason,
    ...(recovery.nextStep ? { nextStep: recovery.nextStep } : {}),
    ...(recovery.retrievalStrategy ? { retrievalStrategy: recovery.retrievalStrategy } : {}),
  };
}

function githubRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

export async function withGithubNetworkBlocked<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const blocked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = githubRequestUrl(input);
    if (/api\.github\.com/i.test(url) || /^https?:\/\/(?:www\.)?github\.com\b/i.test(url)) {
      throw new Error(`GitHub network access is forbidden during snapshot benchmark execution: ${url}`);
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = blocked;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

export interface DatasetCaseExecution {
  caseId: string;
  scenario: BenchmarkScenario;
  report: InvestigationAgentReport;
  observed: ObservedOutcome;
  expected: ExpectedOutcome;
  result: ScenarioResult;
  caseResult: DatasetCaseResult;
}

export function datasetCaseResultFromExecution(
  caseId: string,
  report: InvestigationAgentReport,
  expected: ExpectedOutcome,
  result: ScenarioResult,
): DatasetCaseResult {
  const evaluation = evaluateExpectedContract(expected, observeScenario(report));
  const failureEvents = report.run.attempts
    .map((attempt) => attempt.failure)
    .filter((item): item is FailureEvent => Boolean(item))
    .map(recordedFailure);
  const recoveryEvents = report.run.attempts
    .map((attempt) => attempt.recovery)
    .filter((item): item is RecoveryPlan => Boolean(item))
    .map(recordedRecovery);
  return {
    caseId,
    observedOutcome: result.observedOutcome,
    expectedOutcome: result.expectedOutcome,
    evaluation,
    attempts: result.attemptCount,
    toolCalls: result.toolCallCount,
    failureEvents,
    recoveryEvents,
    evidenceCount: report.evidence.length,
    claimCount: report.claims.length,
  };
}

export async function executeDatasetCase(dataset: BenchmarkDataset, caseId: string): Promise<DatasetCaseExecution> {
  const datasetCase = loadCase(dataset, caseId);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  if (dataset.metadata.kind === "real") {
    assertRealScenarioHasNoGroundTruth(scenario, caseId);
  }
  const report = await executeScenario(scenario);
  if (dataset.metadata.kind === "real") {
    const agentInput = JSON.stringify({
      task: report.task,
      description: scenario.description,
      target: scenario.target,
    });
    for (const marker of GROUND_TRUTH_AGENT_MARKERS) {
      if (agentInput.includes(marker)) {
        throw new Error(`real dataset case ${caseId} leaked ${marker} into agent input`);
      }
    }
  }
  const expected = expectedOutcomeForDatasetCase(dataset, caseId);
  const result = scoreScenario(scenario, report, expected);
  return {
    caseId,
    scenario,
    report,
    observed: observeScenario(report),
    expected,
    result,
    caseResult: datasetCaseResultFromExecution(caseId, report, expected, result),
  };
}

export interface RunDatasetBenchmarkOptions {
  writeResult?: boolean;
  resultPath?: string;
  now?: () => string;
  blockGithubNetwork?: boolean;
}

export async function runDatasetBenchmark(
  dataset: BenchmarkDataset,
  options: RunDatasetBenchmarkOptions = {},
): Promise<DatasetBenchmarkResult> {
  const run = async () => {
    const cases: DatasetCaseResult[] = [];
    const scenarioResults: ScenarioResult[] = [];
    for (const item of dataset.cases) {
      const executed = await executeDatasetCase(dataset, item.caseId);
      cases.push(executed.caseResult);
      scenarioResults.push(executed.result);
    }
    return {
      dataset: dataset.metadata.kind === "real" ? REAL_DATASET_ID : dataset.metadata.name,
      datasetVersion: dataset.metadata.datasetVersion,
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      cases,
      metrics: computeBenchmarkMetrics(scenarioResults),
    } satisfies DatasetBenchmarkResult;
  };

  const blockNetwork = options.blockGithubNetwork ?? dataset.metadata.kind === "real";
  const result = blockNetwork ? await withGithubNetworkBlocked(run) : await run();
  if (options.writeResult) {
    writeDatasetBenchmarkResult(result, options.resultPath);
  }
  return result;
}

export async function runRealDatasetBenchmark(
  options: RunDatasetBenchmarkOptions = {},
): Promise<DatasetBenchmarkResult> {
  const dataset = loadDataset(realDatasetManifestPath());
  return runDatasetBenchmark(dataset, {
    writeResult: options.writeResult ?? true,
    resultPath: options.resultPath ?? realDatasetLatestResultPath(),
    now: options.now,
    blockGithubNetwork: options.blockGithubNetwork ?? true,
  });
}

export function writeDatasetBenchmarkResult(
  result: DatasetBenchmarkResult,
  resultPath: string = realDatasetLatestResultPath(),
): string {
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return resultPath;
}

export function serializeDatasetBenchmarkResult(result: DatasetBenchmarkResult): string {
  return JSON.stringify(result);
}

export function canonicalizeDatasetResult(result: DatasetBenchmarkResult): Omit<DatasetBenchmarkResult, "timestamp"> {
  return {
    dataset: result.dataset,
    datasetVersion: result.datasetVersion,
    cases: result.cases.map((item) => ({
      caseId: item.caseId,
      observedOutcome: item.observedOutcome,
      expectedOutcome: item.expectedOutcome,
      evaluation: { ...item.evaluation },
      attempts: item.attempts,
      toolCalls: item.toolCalls,
      failureEvents: item.failureEvents.map((event) => ({ ...event })),
      recoveryEvents: item.recoveryEvents.map((event) => ({ ...event })),
      evidenceCount: item.evidenceCount,
      claimCount: item.claimCount,
    })),
    metrics: { ...result.metrics },
  };
}

export function formatDatasetBenchmarkSummary(
  result: DatasetBenchmarkResult,
  resultPath?: string,
): string {
  const passed = result.cases.filter((item) => item.evaluation.passed).length;
  const lines = [
    `FASEI ${result.dataset} benchmark`,
    `datasetVersion: ${result.datasetVersion}`,
    `timestamp: ${result.timestamp}`,
    `cases: ${result.cases.length}`,
    "",
  ];
  for (const item of result.cases) {
    const failures = item.failureEvents.map((event) => event.type).join(",") || "-";
    lines.push(
      `${item.caseId}  observed=${item.observedOutcome}  expected=${item.expectedOutcome}  eval=${item.evaluation.passed ? "PASS" : "FAIL"}  attempts=${item.attempts}  tools=${item.toolCalls}  evidence=${item.evidenceCount}  claims=${item.claimCount}  failures=${failures}`,
    );
  }
  lines.push("");
  lines.push(`Evaluator: ${passed} passed / ${result.cases.length - passed} failed`);
  lines.push("Metrics:");
  lines.push(`  taskSuccessRate: ${result.metrics.taskSuccessRate}`);
  lines.push(`  falseCompletionRate: ${result.metrics.falseCompletionRate}`);
  lines.push(`  insufficientEvidenceRate: ${result.metrics.insufficientEvidenceRate}`);
  lines.push(`  evidenceCoverage: ${result.metrics.evidenceCoverage}`);
  lines.push(`  unsupportedClaimRate: ${result.metrics.unsupportedClaimRate}`);
  lines.push(`  recoveryRate: ${result.metrics.recoveryRate}`);
  lines.push(`  recoverySuccessRate: ${result.metrics.recoverySuccessRate}`);
  lines.push(`  averageAttempts: ${result.metrics.averageAttempts}`);
  lines.push(`  averageToolCalls: ${result.metrics.averageToolCalls}`);
  lines.push(`  verifierFalsePositiveRate: ${result.metrics.verifierFalsePositiveRate}`);
  if (resultPath) {
    lines.push("");
    lines.push(`Result: ${resultPath}`);
  } else {
    lines.push("");
    lines.push(`Result: ${REAL_DATASET_RESULT_RELATIVE_PATH}`);
  }
  return lines.join("\n");
}
