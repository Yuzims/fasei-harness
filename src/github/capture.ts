import { GitHubProviderError } from "./errors.js";
import {
  extractCommitShas,
  extractMentionedNumbers,
  extractPullRequestNumbers,
  textClosesIssue,
} from "./normalize.js";
import type { GitHubDataProvider } from "./provider.js";
import {
  GITHUB_SOURCE,
  SNAPSHOT_SCHEMA_VERSION,
  UNTRUSTED,
  type CommitSnapshot,
  type InvestigationSnapshot,
  type PullRequestSnapshot,
  type TimelineEventSnapshot,
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
  const mentioned = uniquePositive([
    ...extractMentionedNumbers(issue.body),
    ...extractMentionedNumbers(issue.title),
    ...comments.flatMap((comment) => extractMentionedNumbers(comment.body)),
  ]).filter((n) => n !== input.issueNumber && !requestedPulls.includes(n));
  const extraPulls =
    input.includeTimelinePulls === false
      ? mentioned.slice(0, 12)
      : uniquePositive([
          ...extractPullRequestNumbers(timeline).filter((n) => n !== input.issueNumber),
          ...mentioned,
        ])
          .filter((n) => !requestedPulls.includes(n))
          .slice(0, 12);
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

  return finalizeInvestigationSnapshot({
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
  });
}

/**
 * Record GitHub facts already present in the snapshot so an agent can follow them.
 * Does not copy evaluator ground truth. Adds:
 * - commit messages onto timeline events that only stored a SHA
 * - cross-referenced timeline events for captured PRs that close the target issue
 *   when GitHub's timeline API omitted that link
 */
export function finalizeInvestigationSnapshot(snapshot: InvestigationSnapshot): InvestigationSnapshot {
  const timeline = snapshot.timeline.map((event) => enrichTimelineCommitMessage(snapshot, event));
  const seen = new Set(
    timeline
      .map((event) => event.pullRequestNumber)
      .filter((value): value is number => typeof value === "number" && value > 0),
  );
  const extra: TimelineEventSnapshot[] = [];
  for (const pr of Object.values(snapshot.pullRequests)) {
    if (seen.has(pr.number)) {
      continue;
    }
    if (!pullClosesTargetIssue(pr, snapshot)) {
      continue;
    }
    seen.add(pr.number);
    extra.push({
      id: `timeline:${snapshot.owner}/${snapshot.repository}:pr-ref-${pr.number}`,
      repository: `${snapshot.owner}/${snapshot.repository}`,
      event: "cross-referenced",
      createdAt: pr.retrievedAt,
      actor: "",
      body: pr.title,
      pullRequestNumber: pr.number,
      source: GITHUB_SOURCE,
      url: pr.url,
      retrievedAt: snapshot.retrievedAt,
      trust: UNTRUSTED,
    });
  }
  return {
    ...snapshot,
    timeline: extra.length > 0 ? [...timeline, ...extra] : timeline,
  };
}

function enrichTimelineCommitMessage(
  snapshot: InvestigationSnapshot,
  event: TimelineEventSnapshot,
): TimelineEventSnapshot {
  const match = event.body.match(/\b[0-9a-f]{7,40}\b/i);
  if (!match) {
    return event;
  }
  const commit = findCommit(snapshot, match[0]);
  if (!commit?.message) {
    return event;
  }
  if (event.body.includes(commit.message.split("\n")[0] ?? commit.message)) {
    return event;
  }
  return { ...event, body: `${event.body}\n${commit.message}` };
}

function findCommit(snapshot: InvestigationSnapshot, sha: string): CommitSnapshot | undefined {
  const needle = sha.toLowerCase();
  const direct = snapshot.commitIndex[sha] ?? snapshot.commitIndex[needle];
  if (direct) {
    return direct;
  }
  const key = Object.keys(snapshot.commitIndex).find(
    (item) => item.toLowerCase().startsWith(needle) || needle.startsWith(item.toLowerCase()),
  );
  return key ? snapshot.commitIndex[key] : undefined;
}

function pullClosesTargetIssue(pr: PullRequestSnapshot, snapshot: InvestigationSnapshot): boolean {
  const text = `${pr.title}\n${pr.body}`;
  return textClosesIssue(text, snapshot.owner, snapshot.repository, snapshot.issueNumber);
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
