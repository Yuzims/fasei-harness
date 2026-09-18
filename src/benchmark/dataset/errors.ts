export type BenchmarkDatasetErrorCode =
  | "invalid_manifest"
  | "unsupported_schema"
  | "duplicate_case_id"
  | "missing_case"
  | "missing_snapshot"
  | "invalid_snapshot"
  | "incomplete_identity"
  | "identity_mismatch"
  | "invalid_expected_outcome"
  | "invalid_scenario"
  | "missing_scenario";

export class BenchmarkDatasetError extends Error {
  readonly code: BenchmarkDatasetErrorCode;

  constructor(code: BenchmarkDatasetErrorCode, message: string) {
    super(message);
    this.name = "BenchmarkDatasetError";
    this.code = code;
  }
}
