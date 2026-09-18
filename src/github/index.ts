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
export { parseGitHubIssueInput, GitHubIssueInputError, INVALID_GITHUB_ISSUE_INPUT } from "./issue-input.js";
export type { ParsedGitHubIssue } from "./issue-input.js";
export { extractCommitShas, extractMentionedNumbers, extractPullRequestNumbers, textClosesIssue } from "./normalize.js";
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
} from "./types.js";
