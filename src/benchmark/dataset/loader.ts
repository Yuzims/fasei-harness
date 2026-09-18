import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { GitHubProviderError } from "../../github/errors.js";
import { loadSnapshot as loadGithubSnapshot } from "../../github/snapshot-store.js";
import type { InvestigationSnapshot } from "../../github/types.js";
import type { BenchmarkFailureMode, BenchmarkScenarioKind, ExpectedOutcome } from "../types.js";
import { BenchmarkDatasetError } from "./errors.js";
import { syntheticDatasetManifestPath } from "./paths.js";
import {
  DATASET_SCHEMA_VERSION,
  type BenchmarkDataset,
  type BenchmarkDatasetCase,
  type BenchmarkDatasetKind,
  type BenchmarkDatasetMetadata,
  type BenchmarkDatasetSource,
} from "./types.js";

const DATASET_KINDS = new Set<BenchmarkDatasetKind>(["synthetic", "real"]);
const SCENARIO_KINDS = new Set<BenchmarkScenarioKind>(["normal", "failure"]);
const VERIFICATION_STATUSES = new Set(["verified_complete", "not_verified", "insufficient_evidence"]);
const FAILURE_MODES = new Set<BenchmarkFailureMode>([
  "tool_failure",
  "retrieval_failure",
  "premature_completion",
  "loop_failure",
  "insufficient_evidence",
  "invalid_evidence",
  "wrong_target",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string, code: BenchmarkDatasetError["code"]): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BenchmarkDatasetError(code, `${field} is required`);
  }
  return value.trim();
}

function parseSource(raw: unknown, caseId: string): BenchmarkDatasetSource {
  if (!isRecord(raw)) {
    throw new BenchmarkDatasetError(
      "incomplete_identity",
      `case ${caseId} source must be an object with repository and issueNumber`,
    );
  }
  if (raw.type !== "github") {
    throw new BenchmarkDatasetError(
      "incomplete_identity",
      `case ${caseId} source.type must be "github"`,
    );
  }
  const repository = requireNonEmptyString(raw.repository, `case ${caseId} source.repository`, "incomplete_identity");
  if (!/^[^\s/]+\/[^\s/]+$/.test(repository)) {
    throw new BenchmarkDatasetError(
      "incomplete_identity",
      `case ${caseId} source.repository must be owner/name, got ${repository}`,
    );
  }
  if (!Number.isInteger(raw.issueNumber) || Number(raw.issueNumber) <= 0) {
    throw new BenchmarkDatasetError(
      "incomplete_identity",
      `case ${caseId} source.issueNumber must be a positive integer`,
    );
  }
  return {
    type: "github",
    repository,
    issueNumber: raw.issueNumber as number,
  };
}

function parseFailureModes(raw: unknown, field: string): BenchmarkFailureMode[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new BenchmarkDatasetError("invalid_expected_outcome", `${field} must be an array`);
  }
  const modes: BenchmarkFailureMode[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !FAILURE_MODES.has(item as BenchmarkFailureMode)) {
      throw new BenchmarkDatasetError(
        "invalid_expected_outcome",
        `${field} contains illegal failure mode: ${String(item)}`,
      );
    }
    modes.push(item as BenchmarkFailureMode);
  }
  return modes;
}

