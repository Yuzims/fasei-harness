import { createHash } from "node:crypto";
import {
  closingKeywordReferencesIssue,
  createEvidence,
  createEvidenceRelation,
  EvidenceGraphError,
  type ClaimPolarity,
  type EvidenceKind,
  type EvidenceRelationType,
  type FailureEvent,
} from "../domain/index.js";
import { asClaimInput, parsePolarity, record_claim } from "./claim-capture.js";
import type { GitHubDataProvider } from "../github/provider.js";
import type { Tool } from "../tools/tool.js";
import { createInvestigationGithubTools } from "../tools/github.js";
import type { LlmUsageCollector } from "../agent/llm-usage.js";
import type { LlmRuntimeGuard } from "../agent/llm-runtime.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { UNTRUSTED_NOTICE } from "./policy.js";
import { GitHubProviderError } from "../github/errors.js";
import { MAX_REPOSITORY_COMMIT_DISCOVERY, unwrapCommitList } from "../github/commit-bounds.js";
import { extractMentionedNumbers } from "../github/normalize.js";
import {
  InvestigationState,
  pullResource,
  resourceKey,
  resourceKeyForTool,
} from "./state.js";
import {
  compactInvestigationToolOutput,
  compactRecordClaimOutput,
  compactRecordResolutionAnalysisOutput,
  type CompactPatchExposure,
} from "./tool-result-context.js";
import {
  attachClaimsToResolutionAnalyses,
  buildResolutionAnalyses,
  recordAuthoredResolutionAnalysis,
} from "./resolution-analysis.js";
import {
  MAX_INVESTIGATED_CANDIDATES,
  applyCandidateSelection,
  candidateSelectionResult,
  discoverCommitCandidates,
  discoverPullCandidates,
  discoveryOutcome,
  recordCandidateDiscovered,
  recordCandidateRanked,
  recordCandidateRejected,
  recordCandidateSelected,
  recordDiscoveryStarted,
  recordInvestigationStarted,
  type IssueRetrievalContext,
  type RetrievalCandidate,
} from "./retrieval/index.js";

const POLARITIES: ClaimPolarity[] = ["resolved", "unresolved", "partial", "unknown"];
const ROLES = ["supports", "contradicts", "contextual"] as const;

export type RetrievalCandidateSelection = (
  candidates: readonly RetrievalCandidate[],
  limit?: number,
) => RetrievalCandidate[];

