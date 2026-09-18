import type { InvestigationApiErrorDTO } from "../api/dto.js";
import { GitHubProviderError } from "../github/errors.js";
import { GitHubIssueInputError, INVALID_GITHUB_ISSUE_INPUT } from "../github/issue-input.js";

export class InvestigationHttpError extends Error {
  readonly status: number;
  readonly body: { error: InvestigationApiErrorDTO };

  constructor(status: number, error: InvestigationApiErrorDTO) {
    super(error.message);
    this.name = "InvestigationHttpError";
    this.status = status;
    this.body = { error };
  }
}

const GITHUB_MESSAGES: Record<GitHubProviderError["code"], string> = {
  not_found: "Issue not found",
  rate_limited: "GitHub API rate limit reached.",
  forbidden: "GitHub API denied access to this issue.",
  unauthorized: "GitHub API authorization failed.",
  timeout: "GitHub API request timed out.",
  network_error: "Could not reach the GitHub API.",
  server_error: "GitHub API is unavailable.",
  malformed_response: "GitHub API returned a malformed response.",
  invalid_argument: "Could not investigate this issue.",
  invalid_snapshot: "Recorded GitHub snapshot is invalid.",
};

const GITHUB_STATUS: Record<GitHubProviderError["code"], number> = {
  not_found: 404,
  rate_limited: 429,
  forbidden: 403,
  unauthorized: 401,
  timeout: 504,
  network_error: 502,
  server_error: 502,
  malformed_response: 502,
  invalid_argument: 400,
  invalid_snapshot: 400,
};

function githubApiCode(code: GitHubProviderError["code"]): string {
  if (code === "not_found") {
    return "GITHUB_NOT_FOUND";
  }
  if (code === "rate_limited") {
    return "GITHUB_RATE_LIMITED";
  }
  return `GITHUB_${code.toUpperCase()}`;
}

export function toInvestigationHttpError(error: unknown): InvestigationHttpError {
  if (error instanceof InvestigationHttpError) {
    return error;
  }
  if (error instanceof GitHubIssueInputError) {
    return new InvestigationHttpError(400, {
      code: INVALID_GITHUB_ISSUE_INPUT,
      message: error.message,
    });
  }
  if (error instanceof GitHubProviderError) {
    return new InvestigationHttpError(GITHUB_STATUS[error.code], {
      code: githubApiCode(error.code),
      message: GITHUB_MESSAGES[error.code],
      githubCode: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      retryAt: error.retryAt,
    });
  }
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : 400;
  const message = error instanceof Error ? error.message : String(error);
  return new InvestigationHttpError(status === 404 ? 404 : status === 429 ? 429 : 400, {
    code: status === 404 ? "SNAPSHOT_NOT_FOUND" : "INVESTIGATION_ERROR",
    message,
  });
}
