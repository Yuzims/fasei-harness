import { GitHubProviderError } from "./errors.js";
import { daysAgoIso, encodeRepo, GithubHttpClient, type GithubHttpOptions } from "./http.js";
import {
  asArray,
  asRecord,
  normalizeComment,
  normalizeCommit,
  normalizeFileChange,
  normalizeIssue,
  normalizePullRequest,
  normalizeReadme,
  normalizeRepository,
  normalizeReview,
  normalizeSearchHit,
  normalizeTimelineEvent,
} from "./normalize.js";
import { applyPatchBudget } from "./patch-bounds.js";
import type { GitHubDataProvider } from "./provider.js";
import type {
  CommentSnapshot,
  CommitRef,
  CommitSnapshot,
  FileChangeSnapshot,
  IssueRef,
  IssueSnapshot,
  ListCommitsQuery,
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

function requireId(owner: string, repo: string, operation: string): { owner: string; repo: string } {
  const o = owner.trim();
  const r = repo.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(o) || !/^[A-Za-z0-9_.-]+$/.test(r)) {
    throw new GitHubProviderError({
      code: "invalid_argument",
      operation,
      message: "owner/repo must be a GitHub repository id",
      retryable: false,
    });
  }
  return { owner: o, repo: r };
}

export class LiveGitHubProvider implements GitHubDataProvider {
  private readonly http: GithubHttpClient;

  constructor(options: GithubHttpOptions = {}) {
    this.http = new GithubHttpClient(options);
  }

  async getRepository(ref: RepoRef): Promise<RepositorySnapshot> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getRepository");
    const raw = await this.http.getJson("getRepository", `/repos/${encodeRepo(owner, repo)}`);
    return normalizeRepository(raw, this.http.retrievedAt(), { owner, repo });
  }

  async getIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getIssue");
    const raw = await this.http.getJson(
      "getIssue",
      `/repos/${encodeRepo(owner, repo)}/issues/${ref.issueNumber}`,
    );
    return normalizeIssue(raw, owner, repo, this.http.retrievedAt());
  }

  async getIssueComments(ref: IssueRef): Promise<CommentSnapshot[]> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getIssueComments");
    const raw = await this.http.getJsonPages(
      "getIssueComments",
      `/repos/${encodeRepo(owner, repo)}/issues/${ref.issueNumber}/comments?per_page=100`,
    );
    const retrievedAt = this.http.retrievedAt();
    return raw.map((item) => normalizeComment(item, owner, repo, ref.issueNumber, retrievedAt));
  }

  async getIssueTimeline(ref: IssueRef): Promise<TimelineEventSnapshot[]> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getIssueTimeline");
    const raw = await this.http.getJsonPages(
      "getIssueTimeline",
      `/repos/${encodeRepo(owner, repo)}/issues/${ref.issueNumber}/timeline?per_page=100`,
    );
    const retrievedAt = this.http.retrievedAt();
    return raw.map((item) => normalizeTimelineEvent(item, owner, repo, retrievedAt));
  }

  async getPullRequest(ref: PullRef): Promise<PullRequestSnapshot> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getPullRequest");
    const raw = await this.http.getJson(
      "getPullRequest",
      `/repos/${encodeRepo(owner, repo)}/pulls/${ref.pullNumber}`,
    );
    return normalizePullRequest(raw, owner, repo, this.http.retrievedAt());
  }

  async getPullRequestReviews(ref: PullRef): Promise<ReviewSnapshot[]> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getPullRequestReviews");
    const raw = await this.http.getJsonPages(
      "getPullRequestReviews",
      `/repos/${encodeRepo(owner, repo)}/pulls/${ref.pullNumber}/reviews?per_page=100`,
    );
    const retrievedAt = this.http.retrievedAt();
    return raw.map((item) => normalizeReview(item, owner, repo, ref.pullNumber, retrievedAt));
  }

  async getPullRequestFiles(ref: PullRef): Promise<FileChangeSnapshot[]> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getPullRequestFiles");
    const raw = await this.http.getJsonPages(
      "getPullRequestFiles",
      `/repos/${encodeRepo(owner, repo)}/pulls/${ref.pullNumber}/files?per_page=100`,
    );
    const retrievedAt = this.http.retrievedAt();
    return applyPatchBudget(
      raw.map((item) => normalizeFileChange(item, owner, repo, ref.pullNumber, retrievedAt)),
    );
  }

  async listCommits(query: ListCommitsQuery): Promise<CommitSnapshot[]> {
    const { owner, repo } = requireId(query.owner, query.repo, "listCommits");
    const path =
      query.pullNumber && query.pullNumber > 0
        ? `/repos/${encodeRepo(owner, repo)}/pulls/${query.pullNumber}/commits?per_page=100`
        : `/repos/${encodeRepo(owner, repo)}/commits?per_page=30${
            query.sha ? `&sha=${encodeURIComponent(query.sha)}` : ""
          }`;
    const raw = await this.http.getJsonPages("listCommits", path);
    const retrievedAt = this.http.retrievedAt();
    return raw.map((item) => normalizeCommit(item, owner, repo, retrievedAt));
  }

  async getCommit(ref: CommitRef): Promise<CommitSnapshot> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getCommit");
    const raw = await this.http.getJson(
      "getCommit",
      `/repos/${encodeRepo(owner, repo)}/commits/${encodeURIComponent(ref.sha)}`,
    );
    return normalizeCommit(raw, owner, repo, this.http.retrievedAt());
  }

  async searchRepositories(query: SearchRepositoriesQuery): Promise<{
    query: string;
    totalCount: number;
    repos: RepositorySearchHit[];
  }> {
    let q = query.query.trim();
    if (!q) {
      throw new GitHubProviderError({
        code: "invalid_argument",
        operation: "searchRepositories",
        message: "query must be a non-empty string",
        retryable: false,
      });
    }
    if (query.sinceDays && !/created:/.test(q)) {
      q += ` created:>${daysAgoIso(query.sinceDays)}`;
    }
    const sort = query.sort === "updated" ? "updated" : "stars";
    const path = `/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=8`;
    const raw = asRecord(await this.http.getJson("searchRepositories", path));
    const retrievedAt = this.http.retrievedAt();
    const repos = asArray(raw.items).map((item) => normalizeSearchHit(item, retrievedAt));
    return {
      query: q,
      totalCount: typeof raw.total_count === "number" ? raw.total_count : repos.length,
      repos,
    };
  }

  async getReadme(ref: RepoRef): Promise<ReadmeSnapshot> {
    const { owner, repo } = requireId(ref.owner, ref.repo, "getReadme");
    const markdown = await this.http.getText(
      "getReadme",
      `/repos/${encodeRepo(owner, repo)}/readme`,
      "application/vnd.github.raw",
    );
    return normalizeReadme(markdown, owner, repo, this.http.retrievedAt());
  }
}
