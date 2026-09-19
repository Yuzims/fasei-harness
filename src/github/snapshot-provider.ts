import { attachCommitDiscoveryTruncation, boundRepositoryCommitDiscovery } from "./commit-bounds.js";
import { GitHubProviderError } from "./errors.js";
import type { GitHubDataProvider } from "./provider.js";
import { loadSnapshot } from "./snapshot-store.js";
import type {
  CommentSnapshot,
  CommitRef,
  CommitSnapshot,
  FileChangeSnapshot,
  InvestigationSnapshot,
  IssueRef,
  IssueSnapshot,
  ListCommitsQuery,
  ListedCommits,
  PullRef,
  PullRequestSnapshot,
  ReadmeSnapshot,
  RepoRef,
  RepositorySearchHit,
  RepositorySnapshot,
  ReviewSnapshot,
  SearchRepositoriesQuery,
  TimelineEventSnapshot,
} from "./types.js";

function matchesRepo(snapshot: InvestigationSnapshot, owner: string, repo: string): boolean {
  return (
    snapshot.owner.toLowerCase() === owner.toLowerCase() &&
    snapshot.repository.toLowerCase() === repo.toLowerCase()
  );
}

function missing(operation: string, detail: string): GitHubProviderError {
  return new GitHubProviderError({
    code: "not_found",
    operation,
    status: 404,
    message: detail,
    retryable: false,
  });
}

export class SnapshotGitHubProvider implements GitHubDataProvider {
  private readonly snapshot: InvestigationSnapshot;

  constructor(snapshot: InvestigationSnapshot | string) {
    this.snapshot = typeof snapshot === "string" ? loadSnapshot(snapshot) : snapshot;
  }

  getSnapshot(): InvestigationSnapshot {
    return this.snapshot;
  }

  async getRepository(ref: RepoRef): Promise<RepositorySnapshot> {
    this.requireRepo("getRepository", ref.owner, ref.repo);
    return this.snapshot.repositoryData;
  }

  async getIssue(ref: IssueRef): Promise<IssueSnapshot> {
    this.requireRepo("getIssue", ref.owner, ref.repo);
    if (this.snapshot.issueNumber !== ref.issueNumber) {
      throw missing("getIssue", `issue ${ref.issueNumber} not in snapshot ${this.snapshot.snapshotId}`);
    }
    return this.snapshot.issue;
  }

  async getIssueComments(ref: IssueRef): Promise<CommentSnapshot[]> {
    await this.getIssue(ref);
    return this.snapshot.comments;
  }

  async getIssueTimeline(ref: IssueRef): Promise<TimelineEventSnapshot[]> {
    await this.getIssue(ref);
    return this.snapshot.timeline;
  }

  async getPullRequest(ref: PullRef): Promise<PullRequestSnapshot> {
    this.requireRepo("getPullRequest", ref.owner, ref.repo);
    const pr = this.snapshot.pullRequests[String(ref.pullNumber)];
    if (!pr) {
      throw missing(
        "getPullRequest",
        `PR ${ref.pullNumber} not in snapshot ${this.snapshot.snapshotId}`,
      );
    }
    return pr;
  }

  async getPullRequestReviews(ref: PullRef): Promise<ReviewSnapshot[]> {
    await this.getPullRequest(ref);
    return this.snapshot.reviews[String(ref.pullNumber)] ?? [];
  }

  async getPullRequestFiles(ref: PullRef): Promise<FileChangeSnapshot[]> {
    await this.getPullRequest(ref);
    return this.snapshot.files[String(ref.pullNumber)] ?? [];
  }

  async listCommits(query: ListCommitsQuery): Promise<ListedCommits> {
    this.requireRepo("listCommits", query.owner, query.repo);
    if (query.pullNumber && query.pullNumber > 0) {
      await this.getPullRequest({
        owner: query.owner,
        repo: query.repo,
        pullNumber: query.pullNumber,
      });
      return this.snapshot.commits[`pr:${query.pullNumber}`] ?? [];
    }
    const bounded = boundRepositoryCommitDiscovery(this.snapshot.commits.repo ?? []);
    return attachCommitDiscoveryTruncation(bounded.items, bounded.truncated);
  }

  async getCommit(ref: CommitRef): Promise<CommitSnapshot> {
    this.requireRepo("getCommit", ref.owner, ref.repo);
    const hit = this.snapshot.commitIndex[ref.sha];
    if (!hit) {
      throw missing("getCommit", `commit ${ref.sha} not in snapshot ${this.snapshot.snapshotId}`);
    }
    return hit;
  }

  async searchRepositories(_query: SearchRepositoriesQuery): Promise<{
    query: string;
    totalCount: number;
    repos: RepositorySearchHit[];
  }> {
    throw new GitHubProviderError({
      code: "invalid_argument",
      operation: "searchRepositories",
      message: "investigation snapshots do not include repository search",
      retryable: false,
    });
  }

  async getReadme(ref: RepoRef): Promise<ReadmeSnapshot> {
    this.requireRepo("getReadme", ref.owner, ref.repo);
    if (!this.snapshot.readme) {
      throw missing("getReadme", `readme not in snapshot ${this.snapshot.snapshotId}`);
    }
    return this.snapshot.readme;
  }

  private requireRepo(operation: string, owner: string, repo: string): void {
    if (!matchesRepo(this.snapshot, owner, repo)) {
      throw missing(
        operation,
        `${owner}/${repo} does not match snapshot ${this.snapshot.owner}/${this.snapshot.repository}`,
      );
    }
  }
}
