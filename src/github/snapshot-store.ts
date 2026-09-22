import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubProviderError } from "./errors.js";
import { SNAPSHOT_SCHEMA_VERSION, UNTRUSTED, type InvestigationSnapshot } from "./types.js";

export type GithubFixtureId =
  | "resolved"
  | "closed-unmerged"
  | "insufficient-evidence"
  /** Phase 18-A acceptance fixture: real capture of facebook/react#37610 (REST, zero cross-referenced timeline events). */
  | "react-37610";

export function githubFixturePath(id: GithubFixtureId): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/github", `${id}.json`);
}

export function validateSnapshot(raw: unknown): InvestigationSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GitHubProviderError({
      code: "invalid_snapshot",
      operation: "validateSnapshot",
      message: "snapshot must be an object",
      retryable: false,
    });
  }
  const data = raw as Partial<InvestigationSnapshot>;
  if (data.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new GitHubProviderError({
      code: "invalid_snapshot",
      operation: "validateSnapshot",
      message: `unsupported schemaVersion: ${String(data.schemaVersion)}`,
      retryable: false,
    });
  }
  if (!data.snapshotId || !data.owner || !data.repository || !data.issue || !data.repositoryData) {
    throw new GitHubProviderError({
      code: "invalid_snapshot",
      operation: "validateSnapshot",
      message: "snapshot missing snapshotId/owner/repository/issue/repositoryData",
      retryable: false,
    });
  }
  if (typeof data.issueNumber !== "number" || data.issueNumber <= 0) {
    throw new GitHubProviderError({
      code: "invalid_snapshot",
      operation: "validateSnapshot",
      message: "snapshot issueNumber must be a positive integer",
      retryable: false,
    });
  }

  return {
    snapshotId: data.snapshotId,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: data.createdAt ?? "",
    source: data.source ?? "github",
    owner: data.owner,
    repository: data.repository,
    issueNumber: data.issueNumber,
    retrievedAt: data.retrievedAt ?? data.createdAt ?? "",
    trust: UNTRUSTED,
    repositoryData: data.repositoryData,
    issue: data.issue,
    comments: data.comments ?? [],
    timeline: data.timeline ?? [],
    pullRequests: data.pullRequests ?? {},
    reviews: data.reviews ?? {},
    files: data.files ?? {},
    commits: data.commits ?? {},
    commitIndex: data.commitIndex ?? {},
    readme: data.readme,
  };
}

export function loadSnapshot(filePath: string): InvestigationSnapshot {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new GitHubProviderError({
      code: "not_found",
      operation: "loadSnapshot",
      message: `snapshot not found: ${filePath}`,
      retryable: false,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHubProviderError({
      code: "invalid_snapshot",
      operation: "loadSnapshot",
      message: `malformed snapshot JSON: ${filePath}`,
      retryable: false,
    });
  }
  return validateSnapshot(parsed);
}

export function saveSnapshot(filePath: string, snapshot: InvestigationSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
