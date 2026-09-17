/**
 * Investigation benchmark contract.
 * Evaluation types only. Production investigation / verifier must not import this module.
 */
import type { FailureType, InvestigationTarget, VerificationStatus } from "../domain/index.js";
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
  fixture: GithubFixtureId;
  target: InvestigationTarget;
  expectedOutcome: ExpectedOutcome;
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
