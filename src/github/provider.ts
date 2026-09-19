import type {
  CommentSnapshot,
  CommitRef,
  CommitSnapshot,
  FileChangeSnapshot,
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

export interface GitHubDataProvider {
  getRepository(ref: RepoRef): Promise<RepositorySnapshot>;
  getIssue(ref: IssueRef): Promise<IssueSnapshot>;
  getIssueComments(ref: IssueRef): Promise<CommentSnapshot[]>;
  getIssueTimeline(ref: IssueRef): Promise<TimelineEventSnapshot[]>;
  getPullRequest(ref: PullRef): Promise<PullRequestSnapshot>;
  getPullRequestReviews(ref: PullRef): Promise<ReviewSnapshot[]>;
  getPullRequestFiles(ref: PullRef): Promise<FileChangeSnapshot[]>;
  listCommits(query: ListCommitsQuery): Promise<ListedCommits>;
  getCommit(ref: CommitRef): Promise<CommitSnapshot>;
  searchRepositories(query: SearchRepositoriesQuery): Promise<{
    query: string;
    totalCount: number;
    repos: RepositorySearchHit[];
  }>;
  getReadme(ref: RepoRef): Promise<ReadmeSnapshot>;
}
