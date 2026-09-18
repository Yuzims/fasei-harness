/**
 * Deterministic observation-based test driver.
 *
 * This is a TEST FIXTURE, not a real Investigation Agent.
 * Product investigation uses LLM function calling (OpenAI-compatible tool calls).
 * Do not treat this driver as autonomous keyword classification or a scripted
 * Issue → Timeline → PR pipeline: each next tool is chosen from current
 * investigation state (what has actually been observed).
 */
import { randomUUID } from "node:crypto";
import type { Task, ToolResult } from "../core/types.js";
import type { HistoryMessage, Model, ModelContext, ModelResponse } from "../agent/model.js";
import type { ClaimPolarity } from "../domain/index.js";
import { resourceKey, type InvestigationState } from "./state.js";

export const TEST_DRIVER_NOTICE =
  "SnapshotInvestigationDriver is a deterministic test fixture, not a real Investigation Agent.";

export interface DriverToolAction {
  type: "tool_call";
  name: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface DriverFinalAction {
  type: "final";
  message: string;
  reason: string;
}

export type DriverAction = DriverToolAction | DriverFinalAction;

function targetArgs(state: InvestigationState): { owner: string; repo: string; issueNumber: number } {
  return {
    owner: state.task.target.owner,
    repo: state.task.target.repository,
    issueNumber: state.task.target.issueNumber,
  };
}

function evidenceId(state: InvestigationState, kind: string, pred?: (payload: unknown) => boolean): string[] {
  return state.run.evidence
    .filter((item) => item.kind === kind && (!pred || pred(item.payload)))
    .map((item) => item.id);
}

function prPayloadNumber(payload: unknown): number | undefined {
  if (payload && typeof payload === "object" && "number" in payload) {
    const value = (payload as { number?: unknown }).number;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

export function buildDriverClaims(state: InvestigationState): Record<string, unknown> {
  const issueIds = evidenceId(state, "issue");
  const timelineIds = evidenceId(state, "timeline");
  const commentIds = evidenceId(state, "comment");
  const claims: Array<Record<string, unknown>> = [];
  const issueNumber = state.task.target.issueNumber;
  const questions: string[] = [...state.unresolvedQuestions];

  if (issueIds.length > 0) {
    claims.push({
      text: `Issue #${issueNumber} is ${state.issueState ?? "unknown"}.`,
      polarity: state.issueState === "closed" ? "unknown" : "unresolved",
      critical: false,
      evidenceIds: issueIds,
      role: "contextual",
    });
  }

  for (const pullNumber of state.candidatePrs) {
    const prIds = state.run.evidence
      .filter(
        (item) =>
          item.kind === "pull_request" &&
          (item.provenance.resource === `pull/${pullNumber}` || prPayloadNumber(item.payload) === pullNumber),
      )
      .map((item) => item.id);
    const mergeIds = state.run.evidence
      .filter((item) => item.contentRef === resourceKey("pr-merge", String(pullNumber)))
      .map((item) => item.id);
    const fileIds = state.run.evidence
      .filter(
        (item) =>
          item.kind === "file" &&
          typeof item.provenance.resource === "string" &&
          item.provenance.resource.startsWith(`pull/${pullNumber}/`),
      )
      .map((item) => item.id);
    const commitIds = evidenceId(state, "commit");
    const support = [...new Set([...issueIds, ...timelineIds, ...prIds])];

    if (state.mergedPrs.has(pullNumber)) {
      claims.push({
        text: `PR #${pullNumber} is a candidate resolution for Issue #${issueNumber}.`,
        polarity: "resolved",
        critical: true,
        evidenceIds: support,
        role: "supports",
      });
      claims.push({
        text: `PR #${pullNumber} is merged.`,
        polarity: "resolved",
        critical: true,
        evidenceIds: mergeIds.length > 0 ? mergeIds : prIds,
        role: "supports",
      });
      const files = state.filesByPr.get(pullNumber) ?? [];
      for (const filename of files) {
        const ids = state.run.evidence
          .filter((item) => item.kind === "file" && item.summary.includes(filename))
          .map((item) => item.id);
        claims.push({
          text: `PR #${pullNumber} modified ${filename}.`,
          polarity: "resolved",
          critical: false,
          evidenceIds: ids.length > 0 ? ids : fileIds,
          role: "supports",
        });
      }
      if (commitIds.length > 0) {
        claims.push({
          text: `Merged PR #${pullNumber} has commit evidence.`,
          polarity: "resolved",
          critical: false,
          evidenceIds: commitIds,
          role: "supports",
        });
      }
    } else {
      claims.push({
        text: `PR #${pullNumber} is a related candidate for Issue #${issueNumber} but is not merged.`,
        polarity: "unresolved",
        critical: true,
        evidenceIds: support.length > 0 ? support : [...prIds, ...issueIds],
        role: "contradicts",
      });
      questions.push(
        `Issue #${issueNumber} appears closed without a merged PR #${pullNumber}; how was it actually resolved?`,
      );
    }
  }

  if (state.candidatePrs.size === 0) {
    claims.push({
      text: `No linked pull request was observed for Issue #${issueNumber}; issue closed is not resolution evidence.`,
      polarity: "unknown",
      critical: true,
      evidenceIds: [...issueIds, ...timelineIds, ...commentIds].filter(Boolean),
      role: "contextual",
    });
    questions.push("No merge, commit, or pull-request evidence explains a resolution.");
  }

  const polarity: ClaimPolarity =
    state.mergedPrs.size > 0 ? "resolved" : state.candidatePrs.size > 0 ? "partial" : "unknown";

  return {
    claims,
    unresolvedQuestions: questions,
    polarity,
    conclusion:
      polarity === "resolved"
        ? `Candidate resolution via merged PR ${[...state.mergedPrs].map((n) => `#${n}`).join(", ")}. Not verified.`
        : polarity === "partial"
          ? "Related PR found but not merged. Not resolved."
          : "Insufficient resolution evidence.",
  };
}

export function nextInvestigationAction(state: InvestigationState): DriverAction {
  const target = targetArgs(state);
  const issueKey = resourceKey("issue", String(target.issueNumber));
  const timelineKey = resourceKey("timeline", String(target.issueNumber));
  const commentsKey = resourceKey("comments", String(target.issueNumber));

  if (!state.investigatedResources.has(issueKey)) {
    return {
      type: "tool_call",
      name: "github_get_issue",
      arguments: target,
      reason: "Task target is an issue; observe the issue before inferring resolution.",
    };
  }

  if (
    (state.retrievalStrategy === "comments" || state.retrievalStrategy === "broaden") &&
    !state.investigatedResources.has(commentsKey)
  ) {
    return {
      type: "tool_call",
      name: "github_get_issue_comments",
      arguments: target,
      reason: "Retrieval strategy changed; inspect comments instead of replaying the previous path.",
    };
  }

  if (!state.investigatedResources.has(timelineKey)) {
    return {
      type: "tool_call",
      name: "github_get_issue_timeline",
      arguments: target,
      reason:
        "Issue observation does not by itself explain resolution; inspect the timeline for connected pull requests.",
    };
  }

  const unfetchedPr = [...state.candidatePrs].find(
    (n) => !state.investigatedResources.has(resourceKey("pull", String(n))),
  );
  if (unfetchedPr !== undefined) {
    return {
      type: "tool_call",
      name: "github_get_pull_request",
      arguments: { owner: target.owner, repo: target.repo, pullNumber: unfetchedPr },
      reason: `Observations referenced PR #${unfetchedPr}; inspect that PR instead of treating issue closed as resolved.`,
    };
  }

  const needComments = !state.investigatedResources.has(commentsKey) && state.mergedPrs.size === 0;
  if (needComments) {
    return {
      type: "tool_call",
      name: "github_get_issue_comments",
      arguments: target,
      reason:
        state.candidatePrs.size === 0
          ? "No pull request in the timeline; check comments for other resolution pointers."
          : "Related PR is not merged; check comments before concluding.",
    };
  }

  const unfetchedAfterComments = [...state.candidatePrs].find(
    (n) => !state.investigatedResources.has(resourceKey("pull", String(n))),
  );
  if (unfetchedAfterComments !== undefined) {
    return {
      type: "tool_call",
      name: "github_get_pull_request",
      arguments: { owner: target.owner, repo: target.repo, pullNumber: unfetchedAfterComments },
      reason: `Comments referenced PR #${unfetchedAfterComments}; inspect it next.`,
    };
  }

  const unfetchedFiles = [...state.mergedPrs].find(
    (n) => !state.investigatedResources.has(resourceKey("files", String(n))),
  );
  if (unfetchedFiles !== undefined) {
    return {
      type: "tool_call",
      name: "github_get_pull_request_files",
      arguments: { owner: target.owner, repo: target.repo, pullNumber: unfetchedFiles },
      reason: `PR #${unfetchedFiles} is merged; observe changed files rather than stopping at merge=true.`,
    };
  }

  const unfetchedCommits = [...state.mergedPrs].find(
    (n) => !state.investigatedResources.has(resourceKey("commits", String(n))),
  );
  if (unfetchedCommits !== undefined) {
    return {
      type: "tool_call",
      name: "github_list_commits",
      arguments: { owner: target.owner, repo: target.repo, pullNumber: unfetchedCommits },
      reason: `PR #${unfetchedCommits} is merged; observe commits as additional resolution evidence.`,
    };
  }

  const repoCommitsKey = resourceKey("commits", "repo");
  const pendingPull = [...state.candidatePrs].some(
    (n) => !state.investigatedResources.has(resourceKey("pull", String(n))),
  );
  if (
    state.mergedPrs.size === 0 &&
    state.unmergedPrs.size === 0 &&
    !pendingPull &&
    state.investigatedResources.has(timelineKey) &&
    !state.investigatedResources.has(repoCommitsKey)
  ) {
    return {
      type: "tool_call",
      name: "github_list_commits",
      arguments: { owner: target.owner, repo: target.repo },
      reason: "No merged pull request was observed; inspect referenced repository commits from the timeline.",
    };
  }

  if (!state.claimsRecorded) {
    return {
      type: "tool_call",
      name: "record_claim",
      arguments: buildDriverClaims(state),
      reason: "Observations collected; record structured claims linked to evidence IDs.",
    };
  }

  return {
    type: "final",
    message: state.conclusion || "Investigation complete (claims only; not verified).",
    reason: "Claims recorded; end the investigation without declaring VERIFIED_COMPLETE.",
  };
}

export class SnapshotInvestigationDriver implements Model {
  /** Marker so callers can refuse to present this as a product agent. */
  readonly isTestDriver = true as const;
  readonly notice = TEST_DRIVER_NOTICE;

  constructor(private readonly state: InvestigationState) {}

  async decide(
    _task: Task,
    _history: HistoryMessage[],
    _toolResults: ToolResult[],
    _context?: ModelContext,
  ): Promise<ModelResponse> {
    const action = nextInvestigationAction(this.state);
    this.state.pendingReason = action.reason;
    if (action.type === "final") {
      return { type: "final", message: action.message };
    }
    return {
      type: "tool_call",
      call: {
        id: randomUUID(),
        name: action.name,
        arguments: action.arguments,
      },
    };
  }
}
