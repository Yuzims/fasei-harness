/**
 * Benchmark dataset contract.
 *
 * Dataset Case = experiment input metadata (identity + snapshot path).
 * Snapshot = agent-visible GitHub observations.
 * Ground truth = evaluator-only expected outcomes:
 *   synthetic: inline evaluationOutcomes from the manifest
 *   real: ground-truth.json
 * Scenario = how that input is treated as an experiment.
 * Observed Outcome = what the Harness actually produced.
 *
 * BenchmarkDatasetCase does not carry expectedOutcome. This module does not
 * reimplement verification, failure analysis, or recovery.
 */
import type { InvestigationSnapshot } from "../../github/types.js";
import type { BenchmarkFailureMode, BenchmarkScenarioKind, ExpectedOutcome } from "../types.js";

export const DATASET_SCHEMA_VERSION = "1";

export type BenchmarkDatasetKind = "synthetic" | "real";

export interface BenchmarkDatasetSource {
  type: "github";
  repository: string;
  issueNumber: number;
}

export interface BenchmarkDatasetCase {
  caseId: string;
  source: BenchmarkDatasetSource;
  sourceUrl?: string;
  snapshotPath: string;
  scenarioId: string;
  kind: BenchmarkScenarioKind;
  failureMode?: BenchmarkFailureMode;
  description?: string;
  groundTruthReference?: string;
  snapshotCapturedAt?: string;
  snapshotCutoff?: string;
  tags?: string[];
  difficulty?: string;
  sourceMetadata?: Record<string, unknown>;
  notes?: string;
}

export interface BenchmarkDatasetMetadata {
  datasetVersion: string;
  schemaVersion: string;
  kind: BenchmarkDatasetKind;
  name: string;
  description?: string;
}

export interface BenchmarkDataset {
  metadata: BenchmarkDatasetMetadata;
  cases: BenchmarkDatasetCase[];
  rootDir: string;
  /**
   * Synthetic-only inline evaluation contracts, keyed by caseId.
   * Real datasets omit this; the evaluator loads ground-truth.json.
   */
  evaluationOutcomes?: Readonly<Record<string, ExpectedOutcome>>;
}

export interface LoadedDatasetCase {
  dataset: BenchmarkDataset;
  case: BenchmarkDatasetCase;
  snapshot: InvestigationSnapshot;
}
