/**
 * Compact Evidence → LLM history representation for investigation tools.
 *
 * GitHub → Evidence still stores the full provider payload.
 * This module never calls an LLM and never truncates AgentLoop history.
 */

import {
  MAX_REPOSITORY_COMMIT_DISCOVERY,
  REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE,
  unwrapCommitList,
} from "../github/commit-bounds.js";
import { extractMentionedNumbers } from "../github/normalize.js";
import { applyPatchBudget } from "../github/patch-bounds.js";
import { extractSemanticReferences, mentionedIssueNumbers } from "../github/semantic-references.js";
import { UNTRUSTED } from "../github/types.js";
import { UNTRUSTED_NOTICE } from "./policy.js";
import { resourceKeyForTool } from "./state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstLine(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function mentionedPullNumbers(text: string, issueNumber?: number): number[] {
  return extractMentionedNumbers(text).filter((n) => (issueNumber ? n !== issueNumber : true));
}

function resourceIdentity(
  tool: string,
  args: Record<string, unknown>,
  output: unknown,
): string | undefined {
  if (isRecord(output)) {
    const repository = typeof output.repository === "string" ? output.repository : undefined;
    const number = typeof output.number === "number" ? output.number : undefined;
    if (repository && typeof number === "number" && number > 0) {
      return `${repository}#${number}`;
    }
  }
  return resourceKeyForTool(tool, args);
}

function compactIssue(output: unknown): Record<string, unknown> {
  if (!isRecord(output)) {
    return { observed: false };
  }
  const number = Number(output.number);
  const title = firstLine(output.title);
  const body = typeof output.body === "string" ? output.body : "";
  return {
    number,
    state: output.state === "closed" ? "closed" : "open",
    title,
    mentionedPullNumbers: mentionedPullNumbers(`${title}\n${body}`, number),
  };
}

function compactComments(output: unknown, issueNumber?: number): Record<string, unknown> {
  const comments = asArray(output);
  const mentioned = new Set<number>();
  for (const comment of comments) {
    if (!isRecord(comment)) {
      continue;
    }
    for (const pullNumber of mentionedPullNumbers(String(comment.body ?? ""), issueNumber)) {
      mentioned.add(pullNumber);
    }
  }
  return {
    count: comments.length,
    mentionedPullNumbers: [...mentioned].sort((a, b) => a - b),
  };
}

function compactTimeline(output: unknown, issueNumber?: number): Record<string, unknown> {
  const events = asArray(output);
  const pullNumbers = new Set<number>();
  const compactEvents: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    const item: Record<string, unknown> = { event: String(event.event ?? "unknown") };
    const pullNumber = Number(event.pullRequestNumber);
    if (Number.isInteger(pullNumber) && pullNumber > 0) {
      item.pullRequestNumber = pullNumber;
      pullNumbers.add(pullNumber);
    }
    for (const mentioned of mentionedPullNumbers(String(event.body ?? ""), issueNumber)) {
      pullNumbers.add(mentioned);
    }
    compactEvents.push(item);
  }
  return {
    count: events.length,
    pullRequestNumbers: [...pullNumbers].sort((a, b) => a - b),
    events: compactEvents,
  };
}

function compactPullRequest(output: unknown): Record<string, unknown> {
  if (!isRecord(output)) {
    return { observed: false };
  }
  const number = Number(output.number);
  const title = firstLine(output.title);
  const body = typeof output.body === "string" ? output.body : "";
  const text = `${typeof output.title === "string" ? output.title : title}\n${body}`;
  const exclude = Number.isInteger(number) && number > 0 ? number : undefined;
  return {
    number,
    state: String(output.state ?? "unknown"),
    merged: output.merged === true,
    title,
    mentionedIssueNumbers: mentionedIssueNumbers(text, exclude),
    semanticReferences: extractSemanticReferences(text).filter(
      (ref) => ref.issueNumber === undefined || ref.issueNumber !== exclude,
    ),
  };
}

function compactReviews(output: unknown): Record<string, unknown> {
  const reviews = asArray(output);
  return {
    count: reviews.length,
    states: reviews.filter(isRecord).map((item) => String(item.state ?? "")),
  };
}

export type CompactPatchExposure = "metadata_only" | "patch_enabled";

export function exposeCompactPatch(exposure?: CompactPatchExposure): boolean {
  return exposure !== "metadata_only";
}

