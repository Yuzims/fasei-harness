import {
  type ResolutionPrescanCandidate,
  type ResolutionPrescanRecord,
  type ResolutionPrescanSourceRecord,
} from "../domain/index.js";
import type { GitHubDataProvider } from "../github/provider.js";
import { GitHubProviderError } from "../github/errors.js";
import { extractMentionedNumbers } from "../github/normalize.js";
import type {
  ClosingReferenceFacts,
  ResolutionReferenceSource,
} from "../github/graphql.js";
import type { PullRequestSnapshot } from "../github/types.js";
import { ingestObservation, type InvestigationSession } from "./investigation-tools.js";

export const HARNESS_STRUCTURED_SOURCE = "harness_structured";

/** Deterministic bound on how many enumerated candidates get PR-detail ingestion. */
export const PRESCAN_MAX_CANDIDATES = 12;

export interface ResolutionPrescanDeps {
  session: InvestigationSession;
  provider: GitHubDataProvider;
  graphQl?: ResolutionReferenceSource;
  maxCandidates?: number;
  now?: () => string;
}

function providerErrorCode(error: unknown): string {
  return error instanceof GitHubProviderError ? error.code : "network_error";
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

function mentionNumbers(text: string, issueNumber: number): number[] {
  return extractMentionedNumbers(text).filter((n) => n !== issueNumber);
}

/**
 * Phase 18-A: deterministic resolution-reference pre-scan.
 * Zero LLM calls by construction: this module never sees a Model. It runs the
 * finite structured queries (issue/comments/timeline mention + cross-reference
 * extraction, GraphQL closingIssuesReferences) and ingests everything through
 * the existing observation channel as `harness_structured` evidence BEFORE
 * the agent loop starts. It records facts only — whether a candidate actually
 * fixes the issue is adjudicated downstream, never here.
 */
export async function runResolutionPrescan(
  deps: ResolutionPrescanDeps,
): Promise<ResolutionPrescanRecord> {
  const { session, provider, graphQl } = deps;
  const target = session.state.task.target;
  const ref = { owner: target.owner, repo: target.repository, issueNumber: target.issueNumber };
  const now = deps.now ?? (() => new Date().toISOString());
  const maxCandidates = deps.maxCandidates ?? PRESCAN_MAX_CANDIDATES;
  const startedAt = now();
  const sources: ResolutionPrescanSourceRecord[] = [];
  const ingestion = { provenanceSource: HARNESS_STRUCTURED_SOURCE };
  const enumerated = new Map<number, Set<string>>();

  const addEnumerated = (numbers: number[], channel: string) => {
    for (const number of numbers) {
      if (!Number.isInteger(number) || number <= 0) {
        continue;
      }
      const channels = enumerated.get(number) ?? new Set<string>();
      channels.add(channel);
      enumerated.set(number, channels);
    }
  };

  // 1. Issue observation: ingested, then its title/body mentions feed enumeration.
  try {
    const issue = await provider.getIssue(ref);
    ingestObservation(
      session,
      "github_get_issue",
      { issueNumber: ref.issueNumber },
      issue,
      ingestion,
    );
    addEnumerated(
      mentionNumbers(`${issue.title ?? ""}\n${issue.body ?? ""}`, ref.issueNumber),
      "issue_body_mention",
    );
    sources.push({ source: "rest_issue_mentions", state: "completed" });
  } catch (error) {
    sources.push({
      source: "rest_issue_mentions",
      state: "failed",
      errorCode: providerErrorCode(error),
      detail: providerErrorMessage(error),
    });
  }

  // 2. Comments: `#N` mentions are GitHub's canonical cross-reference syntax —
  // mechanical extraction, no text judgment.
  try {
    const comments = await provider.getIssueComments(ref);
    ingestObservation(
      session,
      "github_get_issue_comments",
      { issueNumber: ref.issueNumber },
      comments,
      ingestion,
    );
    for (const comment of comments) {
      addEnumerated(mentionNumbers(comment.body ?? "", ref.issueNumber), "comment_mention");
    }
    sources.push({ source: "rest_comment_mentions", state: "completed" });
  } catch (error) {
    sources.push({
      source: "rest_comment_mentions",
      state: "failed",
      errorCode: providerErrorCode(error),
      detail: providerErrorMessage(error),
    });
  }

  // 3. REST timeline: structured cross-referenced PR numbers + commit ids come
  // in through ingestTimeline; body mentions are also enumerated here.
  let timelineCommitShas: string[] = [];
  try {
    const timeline = await provider.getIssueTimeline(ref);
    ingestObservation(
      session,
      "github_get_issue_timeline",
      { issueNumber: ref.issueNumber },
      timeline,
      ingestion,
    );
    for (const event of timeline) {
      if (event.pullRequestNumber && event.pullRequestNumber > 0) {
        addEnumerated([event.pullRequestNumber], "timeline_cross_reference");
      }
      addEnumerated(mentionNumbers(event.body ?? "", ref.issueNumber), "timeline_mention");
      if (typeof event.commitId === "string" && event.commitId.trim()) {
        timelineCommitShas.push(event.commitId.trim());
      }
    }
    sources.push({ source: "rest_timeline_references", state: "completed" });
  } catch (error) {
    sources.push({
      source: "rest_timeline_references",
      state: "failed",
      errorCode: providerErrorCode(error),
      detail: providerErrorMessage(error),
    });
  }

  const candidatesEnumerated = enumerated.size;
  let candidates: ResolutionPrescanCandidate[] = [...enumerated.entries()]
    .map(([pullNumber, channels]) => ({
      pullNumber,
      enumeratedBy: [...channels].sort(),
      detailState: "skipped" as const,
    }))
    .sort((a, b) => a.pullNumber - b.pullNumber);

  // 4. GraphQL PR-side closingIssuesReferences: the authoritative link check
  // (react#37610: REST timeline had zero cross-referenced events; only this
  // field connects #37626 to #37610). Records the raw field set per candidate.
  const graphQlFacts = new Map<number, ClosingReferenceFacts>();
  let repositoryNameWithOwner: string | undefined;
  if (graphQl) {
    try {
      const result = await graphQl.getClosingReferences({
        ...ref,
        pullNumbers: candidates.map((candidate) => candidate.pullNumber),
      });
      repositoryNameWithOwner = result.repositoryNameWithOwner;
      for (const fact of result.facts) {
        graphQlFacts.set(fact.pullNumber, fact);
      }
      candidates = candidates.map((candidate) => {
        const fact = graphQlFacts.get(candidate.pullNumber);
        return {
          ...candidate,
          structuredClosingReference:
            fact?.closingIssueNumbers?.includes(ref.issueNumber) ?? (fact ? false : undefined),
          merged: fact?.merged,
          mergedAt: fact?.mergedAt,
          prCreatedAt: fact?.createdAt,
          baseRefName: fact?.baseRefName,
        };
      });
      sources.push({ source: "graphql_closing_references", state: "completed" });
    } catch (error) {
      sources.push({
        source: "graphql_closing_references",
        state: "failed",
        errorCode: providerErrorCode(error),
        detail: providerErrorMessage(error),
      });
    }
  } else {
    sources.push({ source: "graphql_closing_references", state: "skipped" });
  }

  // Field-based ordering only: GraphQL-corroborated candidates first, then by
  // PR number ascending. Never title/text similarity.
  candidates.sort((a, b) => {
    const corroborated =
      Number(b.structuredClosingReference === true) - Number(a.structuredClosingReference === true);
    return corroborated !== 0 ? corroborated : a.pullNumber - b.pullNumber;
  });
  const candidatesTruncated = candidates.length > maxCandidates;
  const prescanCandidates = candidates.slice(0, maxCandidates);

  // 5. PR detail through the existing ingestion channel, marked known so LLM
  // budget goes to semantics instead of rediscovery.
  let failedDetails = 0;
  let fetchedDetails = 0;
  for (const candidate of prescanCandidates) {
    if (graphQlFacts.get(candidate.pullNumber)?.found === false) {
      // GitHub authoritatively says this number is not a PR (e.g. an issue
      // reference). Skipping the REST detail fetch is a field fact, not a failure.
      candidate.detailState = "not_a_pull_request";
      continue;
    }
    try {
      const pr = await provider.getPullRequest({ ...ref, pullNumber: candidate.pullNumber });
      ingestObservation(
        session,
        "github_get_pull_request",
        { pullNumber: candidate.pullNumber },
        pr,
        ingestion,
      );
      applyDetailFacts(candidate, pr);
      candidate.detailState = "completed";
      fetchedDetails += 1;
    } catch {
      candidate.detailState = "failed";
      failedDetails += 1;
    }
  }
  sources.push({
    source: "pr_detail_fetch",
    state: failedDetails > 0 ? "failed" : "completed",
    errorCode: failedDetails > 0 ? "partial_failure" : undefined,
    detail: `${fetchedDetails}/${prescanCandidates.length} candidate PR detail(s) ingested`,
  });

  const record: ResolutionPrescanRecord = {
    state: sources.every((source) => source.state === "completed") ? "completed" : "incomplete",
    startedAt,
    completedAt: now(),
    llmCalls: 0,
    repositoryNameWithOwner,
    sources,
    candidates: prescanCandidates,
    candidatesEnumerated,
    candidatesTruncated,
    commitCandidates: [...new Set(timelineCommitShas.map((sha) => sha.toLowerCase()))].sort(),
  };

  session.state.run.resolutionPrescan = record;
  session.trace.record(
    session.runId,
    session.state.currentStep,
    record.state === "completed" ? "resolution_prescan_completed" : "resolution_prescan_incomplete",
    {
      state: record.state,
      llmCalls: record.llmCalls,
      candidatesEnumerated: record.candidatesEnumerated,
      candidatesTruncated: record.candidatesTruncated,
      candidates: record.candidates.map((candidate) => ({
        pullNumber: candidate.pullNumber,
        enumeratedBy: candidate.enumeratedBy,
        structuredClosingReference: candidate.structuredClosingReference ?? null,
        detailState: candidate.detailState,
      })),
      sources: record.sources,
    },
  );
  return record;
}

/** Fill missing GraphQL facts from the REST PR detail actually ingested. */
function applyDetailFacts(candidate: ResolutionPrescanCandidate, pr: PullRequestSnapshot): void {
  candidate.merged = candidate.merged ?? pr.merged;
  candidate.mergedAt = candidate.mergedAt ?? pr.mergedAt ?? null;
  candidate.prCreatedAt = candidate.prCreatedAt ?? pr.createdAt ?? null;
  candidate.baseRefName = candidate.baseRefName ?? pr.baseRefName ?? null;
}
