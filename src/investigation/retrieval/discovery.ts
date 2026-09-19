import { createRetrievalCandidate, type RetrievalCandidate } from "./candidate.js";
import {
  computeRelevanceSignals,
  type IssueRetrievalContext,
  type RankableRecord,
} from "./ranking.js";

export const NO_CANDIDATE_FOUND = "no_candidate_found";

export const NO_CANDIDATE_IN_WINDOW =
  "No usable candidate was found in the current bounded discovery window. This does not mean no relevant commit exists.";

export interface DiscoveredCommit {
  sha: string;
  message: string;
  createdAt?: string;
}

export interface DiscoveredPull {
  number: number;
  title?: string;
  body?: string;
  createdAt?: string;
}

function candidateFromRecord(
  sourceType: RetrievalCandidate["sourceType"],
  record: RankableRecord,
  context: IssueRetrievalContext,
  retrievalReason: string,
): RetrievalCandidate | undefined {
  if (!record.sourceId) {
    return undefined;
  }
  return createRetrievalCandidate({
    sourceType,
    sourceId: record.sourceId,
    relevanceSignals: computeRelevanceSignals(record, context),
    retrievalReason,
    status: "candidate",
  });
}

export function discoverCommitCandidates(
  commits: readonly DiscoveredCommit[],
  context: IssueRetrievalContext,
): RetrievalCandidate[] {
  const seen = new Set<string>();
  const candidates: RetrievalCandidate[] = [];
  for (const commit of commits) {
    const sha = commit.sha.trim();
    if (!sha || seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    const candidate = candidateFromRecord(
      "commit",
      { sourceId: sha, text: commit.message, createdAt: commit.createdAt },
      context,
      "Discovered from repository commit listing.",
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function discoverPullCandidates(
  pulls: readonly DiscoveredPull[],
  context: IssueRetrievalContext,
): RetrievalCandidate[] {
  const seen = new Set<string>();
  const candidates: RetrievalCandidate[] = [];
  for (const pull of pulls) {
    if (!Number.isInteger(pull.number) || pull.number <= 0) {
      continue;
    }
    const sourceId = String(pull.number);
    if (seen.has(sourceId) || pull.number === context.issueNumber) {
      continue;
    }
    seen.add(sourceId);
    const text = `${pull.title ?? ""} ${pull.body ?? ""}`.trim();
    const candidate = candidateFromRecord(
      "pull_request",
      { sourceId, text, createdAt: pull.createdAt },
      context,
      "Discovered from issue observations as a pull-request pointer.",
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function discoveryOutcome(input: {
  candidateCount: number;
  truncated?: boolean;
}): {
  outcome: "ok" | typeof NO_CANDIDATE_FOUND;
  reason?: string;
} {
  if (input.candidateCount > 0) {
    return { outcome: "ok" };
  }
  return {
    outcome: NO_CANDIDATE_FOUND,
    reason: input.truncated ? NO_CANDIDATE_IN_WINDOW : NO_CANDIDATE_FOUND,
  };
}