function compactFiles(output: unknown, exposePatch: boolean): Record<string, unknown> {
  const files = asArray(output);
  const compactFiles = files.filter(isRecord).map((item) => {
    const compact: {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
      patchTruncated?: boolean;
    } = {
      filename: String(item.filename ?? ""),
      status: String(item.status ?? "modified"),
      additions: Number(item.additions ?? 0),
      deletions: Number(item.deletions ?? 0),
    };
    if (exposePatch && typeof item.patch === "string" && item.patch.length > 0) {
      compact.patch = item.patch;
      compact.patchTruncated = item.patchTruncated === true;
    }
    return compact;
  });
  return {
    count: files.length,
    files: exposePatch ? applyPatchBudget(compactFiles) : compactFiles,
  };
}

function compactCommits(output: unknown, repositoryWide: boolean): Record<string, unknown> {
  const { commits: raw, truncated } = unwrapCommitList(output);
  if (!repositoryWide) {
    return {
      count: raw.length,
      commits: raw.filter(isRecord).map((item) => ({
        sha: String(item.sha ?? ""),
        message: firstLine(item.message),
      })),
    };
  }
  const commits = raw.slice(0, MAX_REPOSITORY_COMMIT_DISCOVERY);
  const windowTruncated = truncated === true || raw.length > MAX_REPOSITORY_COMMIT_DISCOVERY;
  return {
    count: commits.length,
    truncated: windowTruncated,
    discoveryBound: MAX_REPOSITORY_COMMIT_DISCOVERY,
    ...(windowTruncated ? { notice: REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE } : {}),
    commits: commits.filter(isRecord).map((item) => ({
      sha: String(item.sha ?? ""),
      message: firstLine(item.message),
    })),
  };
}

function compactResult(
  tool: string,
  args: Record<string, unknown>,
  output: unknown,
  exposePatch: boolean,
): Record<string, unknown> {
  const issueNumber = typeof args.issueNumber === "number" ? args.issueNumber : undefined;
  switch (tool) {
    case "github_get_issue":
      return compactIssue(output);
    case "github_get_issue_comments":
      return compactComments(output, issueNumber);
    case "github_get_issue_timeline":
      return compactTimeline(output, issueNumber);
    case "github_get_pull_request":
      return compactPullRequest(output);
    case "github_get_pull_request_reviews":
      return compactReviews(output);
    case "github_get_pull_request_files":
      return compactFiles(output, exposePatch);
    case "github_list_commits":
      return compactCommits(
        output,
        !(typeof args.pullNumber === "number" && args.pullNumber > 0),
      );
    case "github_get_commit":
      return isRecord(output)
        ? { sha: String(output.sha ?? ""), message: firstLine(output.message) }
        : { observed: false };
    default:
      return { observed: true };
  }
}

export interface CompactInvestigationToolInput {
  tool: string;
  args: Record<string, unknown>;
  output: unknown;
  evidenceIds: string[];
  cached?: boolean;
  /**
   * Evaluation/test boundary. Production omits this and keeps patch_enabled.
   * Evidence.payload is unchanged; this only affects LLM compact output.
   */
  patchExposure?: CompactPatchExposure;
}

/**
 * Structured tool observation for LLM history.
 * Issue/comment bodies stay on Evidence.payload.
 * File patches are included only after the bounded patch policy.
 */
export function compactInvestigationToolOutput(
  input: CompactInvestigationToolInput,
): Record<string, unknown> {
  const resource = resourceIdentity(input.tool, input.args, input.output);
  return {
    tool: input.tool,
    status: "success",
    evidenceIds: [...input.evidenceIds],
    ...(resource ? { resource } : {}),
    trust: UNTRUSTED,
    notice: UNTRUSTED_NOTICE,
    ...(input.cached ? { cached: true } : {}),
    result: compactResult(input.tool, input.args, input.output, exposeCompactPatch(input.patchExposure)),
  };
}

export function compactRecordClaimOutput(claimIds: string[]): Record<string, unknown> {
  return {
    tool: "record_claim",
    status: "success",
    evidenceIds: [],
    claimIds: [...claimIds],
    notice: "Claims are hypotheses. They are not VERIFIED_COMPLETE.",
    result: { recorded: claimIds.length },
  };
}

export function compactRecordResolutionAnalysisOutput(analysisIds: string[]): Record<string, unknown> {
  return {
    tool: "record_resolution_analysis",
    status: "success",
    evidenceIds: [],
    resolutionAnalysisIds: [...analysisIds],
    notice: "Resolution Analysis is an investigation hypothesis. It is not VERIFIED_COMPLETE.",
    result: { recorded: analysisIds.length },
  };
}
