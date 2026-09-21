/**
 * Shared file-change helpers for Resolution Analysis / Resolution Analyzer.
 */
import type { Evidence } from "../domain/types.js";

const TEST_FILE_PATTERN =
  /(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)specs?\/|\.spec\.|\.specs\.|\.test\./i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTestFilePath(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename.replaceAll("\\", "/"));
}

export function fileChangeFromEvidence(evidence: Evidence): {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patchTruncated?: boolean;
} | undefined {
  if (evidence.kind !== "file" || !isRecord(evidence.payload)) {
    return undefined;
  }
  const filename = typeof evidence.payload.filename === "string" ? evidence.payload.filename : "";
  if (!filename) {
    return undefined;
  }
  return {
    filename,
    status: typeof evidence.payload.status === "string" ? evidence.payload.status : "modified",
    additions: typeof evidence.payload.additions === "number" ? evidence.payload.additions : 0,
    deletions: typeof evidence.payload.deletions === "number" ? evidence.payload.deletions : 0,
    patch: typeof evidence.payload.patch === "string" && evidence.payload.patch.length > 0
      ? evidence.payload.patch
      : undefined,
    patchTruncated: evidence.payload.patchTruncated === true,
  };
}

export function hasBoundedPatch(evidence: Evidence): boolean {
  return Boolean(fileChangeFromEvidence(evidence)?.patch);
}
