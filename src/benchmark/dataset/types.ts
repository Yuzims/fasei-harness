/**
 * Benchmark dataset contract.
 *
 * Dataset Case = what the experiment data is.
 * Scenario = how that data is treated as an experiment.
 * Expected Outcome = what the Harness should observe.
 * Observed Outcome = what the Harness actually produced.
 *
 * Evaluation still uses expectedOutcome. This module does not
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
  expectedOutcome: ExpectedOutcome;
  groundTruthReference?: string;
  snapshotCapturedAt?: string;
  snapshotCutoff?: string;
  tags?: string[];
  difficulty?: string;
  sourceMetadata?: Record<string, unknown>;
  expectedFailureModes?: BenchmarkFailureMode[];
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
}

export interface LoadedDatasetCase {
  dataset: BenchmarkDataset;
  case: BenchmarkDatasetCase;
  snapshot: InvestigationSnapshot;
}
