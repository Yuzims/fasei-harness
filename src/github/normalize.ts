import { boundPatch } from "./patch-bounds.js";
import { GITHUB_SOURCE, UNTRUSTED } from "./types.js";
import type {
  CommentSnapshot,
  CommitSnapshot,
  FileChangeSnapshot,
  IssueSnapshot,
  PullRequestSnapshot,
  ReadmeSnapshot,
  RepositorySearchHit,
  RepositorySnapshot,
  ReviewSnapshot,
  TimelineEventSnapshot,
} from "./types.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function repoName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeRepository(
  raw: unknown,
  retrievedAt: string,
  fallback?: { owner: string; repo: string },
): RepositorySnapshot {
  const item = asRecord(raw);
  const full = str(item.full_name) || `${fallback?.owner ?? ""}/${fallback?.repo ?? ""}`;
  const [owner, name] = full.split("/");
  const html = str(item.html_url) || `https://github.com/${full}`;
  return {
    id: `repo:${full}`,
    repository: full,
    owner: owner || fallback?.owner || "",
    name: name || fallback?.repo || "",
    description: str(item.description),
    defaultBranch: str(item.default_branch) || "main",
    source: GITHUB_SOURCE,
    url: html,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeIssue(
  raw: unknown,
  owner: string,
  repo: string,
  retrievedAt: string,
): IssueSnapshot {
  const item = asRecord(raw);
  const number = num(item.number);
  const repository = repoName(owner, repo);
  return {
    id: `issue:${repository}#${number}`,
    repository,
    number,
    title: str(item.title),
    body: str(item.body),
    state: item.state === "closed" ? "closed" : "open",
    stateReason: item.state_reason == null ? null : str(item.state_reason),
    closedAt: item.closed_at == null ? null : str(item.closed_at),
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${repository}/issues/${number}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeComment(
  raw: unknown,
  owner: string,
  repo: string,
  issueNumber: number,
  retrievedAt: string,
): CommentSnapshot {
  const item = asRecord(raw);
  const user = asRecord(item.user);
  const repository = repoName(owner, repo);
  const id = str(item.id) || str(item.node_id) || "comment";
  return {
    id: `comment:${repository}#${issueNumber}:${id}`,
    repository,
    issueNumber,
    body: str(item.body),
    author: str(user.login),
    createdAt: str(item.created_at),
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${repository}/issues/${issueNumber}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeTimelineEvent(
  raw: unknown,
  owner: string,
  repo: string,
  retrievedAt: string,
): TimelineEventSnapshot {
  const item = asRecord(raw);
  const actor = asRecord(item.actor);
  const sourceIssue = asRecord(asRecord(item.source).issue);
  const pull = asRecord(item.pull_request);
  const subject = asRecord(item.subject);
  const subIssue = asRecord(item.sub_issue);
  const parentIssue = asRecord(item.parent_issue);
  const repository = repoName(owner, repo);
  const event = str(item.event) || "unknown";
  const id = str(item.id) || str(item.node_id) || `${event}-${str(item.created_at)}`;
  const commitId = str(item.commit_id);
  const body = str(item.body) || commitId;
  const sourceHasPull = Boolean(sourceIssue.pull_request);
  const prFromSource = sourceHasPull ? num(sourceIssue.number) : 0;
  const prFromSubject = /pull/i.test(str(subject.type)) ? num(subject.number) : 0;
  const prFromSub = subIssue.pull_request ? num(subIssue.number) : 0;
  const prFromParent = parentIssue.pull_request ? num(parentIssue.number) : 0;
  const prFromUrl = pullNumberFromUrl(
    str(item.html_url) || str(sourceIssue.html_url) || str(pull.html_url) || str(subject.url),
  );
  const prNumber =
    num(pull.number) || prFromSource || prFromSubject || prFromSub || prFromParent || prFromUrl || undefined;
  return {
    id: `timeline:${repository}:${id}`,
    repository,
    event,
    createdAt: str(item.created_at),
    actor: str(actor.login),
    body,
    pullRequestNumber: prNumber || undefined,
    source: GITHUB_SOURCE,
    url: str(item.html_url) || str(item.url) || `https://github.com/${repository}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

function pullNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : 0;
}

export function extractPullRequestNumbers(events: TimelineEventSnapshot[]): number[] {
  const numbers = new Set<number>();
  for (const event of events) {
    if (event.pullRequestNumber && event.pullRequestNumber > 0) {
      numbers.add(event.pullRequestNumber);
    }
    for (const mentioned of extractMentionedNumbers(event.body)) {
      numbers.add(mentioned);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Hash references like #7256. Used by capture and investigation to follow mention paths. */
export function extractMentionedNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) {
      found.add(value);
    }
  }
  return [...found];
}

export function textClosesIssue(
  text: string,
  owner: string,
  repo: string,
  issueNumber: number,
): boolean {
  const ownerRe = escapeRegExp(owner);
  const repoRe = escapeRegExp(repo);
  const closing = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:https?://github\\.com/${ownerRe}/${repoRe}/(?:issues|pull)/|#)${issueNumber}\\b`,
    "i",
  );
  return closing.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMMIT_SHA = /\b[0-9a-f]{7,40}\b/i;

export function extractCommitShas(events: TimelineEventSnapshot[]): string[] {
  const shas = new Set<string>();
  for (const event of events) {
    if (event.event !== "referenced" && event.event !== "closed" && event.event !== "committed") {
      continue;
    }
    const match = event.body.match(COMMIT_SHA);
    if (match?.[0]) {
      shas.add(match[0].toLowerCase());
    }
  }
  return [...shas];
}

export function normalizePullRequest(
  raw: unknown,
  owner: string,
  repo: string,
  retrievedAt: string,
): PullRequestSnapshot {
  const item = asRecord(raw);
  const number = num(item.number);
  const repository = repoName(owner, repo);
  const merged = item.merged === true;
  const head = asRecord(item.head);
  return {
    id: `pr:${repository}#${number}`,
    repository,
    number,
    title: str(item.title),
    body: str(item.body),
    state: item.state === "closed" ? "closed" : "open",
    merged,
    mergeCommitSha: item.merge_commit_sha == null ? null : str(item.merge_commit_sha),
    headSha: str(head.sha) || null,
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${repository}/pull/${number}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeReview(
  raw: unknown,
  owner: string,
  repo: string,
  pullNumber: number,
  retrievedAt: string,
): ReviewSnapshot {
  const item = asRecord(raw);
  const user = asRecord(item.user);
  const repository = repoName(owner, repo);
  const id = str(item.id) || "review";
  return {
    id: `review:${repository}#${pullNumber}:${id}`,
    repository,
    pullNumber,
    state: str(item.state) || "COMMENTED",
    body: str(item.body),
    author: str(user.login),
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${repository}/pull/${pullNumber}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeFileChange(
  raw: unknown,
  owner: string,
  repo: string,
  pullNumber: number,
  retrievedAt: string,
): FileChangeSnapshot {
  const item = asRecord(raw);
  const repository = repoName(owner, repo);
  const filename = str(item.filename);
  return {
    id: `file:${repository}#${pullNumber}:${filename}`,
    repository,
    pullNumber,
    filename,
    status: str(item.status) || "modified",
    additions: num(item.additions),
    deletions: num(item.deletions),
    source: GITHUB_SOURCE,
    url: str(item.blob_url) || `https://github.com/${repository}/pull/${pullNumber}`,
    retrievedAt,
    trust: UNTRUSTED,
    ...boundPatch(item.patch),
  };
}

export function normalizeCommit(
  raw: unknown,
  owner: string,
  repo: string,
  retrievedAt: string,
): CommitSnapshot {
  const item = asRecord(raw);
  const commit = asRecord(item.commit);
  const author = asRecord(commit.author);
  const nestedAuthor = asRecord(item.author);
  const sha = str(item.sha) || str(item.node_id);
  const repository = repoName(owner, repo);
  return {
    id: `commit:${repository}@${sha}`,
    repository,
    sha,
    message: str(commit.message),
    author: str(nestedAuthor.login) || str(author.name),
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${repository}/commit/${sha}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeSearchHit(raw: unknown, retrievedAt: string): RepositorySearchHit {
  const item = asRecord(raw);
  const fullName = str(item.full_name);
  return {
    id: `search:${fullName}`,
    repository: fullName,
    fullName,
    description: str(item.description),
    stars: num(item.stargazers_count),
    language: str(item.language),
    createdAt: str(item.created_at),
    updatedAt: str(item.updated_at),
    source: GITHUB_SOURCE,
    url: str(item.html_url) || `https://github.com/${fullName}`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}

export function normalizeReadme(
  markdown: string,
  owner: string,
  repo: string,
  retrievedAt: string,
): ReadmeSnapshot {
  const repository = repoName(owner, repo);
  const truncated = markdown.length > 8000;
  return {
    id: `readme:${repository}`,
    repository,
    owner,
    name: repo,
    markdown: markdown.slice(0, 8000),
    truncated,
    source: GITHUB_SOURCE,
    url: `https://github.com/${repository}#readme`,
    retrievedAt,
    trust: UNTRUSTED,
  };
}
