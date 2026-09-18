/**
 * Benchmark ground truth. Evaluator-only.
 *
 * Agent runtime loads InvestigationSnapshot files. It must not import this
 * module or read ground-truth.json.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkFailureMode, ExpectedOutcome } from "../types.js";
import { BenchmarkDatasetError } from "./errors.js";
import { GROUND_TRUTH_FILE_NAME } from "./paths.js";
import type { BenchmarkDataset, BenchmarkDatasetCase } from "./types.js";

export interface GroundTruthRecord {
  caseId: string;
  expectedOutcome: ExpectedOutcome;
  expectedFailureModes?: BenchmarkFailureMode[];
  rationale?: string;
  ambiguity?: string;
}

export interface BenchmarkGroundTruth {
  datasetVersion: string;
  schemaVersion: string;
  cases: GroundTruthRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BenchmarkDatasetError("invalid_manifest", `${field} is required`);
  }
  return value.trim();
}

function parseGroundTruthRecord(raw: unknown, index: number): GroundTruthRecord {
  if (!isRecord(raw)) {
    throw new BenchmarkDatasetError("invalid_manifest", `ground-truth cases[${index}] must be an object`);
  }
  const caseId = requireNonEmptyString(raw.caseId, `ground-truth cases[${index}].caseId`);
  if (!isRecord(raw.expectedOutcome) || typeof raw.expectedOutcome.verificationStatus !== "string") {
    throw new BenchmarkDatasetError(
      "invalid_expected_outcome",
      `ground-truth ${caseId} expectedOutcome.verificationStatus is required`,
    );
  }
  let expectedFailureModes: BenchmarkFailureMode[] | undefined;
  if (raw.expectedFailureModes !== undefined) {
    if (!Array.isArray(raw.expectedFailureModes) || raw.expectedFailureModes.some((item) => typeof item !== "string")) {
      throw new BenchmarkDatasetError(
        "invalid_expected_outcome",
        `ground-truth ${caseId} expectedFailureModes must be a string array`,
      );
    }
    expectedFailureModes = raw.expectedFailureModes as BenchmarkFailureMode[];
  }
  return {
    caseId,
    expectedOutcome: {
      verificationStatus: raw.expectedOutcome.verificationStatus as ExpectedOutcome["verificationStatus"],
      ...(Array.isArray(raw.expectedOutcome.failureModes)
        ? { failureModes: raw.expectedOutcome.failureModes as BenchmarkFailureMode[] }
        : {}),
      ...(isRecord(raw.expectedOutcome.recovery) && typeof raw.expectedOutcome.recovery.required === "boolean"
        ? { recovery: { required: raw.expectedOutcome.recovery.required } }
        : {}),
    },
    expectedFailureModes,
    rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    ambiguity: typeof raw.ambiguity === "string" ? raw.ambiguity : undefined,
  };
}

export function groundTruthPathFor(dataset: BenchmarkDataset): string {
  return join(dataset.rootDir, GROUND_TRUTH_FILE_NAME);
}

export function loadGroundTruth(dataset: BenchmarkDataset): BenchmarkGroundTruth {
  const filePath = groundTruthPathFor(dataset);
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new BenchmarkDatasetError("invalid_manifest", `ground truth not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BenchmarkDatasetError("invalid_manifest", `malformed ground truth JSON: ${filePath}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
    throw new BenchmarkDatasetError("invalid_manifest", "ground-truth.json must have a cases array");
  }
  const cases = parsed.cases.map((item, index) => parseGroundTruthRecord(item, index));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.caseId)) {
      throw new BenchmarkDatasetError("duplicate_case_id", `duplicate ground-truth caseId: ${item.caseId}`);
    }
    seen.add(item.caseId);
  }
  return {
    datasetVersion: requireNonEmptyString(parsed.datasetVersion, "ground-truth datasetVersion"),
    schemaVersion: requireNonEmptyString(parsed.schemaVersion, "ground-truth schemaVersion"),
    cases,
  };
}

export function loadGroundTruthCase(dataset: BenchmarkDataset, caseId: string): GroundTruthRecord {
  const found = loadGroundTruth(dataset).cases.find((item) => item.caseId === caseId);
  if (!found) {
    throw new BenchmarkDatasetError("missing_case", `ground truth not found for case ${caseId}`);
  }
  return found;
}

export function assertGroundTruthMatchesCase(
  datasetCase: BenchmarkDatasetCase,
  record: GroundTruthRecord,
): void {
  if (datasetCase.caseId !== record.caseId) {
    throw new BenchmarkDatasetError(
      "identity_mismatch",
      `ground truth caseId ${record.caseId} does not match ${datasetCase.caseId}`,
    );
  }
}

export function assertGroundTruthCoversDataset(
  dataset: BenchmarkDataset,
  groundTruth: BenchmarkGroundTruth,
): void {
  const caseIds = new Set(dataset.cases.map((item) => item.caseId));
  const groundTruthIds = new Set(groundTruth.cases.map((item) => item.caseId));
  for (const caseId of caseIds) {
    if (!groundTruthIds.has(caseId)) {
      throw new BenchmarkDatasetError("missing_case", `ground truth not found for case ${caseId}`);
    }
  }
  for (const caseId of groundTruthIds) {
    if (!caseIds.has(caseId)) {
      throw new BenchmarkDatasetError(
        "identity_mismatch",
        `ground-truth.json has case ${caseId} which is not in the dataset manifest`,
      );
    }
  }
}

export function expectedOutcomeForDatasetCase(dataset: BenchmarkDataset, caseId: string): ExpectedOutcome {
  if (dataset.metadata.kind === "real") {
    return loadGroundTruthCase(dataset, caseId).expectedOutcome;
  }
  const expected = dataset.evaluationOutcomes?.[caseId];
  if (!expected) {
    throw new BenchmarkDatasetError(
      "invalid_expected_outcome",
      `case ${caseId} is missing an evaluation contract`,
    );
  }
  return expected;
}