function parseExpectedOutcome(raw: unknown, caseId: string): ExpectedOutcome {
  if (!isRecord(raw)) {
    throw new BenchmarkDatasetError(
      "invalid_expected_outcome",
      `case ${caseId} expectedOutcome must be an object`,
    );
  }
  if (typeof raw.verificationStatus !== "string" || !VERIFICATION_STATUSES.has(raw.verificationStatus)) {
    throw new BenchmarkDatasetError(
      "invalid_expected_outcome",
      `case ${caseId} expectedOutcome.verificationStatus is illegal: ${String(raw.verificationStatus)}`,
    );
  }
  const failureModes = parseFailureModes(raw.failureModes, `case ${caseId} expectedOutcome.failureModes`);
  let recovery: ExpectedOutcome["recovery"];
  if (raw.recovery !== undefined) {
    if (!isRecord(raw.recovery) || typeof raw.recovery.required !== "boolean") {
      throw new BenchmarkDatasetError(
        "invalid_expected_outcome",
        `case ${caseId} expectedOutcome.recovery.required must be a boolean`,
      );
    }
    recovery = { required: raw.recovery.required };
  }
  return {
    verificationStatus: raw.verificationStatus as ExpectedOutcome["verificationStatus"],
    ...(failureModes ? { failureModes } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new BenchmarkDatasetError("invalid_manifest", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseKind(raw: unknown, caseId: string): BenchmarkScenarioKind {
  if (typeof raw !== "string" || !SCENARIO_KINDS.has(raw as BenchmarkScenarioKind)) {
    throw new BenchmarkDatasetError(
      "invalid_scenario",
      `case ${caseId} kind must be "normal" or "failure"`,
    );
  }
  return raw as BenchmarkScenarioKind;
}

function parseFailureMode(raw: unknown, caseId: string, kind: BenchmarkScenarioKind): BenchmarkFailureMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !FAILURE_MODES.has(raw as BenchmarkFailureMode)) {
    throw new BenchmarkDatasetError(
      "invalid_scenario",
      `case ${caseId} failureMode is illegal: ${String(raw)}`,
    );
  }
  if (kind === "normal") {
    throw new BenchmarkDatasetError(
      "invalid_scenario",
      `case ${caseId} is kind=normal and must not set failureMode`,
    );
  }
  return raw as BenchmarkFailureMode;
}

function parseCase(raw: unknown, index: number): BenchmarkDatasetCase {
  if (!isRecord(raw)) {
    throw new BenchmarkDatasetError("invalid_manifest", `cases[${index}] must be an object`);
  }
  const caseId = requireNonEmptyString(raw.caseId, `cases[${index}].caseId`, "invalid_manifest");
  const scenarioId = requireNonEmptyString(raw.scenarioId, `case ${caseId} scenarioId`, "missing_scenario");
  const snapshotPath = requireNonEmptyString(raw.snapshotPath, `case ${caseId} snapshotPath`, "missing_snapshot");
  const kind = parseKind(raw.kind, caseId);
  const source = parseSource(raw.source, caseId);
  const expectedOutcome = parseExpectedOutcome(raw.expectedOutcome, caseId);
  const reservedModes = parseFailureModes(raw.expectedFailureModes, `case ${caseId} expectedFailureModes`);

  let sourceMetadata: Record<string, unknown> | undefined;
  if (raw.sourceMetadata !== undefined) {
    if (!isRecord(raw.sourceMetadata)) {
      throw new BenchmarkDatasetError("invalid_manifest", `case ${caseId} sourceMetadata must be an object`);
    }
    sourceMetadata = raw.sourceMetadata;
  }

  let tags: string[] | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((item) => typeof item !== "string")) {
      throw new BenchmarkDatasetError("invalid_manifest", `case ${caseId} tags must be a string array`);
    }
    tags = raw.tags;
  }

  return {
    caseId,
    source,
    snapshotPath,
    scenarioId,
    kind,
    failureMode: parseFailureMode(raw.failureMode, caseId, kind),
    description: parseOptionalString(raw.description, `case ${caseId} description`),
    expectedOutcome,
    tags,
    difficulty: parseOptionalString(raw.difficulty, `case ${caseId} difficulty`),
    sourceMetadata,
    expectedFailureModes: reservedModes,
    notes: parseOptionalString(raw.notes, `case ${caseId} notes`),
  };
}

function parseMetadata(raw: Record<string, unknown>): BenchmarkDatasetMetadata {
  const schemaVersion = requireNonEmptyString(raw.schemaVersion, "schemaVersion", "invalid_manifest");
  if (schemaVersion !== DATASET_SCHEMA_VERSION) {
    throw new BenchmarkDatasetError(
      "unsupported_schema",
      `unsupported dataset schemaVersion: ${schemaVersion}`,
    );
  }
  const datasetVersion = requireNonEmptyString(raw.datasetVersion, "datasetVersion", "invalid_manifest");
  if (typeof raw.kind !== "string" || !DATASET_KINDS.has(raw.kind as BenchmarkDatasetKind)) {
    throw new BenchmarkDatasetError("invalid_manifest", 'kind must be "synthetic" or "real"');
  }
  return {
    datasetVersion,
    schemaVersion,
    kind: raw.kind as BenchmarkDatasetKind,
    name: requireNonEmptyString(raw.name, "name", "invalid_manifest"),
    description: parseOptionalString(raw.description, "description"),
  };
}

