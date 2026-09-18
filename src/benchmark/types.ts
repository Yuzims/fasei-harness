/**
 * Investigation benchmark contract.
 * Evaluation types only. Production investigation / verifier must not import this module.
 */
import type { FailureType, InvestigationTarget, RecoveryAction, VerificationStatus } from "../domain/index.js";
import type { GithubFixtureId } from "../github/snapshot-store.js";

export const FASEI_BENCHMARK_NAME = "fasei-investigation-benchmark";
export const FASEI_BENCHMARK_VERSION = "7.1";

export type BenchmarkScenarioKind = "normal" | "failure";

/** Experiment metadata. Reuses production FailureType; not a second analyzer. */
export type BenchmarkFailureMode = Exclude<FailureType, "unknown">;

export interface ExpectedRecovery {
  required: boolean;
}

export interface ExpectedOutcome {
  verificationStatus: VerificationStatus;
  failureModes?: BenchmarkFailureMode[];
  recovery?: ExpectedRecovery;
}

export interface BenchmarkScenario {
  id: string;
  description: string;
  kind: BenchmarkScenarioKind;
  /** Intended experiment mode when kind is failure. Metadata only. */
  failureMode?: BenchmarkFailureMode;
  /** Phase 7.0/7.1 recorded GitHub fixture id. Dataset cases use snapshotPath instead. */
  fixture?: GithubFixtureId;
  /** Absolute path to a recorded InvestigationSnapshot. Benchmark runtime uses this, not the live GitHub API. */
  snapshotPath?: string;
  target: InvestigationTarget;
  /**
   * Evaluator contract for built-in and synthetic scenarios.
   * Agent runtime must not read this. Real dataset cases omit it;
   * the evaluator loads ground-truth.json instead.
   */
  expectedOutcome?: ExpectedOutcome;
}

export interface ObservedOutcome {
  verificationStatus: VerificationStatus;
  agentClaimedComplete: boolean;
  attemptCount: number;
  toolCallCount: number;
  evidenceCoverage: number;
  unsupportedClaimRate: number;
  failureTypes: FailureType[];
  recovered: boolean;
  recoveryAttempted: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  kind: BenchmarkScenarioKind;
  expectedOutcome: VerificationStatus;
  observedOutcome: VerificationStatus;
  passed: boolean;
  attemptCount: number;
  toolCallCount: number;
  verificationStatus: VerificationStatus;
  failureTypes: FailureType[];
  expectedFailureModes: BenchmarkFailureMode[];
  observedFailureModes: FailureType[];
  agentClaimedComplete: boolean;
  falseCompletion: boolean;
  recovered: boolean;
  recoveryAttempted: boolean;
  evidenceCoverage: number;
  unsupportedClaimRate: number;
}

export interface BenchmarkMetrics {
  taskSuccessRate: number;
  falseCompletionRate: number;
  insufficientEvidenceRate: number;
  evidenceCoverage: number;
  unsupportedClaimRate: number;
  recoveryRate: number;
  averageAttempts: number;
  averageToolCalls: number;
}

export interface BenchmarkReport {
  name: string;
  version: string;
  scenarioCount: number;
  passedScenarios: number;
  failedScenarios: number;
  metrics: BenchmarkMetrics;
  results: ScenarioResult[];
}

/** Failure classification recorded from Harness attempts. Evidence UUIDs are omitted. */
export interface RecordedFailureEvent {
  type: FailureType;
  reason: string;
  tool?: string;
  errorCode?: string;
  retryable?: boolean;
  missingRequirementIds?: string[];
}

export interface RecordedRecoveryEvent {
  action: RecoveryAction;
  reason: string;
  nextStep?: string;
  retrievalStrategy?: string;
}

export interface DatasetCaseEvaluation {
  passed: boolean;
  verificationPassed: boolean;
  failureModesPassed: boolean;
  recoveryPassed: boolean;
}

export interface DatasetCaseResult {
  caseId: string;
  observedOutcome: VerificationStatus;
  expectedOutcome: VerificationStatus;
  evaluation: DatasetCaseEvaluation;
  attempts: number;
  toolCalls: number;
  failureEvents: RecordedFailureEvent[];
  recoveryEvents: RecordedRecoveryEvent[];
  evidenceCount: number;
  claimCount: number;
}

export interface DatasetBenchmarkResult {
  dataset: string;
  datasetVersion: string;
  timestamp: string;
  cases: DatasetCaseResult[];
  metrics: BenchmarkMetrics;
}
