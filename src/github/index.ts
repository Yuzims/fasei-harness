export type { GitHubDataProvider } from "./provider.js";
export { LiveGitHubProvider } from "./live-provider.js";
export { SnapshotGitHubProvider } from "./snapshot-provider.js";
export { captureInvestigationSnapshot, finalizeInvestigationSnapshot } from "./capture.js";
export {
  githubFixturePath,
  loadSnapshot,
  saveSnapshot,
  validateSnapshot,
} from "./snapshot-store.js";
export { GitHubProviderError } from "./errors.js";
export { GithubGraphQlClient, CLOSING_REFERENCES_QUERY_TEMPLATE } from "./graphql.js";
export type {
  ClosingReferenceFacts,
  ClosingReferencesQuery,
  ResolutionReferenceSource,
} from "./graphql.js";
export { GithubCommitHintSource } from "./commit-hints.js";
export type {
  UnlinkedFixCommitQuery,
  UnlinkedFixCommitResult,
  UnlinkedFixCommitSource,
} from "./commit-hints.js";
export { parseGitHubIssueInput, GitHubIssueInputError, INVALID_GITHUB_ISSUE_INPUT } from "./issue-input.js";
export type { ParsedGitHubIssue } from "./issue-input.js";
export {
  extractCommitShas,
  extractMentionedNumbers,
  extractPullRequestNumbers,
  issueHtmlUrl,
  normalizeFileChange,
  textClosesIssue,
} from "./normalize.js";
export {
  applyPatchBudget,
  boundPatch,
  MAX_PATCH_CHARS_PER_FILE,
  MAX_TOTAL_PATCH_CHARS,
} from "./patch-bounds.js";
export {
  attachCommitDiscoveryTruncation,
  boundRepositoryCommitDiscovery,
  commitDiscoveryTruncated,
  MAX_REPOSITORY_COMMIT_DISCOVERY,
  REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE,
  unwrapCommitList,
} from "./commit-bounds.js";
export type { BoundedCommitDiscovery } from "./commit-bounds.js";
export {
  extractSemanticReferences,
  mentionedIssueNumbers,
  SEMANTIC_REFERENCE_KINDS,
} from "./semantic-references.js";
export type { SemanticReference, SemanticReferenceKind } from "./semantic-references.js";
export { SNAPSHOT_SCHEMA_VERSION, UNTRUSTED, GITHUB_SOURCE } from "./types.js";
export type {
  CommentSnapshot,
  CommitSnapshot,
  FileChangeSnapshot,
  InvestigationSnapshot,
  IssueSnapshot,
  PullRequestSnapshot,
  ReadmeSnapshot,
  RepositorySnapshot,
  ReviewSnapshot,
  TimelineEventSnapshot,
  ListedCommits,
} from "./types.js";
