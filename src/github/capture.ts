import { GitHubProviderError } from "./errors.js";
import { extractCommitShas, extractPullRequestNumbers } from "./normalize.js";
import type { GitHubDataProvider } from "./provider.js";
import {
  GITHUB_SOURCE,
  SNAPSHOT_SCHEMA_VERSION,
  UNTRUSTED,
  type CommitSnapshot,
  type InvestigationSnapshot,
} from "./types.js";

export interface CaptureInvestigationSnapshotInput {
  snapshotId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  pullNumbers?: number[];
  commitShas?: string[];
  /** When false, only curator-supplied pull numbers are fetched as PR snapshots. */
  includeTimelinePulls?: boolean;
  /** When false, do not dump the repository's latest commits into the snapshot. */
  includeRepoCommits?: boolean;
  createdAt?: string;
}

export async function captureInvestigationSnapshot(
  provider: GitHubDataProvider,
  input: CaptureInvestigationSnapshotInput,
): Promise<InvestigationSnapshot> {
  const debug = process.env.FASEI_CAPTURE_DEBUG === "1";
  const log = (message: string) => {
    if (debug) {
      process.stderr.write(`${message}\n`);
    }
  };
  const owner = input.owner;
  const repo = input.repo;
  const retrievedAt = input.createdAt ?? new Date().toISOString();
  log(`getRepository ${owner}/${repo}`);
  const repositoryData = await provider.getRepository({ owner, repo });
  log(`getIssue ${input.issueNumber}`);
  const issue = await provider.getIssue({ owner, repo, issueNumber: input.issueNumber });
  log("getIssueComments");
  const comments = await provider.getIssueComments({ owner, repo, issueNumber: input.issueNumber });
  log("getIssueTimeline");
  const timeline = await provider.getIssueTimeline({
    owner,
    repo,
    issueNumber: input.issueNumber,
  });
  const requestedPulls = input.pullNumbers ?? [];
  const extraPulls =
    input.includeTimelinePulls === false
      ? []
      : extractPullRequestNumbers(timeline)
          .filter((n) => !requestedPulls.includes(n))
          .slice(0, 6);
  const pullNumbers = uniquePositive([...requestedPulls, ...extraPulls]);
  const pullRequests: InvestigationSnapshot["pullRequests"] = {};
  const reviews: InvestigationSnapshot["reviews"] = {};
  const files: InvestigationSnapshot["files"] = {};
  const commits: InvestigationSnapshot["commits"] = {};
  const commitIndex: InvestigationSnapshot["commitIndex"] = {};

  for (const pullNumber of pullNumbers) {
    log(`getPullRequest ${pullNumber}`);
    const pr = await tryGetPullRequest(provider, owner, repo, pullNumber);
    if (!pr) {
      log(`skip missing PR ${pullNumber}`);
      continue;
    }
    pullRequests[String(pullNumber)] = pr;
    log(`getPullRequestReviews ${pullNumber}`);
    reviews[String(pullNumber)] = await provider.getPullRequestReviews({ owner, repo, pullNumber });
    log(`getPullRequestFiles ${pullNumber}`);
    files[String(pullNumber)] = await provider.getPullRequestFiles({ owner, repo, pullNumber });
    log(`listCommits pr ${pullNumber}`);
    const prCommits = await provider.listCommits({ owner, repo, pullNumber });
    commits[`pr:${pullNumber}`] = prCommits;
    indexCommits(commitIndex, prCommits);
  }

  const referenced: CommitSnapshot[] = [];
  const extraShas = uniqueShas([
    ...(input.commitShas ?? []),
    ...extractCommitShas(timeline),
  ]).slice(0, 8);
  for (const sha of extraShas) {
    if (hasCommit(commitIndex, sha)) {
      continue;
    }
    log(`getCommit ${sha}`);
    const commit = await tryGetCommit(provider, owner, repo, sha);
    if (!commit) {
      continue;
    }
    referenced.push(commit);
    indexCommits(commitIndex, [commit]);
  }
  if (referenced.length > 0) {
    commits.referenced = referenced;
  }

  if (input.includeRepoCommits !== false) {
    const repoCommits = await provider.listCommits({ owner, repo });
    commits.repo = repoCommits;
    indexCommits(commitIndex, repoCommits);
  } else if (referenced.length > 0) {
    commits.repo = referenced;
  }

  return {
    snapshotId: input.snapshotId,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: retrievedAt,
    source: GITHUB_SOURCE,
    owner,
    repository: repo,
    issueNumber: input.issueNumber,
    retrievedAt,
    trust: UNTRUSTED,
    repositoryData,
    issue,
    comments,
    timeline,
    pullRequests,
    reviews,
    files,
    commits,
    commitIndex,
  };
}

function indexCommits(index: Record<string, CommitSnapshot>, commits: CommitSnapshot[]): void {
  for (const commit of commits) {
    if (commit.sha) {
      index[commit.sha] = commit;
    }
  }
}

function uniquePositive(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort(
    (a, b) => a - b,
  );
}

function uniqueShas(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const sha = value.trim().toLowerCase();
    if (sha.length < 7 || seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    result.push(sha);
  }
  return result;
}

function hasCommit(index: Record<string, CommitSnapshot>, sha: string): boolean {
  const needle = sha.toLowerCase();
  return Object.keys(index).some((key) => key.toLowerCase().startsWith(needle) || needle.startsWith(key.toLowerCase()));
}

function isMissingGithubResource(error: unknown): boolean {
  return (
    error instanceof GitHubProviderError &&
    (error.code === "not_found" || error.status === 404 || error.status === 422)
  );
}

async function tryGetPullRequest(
  provider: GitHubDataProvider,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  try {
    return await provider.getPullRequest({ owner, repo, pullNumber });
  } catch (error) {
    if (isMissingGithubResource(error)) {
      return undefined;
    }
    throw error;
  }
}

async function tryGetCommit(
  provider: GitHubDataProvider,
  owner: string,
  repo: string,
  sha: string,
) {
  try {
    return await provider.getCommit({ owner, repo, sha });
  } catch (error) {
    if (isMissingGithubResource(error)) {
      return undefined;
    }
    throw error;
  }
}
