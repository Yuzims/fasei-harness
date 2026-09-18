export const INVALID_GITHUB_ISSUE_INPUT = "INVALID_GITHUB_ISSUE_INPUT";

export class GitHubIssueInputError extends Error {
  readonly code = INVALID_GITHUB_ISSUE_INPUT;
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "GitHubIssueInputError";
    this.reason = reason;
  }
}

export interface ParsedGitHubIssue {
  owner: string;
  repository: string;
  issueNumber: number;
  url: string;
}

function invalid(reason: string, message: string): GitHubIssueInputError {
  return new GitHubIssueInputError(reason, message);
}

function isRepoId(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function parsed(owner: string, repository: string, issueNumber: number): ParsedGitHubIssue {
  if (!isRepoId(owner) || !isRepoId(repository)) {
    throw invalid("invalid_repository", "Enter a GitHub Issue URL or owner/repo#number.");
  }
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw invalid("invalid_issue_number", "GitHub Issue number must be a positive integer.");
  }
  return {
    owner,
    repository,
    issueNumber,
    url: `https://github.com/${owner}/${repository}/issues/${issueNumber}`,
  };
}

function parseIssueUrl(input: string): ParsedGitHubIssue {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid("invalid_url", "Enter a GitHub Issue URL or owner/repo#number.");
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw invalid("unsupported_host", "Only GitHub Issue URLs are supported.");
  }

  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const kind = parts[2]?.toLowerCase();
  if (parts.length >= 4 && (kind === "pull" || kind === "pulls")) {
    throw invalid("pull_request", "Pull request URLs are not supported. Enter a GitHub Issue.");
  }
  if (parts.length === 4 && kind === "issues" && /^\d+$/.test(parts[3] ?? "")) {
    return parsed(parts[0], parts[1], Number(parts[3]));
  }
  throw invalid("not_issue_url", "Enter a GitHub Issue URL or owner/repo#number.");
}

function parseShortRef(input: string): ParsedGitHubIssue {
  const match = input.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) {
    if (/^[^/\s]+\/[^#\s]+$/.test(input)) {
      throw invalid("missing_issue_number", "Enter a GitHub Issue as owner/repo#123.");
    }
    if (/#/.test(input) && /#\D/.test(input)) {
      throw invalid("invalid_issue_number", "GitHub Issue number must be a positive integer.");
    }
    throw invalid("unrecognized", "Enter a GitHub Issue URL or owner/repo#number.");
  }
  return parsed(match[1], match[2], Number(match[3]));
}

export function parseGitHubIssueInput(raw: unknown): ParsedGitHubIssue {
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalid("empty", "Enter a GitHub Issue URL or owner/repo#number.");
  }
  const input = raw.trim();
  if (/^https?:\/\//i.test(input) || /^(www\.)?github\.com\//i.test(input)) {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    return parseIssueUrl(withScheme);
  }
  return parseShortRef(input);
}