export interface InvestigationSession {
  state: InvestigationState;
  trace: TraceCollector;
  runId: string;
  llmUsage: LlmUsageCollector;
  currentAttempt?: number;
  llmRuntime?: LlmRuntimeGuard;
  runtimeFailure?: FailureEvent;
  /**
   * Evaluation/test boundary. Production keeps patch_enabled.
   * Controls whether bounded unified diffs enter LLM compact output and
   * Agent-visible Resolution Analysis text. Evidence.payload is unchanged.
   */
  compactPatchExposure?: CompactPatchExposure;
  /**
   * Evaluation/test boundary. Production omits this and uses
   * applyCandidateSelection (evidence-driven ranking + Top-K).
   * The selector must still honor MAX_INVESTIGATED_CANDIDATES.
   */
  candidateSelection?: RetrievalCandidateSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mentionPullNumbers(text: string, issueNumber: number): number[] {
  return extractMentionedNumbers(text).filter((n) => n !== issueNumber);
}

function evidenceIdByRef(session: InvestigationSession, ref: string): string | undefined {
  return session.state.run.evidence.find((item) => item.contentRef === ref)?.id;
}

function relate(
  session: InvestigationSession,
  fromId: string | undefined,
  toId: string | undefined,
  type: EvidenceRelationType,
): void {
  if (!fromId || !toId || fromId === toId) {
    return;
  }
  try {
    const relation = createEvidenceRelation(
      { fromEvidenceId: fromId, toEvidenceId: toId, type },
      {
        evidence: session.state.run.evidence,
        relations: session.state.run.relations,
      },
    );
    session.state.addRelation(relation);
  } catch (error) {
    if (error instanceof EvidenceGraphError) {
      return;
    }
    throw error;
  }
}

function issueRetrievalContext(session: InvestigationSession): IssueRetrievalContext {
  const issue = session.state.run.evidence.find((item) => item.kind === "issue");
  const payload = isRecord(issue?.payload) ? issue.payload : {};
  const createdAt =
    typeof payload.createdAt === "string"
      ? payload.createdAt
      : typeof payload.created_at === "string"
        ? payload.created_at
        : undefined;
  return {
    issueNumber: session.state.task.target.issueNumber,
    issueTitle: typeof payload.title === "string" ? payload.title : undefined,
    issueBody: typeof payload.body === "string" ? payload.body : undefined,
    issueCreatedAt: createdAt,
    structurallyReferencedIds: session.state.retrievalCandidates
      .filter((item) => item.sourceType === "commit")
      .map((item) => item.sourceId),
  };
}

function applyGroupSelection(
  session: InvestigationSession,
  sourceType: RetrievalCandidate["sourceType"],
): void {
  const group = session.state.retrievalCandidates.filter((item) => item.sourceType === sourceType);
  const selector = session.candidateSelection ?? applyCandidateSelection;
  const selected = selector(group, MAX_INVESTIGATED_CANDIDATES);
  const { selected: inBudgetCandidates } = candidateSelectionResult(selected);
  if (inBudgetCandidates.length > MAX_INVESTIGATED_CANDIDATES) {
    throw new Error(
      `retrieval investigation budget exceeded: ${inBudgetCandidates.length} > ${MAX_INVESTIGATED_CANDIDATES}`,
    );
  }
  session.state.replaceRetrievalGroup(sourceType, selected);
  selected.forEach((candidate, rank) => {
    recordCandidateRanked(session, candidate, rank);
    if (candidate.status === "investigating" || candidate.status === "promoted") {
      // Investigation-budget admission for this source type. Not combined retrieval Top-K.
      recordCandidateSelected(session, candidate);
    } else if (candidate.status === "rejected") {
      recordCandidateRejected(session, candidate);
    }
  });
}

function registerPullCandidates(
  session: InvestigationSession,
  pullNumbers: number[],
  extraText = "",
): void {
  const unique = [...new Set(pullNumbers)].filter(
    (number) => Number.isInteger(number) && number > 0 && number !== session.state.task.target.issueNumber,
  );
  if (unique.length === 0) {
    return;
  }
  recordDiscoveryStarted(session, {
    intent: "find_resolution_pr",
    source: "issue_observation",
    candidateBound: MAX_INVESTIGATED_CANDIDATES,
  });
  const discovered = discoverPullCandidates(
    unique.map((number) => ({ number, title: extraText, body: extraText })),
    issueRetrievalContext(session),
  );
  for (const candidate of discovered) {
    session.state.addRetrievalCandidate(candidate);
    recordCandidateDiscovered(session, session.state.retrievalCandidates.find((item) => item.id === candidate.id) ?? candidate);
  }
  applyGroupSelection(session, "pull_request");
}

function discoverRepositoryCommitCandidates(
  session: InvestigationSession,
  output: unknown,
): string[] {
  const { commits: raw, truncated } = unwrapCommitList(output);
  const commits = raw.slice(0, MAX_REPOSITORY_COMMIT_DISCOVERY);
  session.state.investigatedResources.add(resourceKey("commits", "repo"));
  recordDiscoveryStarted(session, {
    intent: "find_resolution_commit",
    truncated: truncated === true,
    discoveryBound: MAX_REPOSITORY_COMMIT_DISCOVERY,
    observedCount: commits.length,
  });
  const discovered = discoverCommitCandidates(
    commits.filter(isRecord).map((commit) => ({
      sha: String(commit.sha ?? ""),
      message: String(commit.message ?? ""),
      createdAt: typeof commit.createdAt === "string" ? commit.createdAt : undefined,
    })),
    issueRetrievalContext(session),
  );
  for (const candidate of discovered) {
    session.state.addRetrievalCandidate(candidate);
    recordCandidateDiscovered(session, candidate);
  }
  applyGroupSelection(session, "commit");
  const outcome = discoveryOutcome({
    candidateCount: discovered.length,
    truncated: truncated === true,
  });
  session.state.retrievalOutcome = outcome.outcome;
  session.state.retrievalOutcomeReason = outcome.reason;
  session.state.discoveryTruncated = truncated === true;
  return [];
}

function issueEvidenceId(session: InvestigationSession): string | undefined {
  return evidenceIdByRef(session, resourceKey("issue", String(session.state.task.target.issueNumber)));
}

function pullEvidenceId(session: InvestigationSession, pullNumber: number): string | undefined {
  return evidenceIdByRef(session, resourceKey("pr", String(pullNumber)));
}

function linkIssueGraph(session: InvestigationSession, issueId: string): void {
  const issueNumber = session.state.task.target.issueNumber;
  relate(session, evidenceIdByRef(session, resourceKey("comments", String(issueNumber))), issueId, "mentions");
  relate(session, evidenceIdByRef(session, resourceKey("timeline", String(issueNumber))), issueId, "references");
  for (const pullNumber of session.state.candidatePrs) {
    const prId = pullEvidenceId(session, pullNumber);
    const merged = session.state.mergedPrs.has(pullNumber);
    relate(session, prId, issueId, merged ? "fixes" : "references");
  }
}

function linkPullGraph(session: InvestigationSession, pullNumber: number, prId: string, merged: boolean): void {
  const issueId = issueEvidenceId(session);
  relate(session, prId, issueId, merged ? "fixes" : "references");
  const mergeId = evidenceIdByRef(session, resourceKey("pr-merge", String(pullNumber)));
  if (merged) {
    relate(session, mergeId, prId, "merges");
  }
  const issueNumber = session.state.task.target.issueNumber;
  relate(session, evidenceIdByRef(session, resourceKey("timeline", String(issueNumber))), prId, "mentions");
  relate(session, evidenceIdByRef(session, resourceKey("comments", String(issueNumber))), prId, "mentions");
  relate(session, evidenceIdByRef(session, resourceKey("reviews", String(pullNumber))), prId, "reviews");
}

function addEvidenceOnce(
  session: InvestigationSession,
  key: string,
  input: Parameters<typeof createEvidence>[0],
): string | undefined {
  if (session.state.investigatedResources.has(key)) {
    return session.state.run.evidence.find((item) => item.contentRef === key)?.id;
  }
  const evidence = createEvidence({
    ...input,
    provenance: {
      ...input.provenance,
      source: "github",
      trust: "external_untrusted",
      rawHash: input.provenance.rawHash ?? hashPayload(input.payload ?? input.summary),
    },
    contentRef: input.contentRef ?? key,
  });
  session.state.investigatedResources.add(key);
  session.state.addEvidence(evidence);
  session.trace.record(session.runId, session.state.currentStep, "evidence_added", {
    evidenceId: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    provenance: evidence.provenance,
  });
  return evidence.id;
}

function ingestIssue(session: InvestigationSession, output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const number = Number(output.number);
  const state = output.state === "closed" ? "closed" : "open";
  session.state.issueState = state;
  const repository = String(output.repository ?? "");
  const url = String(output.url ?? "");
  const retrievedAt = String(output.retrievedAt ?? new Date().toISOString());
  const ids: string[] = [];
  const issueId = addEvidenceOnce(session, resourceKey("issue", String(number)), {
    kind: "issue",
    summary: `Issue #${number} is ${state}: ${String(output.title ?? "")}`,
    payload: output,
    provenance: {
      source: "github",
      operation: "getIssue",
      resource: `issues/${number}`,
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (issueId) {
    ids.push(issueId);
    linkIssueGraph(session, issueId);
  }
  const title = String(output.title ?? "");
  const body = String(output.body ?? "");
  const mentioned: number[] = [];
  for (const pullNumber of mentionPullNumbers(`${title}\n${body}`, session.state.task.target.issueNumber)) {
    session.state.addCandidatePr(pullNumber);
    mentioned.push(pullNumber);
  }
  registerPullCandidates(session, mentioned, `${title}\n${body}`);
  return ids;
}

function ingestComments(session: InvestigationSession, output: unknown): string[] {
  const comments = asArray(output);
  const issueNumber = session.state.task.target.issueNumber;
  const ids: string[] = [];
  const first = comments.find(isRecord);
  const repository = first ? String(first.repository ?? "") : session.state.task.target.owner + "/" + session.state.task.target.repository;
  const retrievedAt = first ? String(first.retrievedAt ?? new Date().toISOString()) : new Date().toISOString();
  const url = first ? String(first.url ?? "") : undefined;
  const commentId = addEvidenceOnce(session, resourceKey("comments", String(issueNumber)), {
    kind: "comment",
    summary: `${comments.length} comment(s) on issue #${issueNumber}`,
    payload: comments,
    provenance: {
      source: "github",
      operation: "getIssueComments",
      resource: `issues/${issueNumber}#comments`,
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (commentId) {
    ids.push(commentId);
    const issueId = issueEvidenceId(session);
    relate(session, commentId, issueId, "mentions");
    for (const pullNumber of session.state.candidatePrs) {
      relate(session, commentId, pullEvidenceId(session, pullNumber), "mentions");
    }
  }
  const mentioned: number[] = [];
  for (const comment of comments) {
    if (!isRecord(comment)) {
      continue;
    }
    for (const pullNumber of mentionPullNumbers(String(comment.body ?? ""), issueNumber)) {
      session.state.addCandidatePr(pullNumber);
      mentioned.push(pullNumber);
      relate(session, commentId, pullEvidenceId(session, pullNumber), "mentions");
    }
  }
  registerPullCandidates(session, mentioned);
  return ids;
}

function ingestTimeline(session: InvestigationSession, output: unknown): string[] {
  const events = asArray(output);
  const issueNumber = session.state.task.target.issueNumber;
  const first = events.find(isRecord);
  const repository = first
    ? String(first.repository ?? "")
    : `${session.state.task.target.owner}/${session.state.task.target.repository}`;
  const retrievedAt = first ? String(first.retrievedAt ?? new Date().toISOString()) : new Date().toISOString();
  const url = first ? String(first.url ?? "") : undefined;
  const ids: string[] = [];
  const timelineId = addEvidenceOnce(session, resourceKey("timeline", String(issueNumber)), {
    kind: "timeline",
    summary: `Timeline for issue #${issueNumber} (${events.length} event(s))`,
    payload: events,
    provenance: {
      source: "github",
      operation: "getIssueTimeline",
      resource: `issues/${issueNumber}#timeline`,
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (timelineId) {
    ids.push(timelineId);
    relate(session, timelineId, issueEvidenceId(session), "references");
  }
  const mentioned: number[] = [];
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    const pullNumber = Number(event.pullRequestNumber);
    if (Number.isInteger(pullNumber) && pullNumber > 0) {
      session.state.addCandidatePr(pullNumber);
      mentioned.push(pullNumber);
      relate(session, timelineId, pullEvidenceId(session, pullNumber), "mentions");
    }
    for (const mentionedNumber of mentionPullNumbers(String(event.body ?? ""), issueNumber)) {
      session.state.addCandidatePr(mentionedNumber);
      mentioned.push(mentionedNumber);
      relate(session, timelineId, pullEvidenceId(session, mentionedNumber), "mentions");
    }
    const shaMatch = /\b([0-9a-f]{7,40})\b/i.exec(String(event.body ?? ""));
    if (shaMatch?.[1]) {
      const commitId = evidenceIdByRef(session, resourceKey("commit", shaMatch[1]));
      if (commitId && closingKeywordReferencesIssue(String(event.body ?? ""), issueNumber)) {
        relate(session, commitId, issueEvidenceId(session), "fixes");
      }
    }
  }
  registerPullCandidates(session, mentioned);
  return ids;
}

function ingestPullRequest(session: InvestigationSession, output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const number = Number(output.number);
  const merged = output.merged === true;
  const repository = String(output.repository ?? "");
  const url = String(output.url ?? "");
  const retrievedAt = String(output.retrievedAt ?? new Date().toISOString());
  session.state.investigatedResources.add(resourceKey("pull", String(number)));
  if (merged) {
    session.state.mergedPrs.add(number);
    session.state.unmergedPrs.delete(number);
  } else {
    session.state.unmergedPrs.add(number);
    session.state.addQuestion(
      `PR #${number} is related but not merged; issue closed is not sufficient resolution evidence.`,
    );
  }
  session.state.addCandidatePr(number);
  const existing = session.state.retrievalCandidates.find(
    (item) => item.sourceType === "pull_request" && item.sourceId === String(number),
  );
  if (existing) {
    session.state.setRetrievalCandidateStatus("pull_request", String(number), "investigating");
    recordInvestigationStarted(session, { ...existing, status: "investigating" });
  }
  const ids: string[] = [];
  const prId = addEvidenceOnce(session, resourceKey("pr", String(number)), {
    kind: "pull_request",
    summary: `PR #${number} is ${String(output.state ?? "unknown")}; title=${String(output.title ?? "")}`,
    payload: output,
    provenance: {
      source: "github",
      operation: "getPullRequest",
      resource: pullResource(number),
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (prId) {
    ids.push(prId);
  }
  const mergeId = addEvidenceOnce(session, resourceKey("pr-merge", String(number)), {
    kind: "pull_request",
    summary: `PR #${number} merged=${merged}`,
    payload: { number, merged, mergeCommitSha: output.mergeCommitSha ?? null },
    provenance: {
      source: "github",
      operation: "getPullRequest",
      resource: pullResource(number),
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (mergeId) {
    ids.push(mergeId);
  }
  if (prId) {
    linkPullGraph(session, number, prId, merged);
    if (existing) {
      session.state.setRetrievalCandidateStatus("pull_request", String(number), "promoted");
    }
  }
  return ids;
}

function ingestReviews(session: InvestigationSession, output: unknown, pullNumber: number): string[] {
  const reviews = asArray(output);
  const first = reviews.find(isRecord);
  const repository = first ? String(first.repository ?? "") : "";
  const retrievedAt = first ? String(first.retrievedAt ?? new Date().toISOString()) : new Date().toISOString();
  const url = first ? String(first.url ?? "") : undefined;
  const id = addEvidenceOnce(session, resourceKey("reviews", String(pullNumber)), {
    kind: "review",
    summary: `${reviews.length} review(s) on PR #${pullNumber}`,
    payload: reviews,
    provenance: {
      source: "github",
      operation: "getPullRequestReviews",
      resource: `${pullResource(pullNumber)}/reviews`,
      url,
      repository,
      retrievedAt,
      trust: "external_untrusted",
    },
  });
  if (id) {
    relate(session, id, pullEvidenceId(session, pullNumber), "reviews");
    return [id];
  }
  return [];
}

function ingestFiles(session: InvestigationSession, output: unknown, pullNumber: number): string[] {
  const files = asArray(output);
  const names: string[] = [];
  const ids: string[] = [];
  session.state.investigatedResources.add(resourceKey("files", String(pullNumber)));
  for (const file of files) {
    if (!isRecord(file)) {
      continue;
    }
    const filename = String(file.filename ?? "");
    names.push(filename);
    const id = addEvidenceOnce(session, resourceKey("file", `${pullNumber}:${filename}`), {
      kind: "file",
      summary: `PR #${pullNumber} ${String(file.status ?? "modified")} ${filename}`,
      payload: file,
      provenance: {
        source: "github",
        operation: "getPullRequestFiles",
        resource: `${pullResource(pullNumber)}/files/${filename}`,
        url: String(file.url ?? ""),
        repository: String(file.repository ?? ""),
        retrievedAt: String(file.retrievedAt ?? new Date().toISOString()),
        trust: "external_untrusted",
      },
    });
    if (id) {
      ids.push(id);
      relate(session, id, pullEvidenceId(session, pullNumber), "derived_from");
    }
  }
  session.state.filesByPr.set(pullNumber, names);
  return ids;
}

function ingestCommitRecord(
  session: InvestigationSession,
  commit: Record<string, unknown>,
  operation: "listCommits" | "getCommit",
  pullNumber: number | undefined,
): string | undefined {
  const sha = String(commit.sha ?? "");
  const id = addEvidenceOnce(session, resourceKey("commit", sha), {
    kind: "commit",
    summary: `Commit ${sha.slice(0, 12)}: ${String(commit.message ?? "").split("\n")[0] ?? ""}`,
    payload: commit,
    provenance: {
      source: "github",
      operation,
      resource: sha ? `commit/${sha}` : "commits",
      url: String(commit.url ?? ""),
      repository: String(commit.repository ?? ""),
      retrievedAt: String(commit.retrievedAt ?? new Date().toISOString()),
      trust: "external_untrusted",
    },
  });
  if (!id) {
    return undefined;
  }
  const issueId = issueEvidenceId(session);
  const issueNumber = session.state.task.target.issueNumber;
  const message = String(commit.message ?? "");
  if (closingKeywordReferencesIssue(message, issueNumber)) {
    relate(session, id, issueId, "fixes");
  }
  if (pullNumber && pullNumber > 0) {
    const prId = pullEvidenceId(session, pullNumber);
    relate(session, id, prId, "derived_from");
    const merge = session.state.run.evidence.find(
      (item) => item.contentRef === resourceKey("pr-merge", String(pullNumber)),
    );
    const mergeSha =
      merge && isRecord(merge.payload) && typeof merge.payload.mergeCommitSha === "string"
        ? merge.payload.mergeCommitSha
        : undefined;
    if (mergeSha && sha && mergeSha === sha) {
      relate(session, id, prId, "merges");
    }
  }
  return id;
}

function ingestCommits(session: InvestigationSession, output: unknown, pullNumber: number | undefined): string[] {
  const repositoryWide = !(pullNumber && pullNumber > 0);
  if (repositoryWide) {
    return discoverRepositoryCommitCandidates(session, output);
  }
  const { commits: raw } = unwrapCommitList(output);
  const ids: string[] = [];
  session.state.investigatedResources.add(resourceKey("commits", String(pullNumber)));
  for (const commit of raw) {
    if (!isRecord(commit)) {
      continue;
    }
    const id = ingestCommitRecord(session, commit, "listCommits", pullNumber);
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function ingestInvestigatedCommit(session: InvestigationSession, output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const sha = String(output.sha ?? "");
  const existing = session.state.retrievalCandidates.find(
    (item) => item.sourceType === "commit" && item.sourceId === sha,
  );
  if (existing) {
    session.state.setRetrievalCandidateStatus("commit", sha, "investigating");
    recordInvestigationStarted(session, { ...existing, status: "investigating" });
  }
  const id = ingestCommitRecord(session, output, "getCommit", undefined);
  if (id && existing) {
    session.state.setRetrievalCandidateStatus("commit", sha, "promoted");
  }
  return id ? [id] : [];
}

function syncResolutionAnalyses(session: InvestigationSession): void {
  session.state.run.resolutionAnalyses = buildResolutionAnalyses(session.state.run, {
    preserveCandidateIds: session.state.authoredResolutionCandidates,
    exposePatch: session.compactPatchExposure !== "metadata_only",
  });
}

export function ingestObservation(
  session: InvestigationSession,
  toolName: string,
  args: Record<string, unknown>,
  output: unknown,
): string[] {
  let ids: string[];
  switch (toolName) {
    case "github_get_issue":
      ids = ingestIssue(session, output);
      break;
    case "github_get_issue_comments":
      ids = ingestComments(session, output);
      break;
    case "github_get_issue_timeline":
      ids = ingestTimeline(session, output);
      break;
    case "github_get_pull_request":
      ids = ingestPullRequest(session, output);
      break;
    case "github_get_pull_request_reviews":
      ids = ingestReviews(session, output, Number(args.pullNumber));
      break;
    case "github_get_pull_request_files":
      ids = ingestFiles(session, output, Number(args.pullNumber));
      break;
    case "github_list_commits":
      ids = ingestCommits(
        session,
        output,
        typeof args.pullNumber === "number" ? args.pullNumber : undefined,
      );
      break;
    case "github_get_commit":
      ids = ingestInvestigatedCommit(session, output);
      break;
    default:
      return [];
  }
  syncResolutionAnalyses(session);
  return ids;
}

function cachedPayload(session: InvestigationSession, key: string): unknown {
  return session.state.run.evidence.find((item) => item.contentRef === key)?.payload;
}

function wrapGithubTool(tool: Tool, session: InvestigationSession): Tool {
  return {
    name: tool.name,
    description: `${tool.description} ${UNTRUSTED_NOTICE}`,
    parameters: tool.parameters,
    async execute(args) {
      const key = resourceKeyForTool(tool.name, args);
      const refetch = Boolean(key && session.state.refetchResources.has(key));
      if (key && session.state.investigatedResources.has(key) && !refetch) {
        const existing = session.state.run.evidence.find((item) => item.contentRef === key);
        session.state.recordTool({
          tool: tool.name,
          arguments: args,
          success: true,
          evidenceIds: existing ? [existing.id] : [],
          cached: true,
          reason: session.state.lastDecisionReason,
        });
        return compactInvestigationToolOutput({
          tool: tool.name,
          args,
          output: cachedPayload(session, key),
          evidenceIds: existing ? [existing.id] : [],
          cached: true,
          patchExposure: session.compactPatchExposure,
        });
      }
      if (key) {
        session.state.refetchResources.delete(key);
      }
      try {
        const output = await tool.execute(args);
        const evidenceIds = ingestObservation(session, tool.name, args, output);
        session.state.recordTool({
          tool: tool.name,
          arguments: args,
          success: true,
          evidenceIds,
          reason: session.state.lastDecisionReason,
        });
        return compactInvestigationToolOutput({
          tool: tool.name,
          args,
          output,
          evidenceIds,
          patchExposure: session.compactPatchExposure,
        });
      } catch (error) {
        const providerError = error instanceof GitHubProviderError ? error : undefined;
        if (key && providerError && providerError.retryable === false) {
          session.state.investigatedResources.add(key);
        }
        session.state.recordTool({
          tool: tool.name,
          arguments: args,
          success: false,
          evidenceIds: [],
          error: error instanceof Error ? error.message : String(error),
          errorCode: providerError?.code,
          httpStatus: providerError?.status,
          retryable: providerError?.retryable,
          reason: session.state.lastDecisionReason,
        });
        throw error;
      }
    },
  };
}

function asClaimList(args: Record<string, unknown>) {
  if (Array.isArray(args.claims)) {
    return args.claims.flatMap((item) => {
      const parsed = asClaimInput(item);
      return parsed ? [parsed] : [];
    });
  }
  if (typeof args.text === "string") {
    const parsed = asClaimInput(args);
    return parsed ? [parsed] : [];
  }
  return [];
}

export function createRecordClaimTool(session: InvestigationSession): Tool {
  return {
    name: "record_claim",
    description:
      "Record structured claims linked to existing evidence IDs. This does not verify the investigation and cannot set VERIFIED_COMPLETE.",
    parameters: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          description: "Claims to record",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              polarity: { type: "string", enum: POLARITIES },
              critical: { type: "boolean" },
              evidenceIds: { type: "array", items: { type: "string" } },
              role: { type: "string", enum: ROLES },
            },
            required: ["text", "polarity", "evidenceIds"],
          },
        },
        text: { type: "string" },
        polarity: { type: "string", enum: POLARITIES },
        evidenceIds: { type: "array", items: { type: "string" } },
        unresolvedQuestions: { type: "array", items: { type: "string" } },
        conclusion: { type: "string" },
      },
    },
    async execute(args) {
      const recorded = record_claim(session, asClaimList(args), { source: "record_claim" });
      if (Array.isArray(args.unresolvedQuestions)) {
        for (const question of args.unresolvedQuestions) {
          if (typeof question === "string") {
            session.state.addQuestion(question);
          }
        }
      }
      if (typeof args.conclusion === "string" && args.conclusion.trim()) {
        session.state.conclusion = args.conclusion.trim();
      }
      if (typeof args.polarity === "string") {
        session.state.polarity = parsePolarity(args.polarity);
      }
      // Tool-only boundary state. The shared Claim writer (and Agent final-claim
      // capture) must not touch claimsRecorded or Resolution Analysis.
      session.state.claimsRecorded =
        recorded.claimIds.length > 0 || session.state.run.claims.length > 0;
      attachClaimsToResolutionAnalyses(session.state.run);
      session.state.recordTool({
        tool: "record_claim",
        arguments: { claimCount: recorded.claimIds.length },
        success: true,
        evidenceIds: [],
        reason: session.state.lastDecisionReason,
      });
      return compactRecordClaimOutput(recorded.claimIds);
    },
  };
}

export function createRecordResolutionAnalysisTool(session: InvestigationSession): Tool {
  return {
    name: "record_resolution_analysis",
    description:
      "Record a structured Resolution Analysis linked to existing Evidence IDs. Separate observed facts from inference. This is a hypothesis and cannot set VERIFIED_COMPLETE.",
    parameters: {
      type: "object",
      properties: {
        candidateEvidenceId: { type: "string" },
        issueEvidenceId: { type: "string" },
        mergeCommitSha: { type: "string" },
        codeRelevance: { type: "string" },
        behavioralAlignment: { type: "string" },
        testSupport: { type: "string" },
        unresolvedQuestions: { type: "array", items: { type: "string" } },
        supportingEvidenceIds: { type: "array", items: { type: "string" } },
        claimIds: { type: "array", items: { type: "string" } },
      },
      required: [
        "candidateEvidenceId",
        "issueEvidenceId",
        "codeRelevance",
        "behavioralAlignment",
        "testSupport",
      ],
    },
    async execute(args) {
      const recorded = recordAuthoredResolutionAnalysis(session.state.run, {
        candidateEvidenceId: String(args.candidateEvidenceId ?? ""),
        issueEvidenceId: String(args.issueEvidenceId ?? ""),
        mergeCommitSha: typeof args.mergeCommitSha === "string" ? args.mergeCommitSha : undefined,
        codeRelevance: String(args.codeRelevance ?? ""),
        behavioralAlignment: String(args.behavioralAlignment ?? ""),
        testSupport: String(args.testSupport ?? ""),
        unresolvedQuestions: Array.isArray(args.unresolvedQuestions)
          ? args.unresolvedQuestions.filter((item): item is string => typeof item === "string")
          : [],
        supportingEvidenceIds: Array.isArray(args.supportingEvidenceIds)
          ? args.supportingEvidenceIds.filter((item): item is string => typeof item === "string")
          : [],
        claimIds: Array.isArray(args.claimIds)
          ? args.claimIds.filter((item): item is string => typeof item === "string")
          : [],
      });
      for (const question of recorded.unresolvedQuestions) {
        session.state.addQuestion(question);
      }
      const ids: string[] = [];
      if (recorded.analysis) {
        session.state.addResolutionAnalysis(recorded.analysis);
        session.state.authoredResolutionCandidates.add(recorded.analysis.candidateEvidenceId);
        attachClaimsToResolutionAnalyses(session.state.run);
        ids.push(recorded.analysis.id);
      }
      session.state.recordTool({
        tool: "record_resolution_analysis",
        arguments: { recorded: ids.length },
        success: true,
        evidenceIds: recorded.analysis?.supportingEvidenceIds ?? [],
        reason: session.state.lastDecisionReason,
      });
      return compactRecordResolutionAnalysisOutput(ids);
    },
  };
}

export function createInvestigationToolList(
  provider: GitHubDataProvider,
  session: InvestigationSession,
): Tool[] {
  const github = createInvestigationGithubTools({ provider }).map((tool) =>
    wrapGithubTool(tool, session),
  );
  return [...github, createRecordClaimTool(session), createRecordResolutionAnalysisTool(session)];
}

export function evidenceKindFromTool(toolName: string): EvidenceKind | undefined {
  switch (toolName) {
    case "github_get_issue":
      return "issue";
    case "github_get_issue_comments":
      return "comment";
    case "github_get_issue_timeline":
      return "timeline";
    case "github_get_pull_request":
      return "pull_request";
    case "github_get_pull_request_reviews":
      return "review";
    case "github_get_pull_request_files":
      return "file";
    case "github_list_commits":
      return "commit";
    case "github_get_commit":
      return "commit";
    default:
      return undefined;
  }
}