export function resolveDatasetSnapshotPath(rootDir: string, snapshotPath: string): string {
  if (isAbsolute(snapshotPath)) {
    throw new BenchmarkDatasetError(
      "invalid_snapshot",
      `snapshotPath must be relative to the dataset root: ${snapshotPath}`,
    );
  }
  const resolved = normalize(join(rootDir, snapshotPath));
  const relativePath = relative(rootDir, resolved);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new BenchmarkDatasetError(
      "invalid_snapshot",
      `snapshotPath escapes dataset root: ${snapshotPath}`,
    );
  }
  return resolved;
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split("/");
  return { owner, name };
}

function assertSnapshotIdentity(datasetCase: BenchmarkDatasetCase, snapshot: InvestigationSnapshot): void {
  const { owner, name } = repositoryParts(datasetCase.source.repository);
  const sameRepo =
    snapshot.owner.toLowerCase() === owner.toLowerCase() &&
    snapshot.repository.toLowerCase() === name.toLowerCase();
  const sameIssue =
    snapshot.issueNumber === datasetCase.source.issueNumber &&
    snapshot.issue.number === datasetCase.source.issueNumber;
  if (!sameRepo || !sameIssue) {
    throw new BenchmarkDatasetError(
      "identity_mismatch",
      `case ${datasetCase.caseId} identity ${datasetCase.source.repository}#${datasetCase.source.issueNumber} does not match snapshot ${snapshot.owner}/${snapshot.repository}#${snapshot.issueNumber}`,
    );
  }
}

function loadSnapshotFile(filePath: string, caseId: string): InvestigationSnapshot {
  if (!existsSync(filePath)) {
    throw new BenchmarkDatasetError("missing_snapshot", `snapshot not found for case ${caseId}: ${filePath}`);
  }
  try {
    return loadGithubSnapshot(filePath);
  } catch (error) {
    const detail = error instanceof GitHubProviderError ? error.message : String(error);
    throw new BenchmarkDatasetError("invalid_snapshot", `invalid snapshot for case ${caseId}: ${detail}`);
  }
}

export function validateDataset(raw: unknown, rootDir: string): BenchmarkDataset {
  if (!isRecord(raw)) {
    throw new BenchmarkDatasetError("invalid_manifest", "dataset manifest must be an object");
  }
  const metadata = parseMetadata(raw);
  if (!Array.isArray(raw.cases)) {
    throw new BenchmarkDatasetError("invalid_manifest", "cases must be an array");
  }

  const cases = raw.cases.map((item, index) => parseCase(item, index));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.caseId)) {
      throw new BenchmarkDatasetError("duplicate_case_id", `duplicate caseId: ${item.caseId}`);
    }
    seen.add(item.caseId);
  }

  for (const item of cases) {
    const snapshotFile = resolveDatasetSnapshotPath(rootDir, item.snapshotPath);
    const snapshot = loadSnapshotFile(snapshotFile, item.caseId);
    assertSnapshotIdentity(item, snapshot);
  }

  return { metadata, cases, rootDir };
}

export function loadDataset(manifestPath: string = syntheticDatasetManifestPath()): BenchmarkDataset {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    throw new BenchmarkDatasetError("invalid_manifest", `dataset manifest not found: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BenchmarkDatasetError("invalid_manifest", `malformed dataset JSON: ${manifestPath}`);
  }
  return validateDataset(parsed, dirname(manifestPath));
}

export function loadCase(dataset: BenchmarkDataset, caseId: string): BenchmarkDatasetCase {
  const found = dataset.cases.find((item) => item.caseId === caseId);
  if (!found) {
    throw new BenchmarkDatasetError("missing_case", `case not found: ${caseId}`);
  }
  return found;
}

export function loadCaseSnapshot(dataset: BenchmarkDataset, datasetCase: BenchmarkDatasetCase): InvestigationSnapshot {
  const snapshot = loadSnapshotFile(resolveDatasetSnapshotPath(dataset.rootDir, datasetCase.snapshotPath), datasetCase.caseId);
  assertSnapshotIdentity(datasetCase, snapshot);
  return snapshot;
}

export function loadSnapshot(dataset: BenchmarkDataset, caseId: string): InvestigationSnapshot {
  return loadCaseSnapshot(dataset, loadCase(dataset, caseId));
}
