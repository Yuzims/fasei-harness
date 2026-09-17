/**
 * Investigation benchmark contract.
 * Evaluation types only. Production investigation / verifier must not import this module.
 */
import type { FailureType, InvestigationTarget, VerificationStatus } from "../domain/index.js";
import type { GithubFixtureId } from "../github/snapshot-store.js";

export const FASEI_BENCHMARK_NAME = "fasei-investigation-benchmark";
export const FASEI_BENCHMARK_VERSION = "7.0";

export interface ExpectedOutcome {
  verificationStatus: VerificationStatus;
  /** Informational. Pass/fail uses verificationStatus only. */
  failureTypes?: FailureType[];
}

export interface BenchmarkScenario {
  id: string;
  description: string;
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
}

export interface ScenarioResult {
  scenarioId: string;
  expectedOutcome: VerificationStatus;
  observedOutcome: VerificationStatus;
  passed: boolean;
  attemptCount: number;
  toolCallCount: number;
  verificationStatus: VerificationStatus;
  failureTypes: FailureType[];
  agentClaimedComplete: boolean;
  falseCompletion: boolean;
  recovered: boolean;
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
