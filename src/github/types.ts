export const SNAPSHOT_SCHEMA_VERSION = 1;
export const GITHUB_SOURCE = "github";
export const UNTRUSTED = "external_untrusted" as const;

export type GitHubTrust = "external_untrusted";

export interface ResourceMeta {
  id: string;
  repository: string;
  source: string;
  url: string;
  retrievedAt: string;
  trust: GitHubTrust;
}

export interface RepositorySnapshot extends ResourceMeta {
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
}

export interface IssueSnapshot extends ResourceMeta {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason?: string | null;
  closedAt?: string | null;
}

export interface CommentSnapshot extends ResourceMeta {
  issueNumber: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface TimelineEventSnapshot extends ResourceMeta {
  event: string;
  createdAt: string;
  actor: string;
  body: string;
  pullRequestNumber?: number;
}

export interface PullRequestSnapshot extends ResourceMeta {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha?: string | null;
  headSha?: string | null;
}

export interface ReviewSnapshot extends ResourceMeta {
  pullNumber: number;
  state: string;
  body: string;
  author: string;
}

export interface FileChangeSnapshot extends ResourceMeta {
  pullNumber: number;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Bounded unified diff from GitHub. Absent on older snapshots and binary/large files. */
  patch?: string;
  patchTruncated?: boolean;
}

export interface CommitSnapshot extends ResourceMeta {
  sha: string;
  message: string;
  author: string;
}

export interface RepositorySearchHit extends ResourceMeta {
  fullName: string;
  description: string;
  stars: number;
  language: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReadmeSnapshot extends ResourceMeta {
  owner: string;
  name: string;
  markdown: string;
  truncated: boolean;
}

export interface InvestigationSnapshot {
  snapshotId: string;
  schemaVersion: number;
  createdAt: string;
  source: string;
  owner: string;
  repository: string;
  issueNumber: number;
  retrievedAt: string;
  trust: GitHubTrust;
  repositoryData: RepositorySnapshot;
  issue: IssueSnapshot;
  comments: CommentSnapshot[];
  timeline: TimelineEventSnapshot[];
  pullRequests: Record<string, PullRequestSnapshot>;
  reviews: Record<string, ReviewSnapshot[]>;
  files: Record<string, FileChangeSnapshot[]>;
  commits: Record<string, CommitSnapshot[]>;
  commitIndex: Record<string, CommitSnapshot>;
  readme?: ReadmeSnapshot;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  issueNumber: number;
}

export interface PullRef extends RepoRef {
  pullNumber: number;
}

export interface CommitRef extends RepoRef {
  sha: string;
}

export interface ListCommitsQuery extends RepoRef {
  pullNumber?: number;
  sha?: string;
}

export interface SearchRepositoriesQuery {
  query: string;
  sort?: "stars" | "updated";
  sinceDays?: number;
}
