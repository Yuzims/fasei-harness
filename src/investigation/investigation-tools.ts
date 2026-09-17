import { createHash } from "node:crypto";
import {
  bindClaimEvidence,
  createClaim,
  createEvidence,
  createRelation,
  type ClaimEvidenceRole,
  type ClaimPolarity,
  type EvidenceKind,
} from "../domain/index.js";
import type { GitHubDataProvider } from "../github/provider.js";
import type { Tool } from "../tools/tool.js";
import { createInvestigationGithubTools } from "../tools/github.js";
import { TraceCollector } from "../trace/trace-collector.js";
import { UNTRUSTED_NOTICE } from "./policy.js";
import { GitHubProviderError } from "../github/errors.js";
import {
  InvestigationState,
  pullResource,
  resourceKey,
  resourceKeyForTool,
} from "./state.js";

const POLARITIES: ClaimPolarity[] = ["resolved", "unresolved", "partial", "unknown"];
const ROLES: ClaimEvidenceRole[] = ["supports", "contradicts", "contextual"];

export interface InvestigationSession {
  state: InvestigationState;
  trace: TraceCollector;
  runId: string;
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
  const found = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && n !== issueNumber) {
      found.add(n);
    }
  }
  return [...found];
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
  }
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
  }
  for (const comment of comments) {
    if (!isRecord(comment)) {
      continue;
    }
    for (const pullNumber of mentionPullNumbers(String(comment.body ?? ""), issueNumber)) {
      session.state.addCandidatePr(pullNumber);
    }
  }
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
  }
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    const pullNumber = Number(event.pullRequestNumber);
    if (Number.isInteger(pullNumber) && pullNumber > 0) {
      session.state.addCandidatePr(pullNumber);
    }
  }
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
  const issue = session.state.evidenceByKind("issue")[0];
  if (prId && issue) {
    session.state.addRelation(
      createRelation({
        fromEvidenceId: prId,
        toEvidenceId: issue.id,
        type: merged ? "fixes" : "references",
      }),
    );
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
  return id ? [id] : [];
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
    }
  }
  session.state.filesByPr.set(pullNumber, names);
  return ids;
}

function ingestCommits(session: InvestigationSession, output: unknown, pullNumber: number | undefined): string[] {
  const commits = asArray(output);
  const ids: string[] = [];
  if (pullNumber && pullNumber > 0) {
    session.state.investigatedResources.add(resourceKey("commits", String(pullNumber)));
  }
  for (const commit of commits) {
    if (!isRecord(commit)) {
      continue;
    }
    const sha = String(commit.sha ?? "");
    const id = addEvidenceOnce(session, resourceKey("commit", sha), {
      kind: "commit",
      summary: `Commit ${sha.slice(0, 12)}: ${String(commit.message ?? "").split("\n")[0] ?? ""}`,
      payload: commit,
      provenance: {
        source: "github",
        operation: "listCommits",
        resource: sha ? `commit/${sha}` : "commits",
        url: String(commit.url ?? ""),
        repository: String(commit.repository ?? ""),
        retrievedAt: String(commit.retrievedAt ?? new Date().toISOString()),
        trust: "external_untrusted",
      },
    });
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

export function ingestObservation(
  session: InvestigationSession,
  toolName: string,
  args: Record<string, unknown>,
  output: unknown,
): string[] {
  switch (toolName) {
    case "github_get_issue":
      return ingestIssue(session, output);
    case "github_get_issue_comments":
      return ingestComments(session, output);
    case "github_get_issue_timeline":
      return ingestTimeline(session, output);
    case "github_get_pull_request":
      return ingestPullRequest(session, output);
    case "github_get_pull_request_reviews":
      return ingestReviews(session, output, Number(args.pullNumber));
    case "github_get_pull_request_files":
      return ingestFiles(session, output, Number(args.pullNumber));
    case "github_list_commits":
      return ingestCommits(
        session,
        output,
        typeof args.pullNumber === "number" ? args.pullNumber : undefined,
      );
    default:
      return [];
  }
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
        return {
          observation: cachedPayload(session, key),
          evidenceIds: existing ? [existing.id] : [],
          cached: true,
          trust: "external_untrusted",
          notice: UNTRUSTED_NOTICE,
          investigation: session.state.hint(),
        };
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
        return {
          observation: output,
          evidenceIds,
          trust: "external_untrusted",
          notice: UNTRUSTED_NOTICE,
          investigation: session.state.hint(),
        };
      } catch (error) {
        const providerError = error instanceof GitHubProviderError ? error : undefined;
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

function parsePolarity(value: unknown): ClaimPolarity {
  if (typeof value === "string" && (POLARITIES as string[]).includes(value)) {
    return value as ClaimPolarity;
  }
  return "unknown";
}

function parseRole(value: unknown): ClaimEvidenceRole {
  if (typeof value === "string" && (ROLES as string[]).includes(value)) {
    return value as ClaimEvidenceRole;
  }
  return "supports";
}

function asClaimList(args: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(args.claims)) {
    return args.claims.filter(isRecord);
  }
  if (typeof args.text === "string") {
    return [args];
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
      const known = new Set(session.state.run.evidence.map((item) => item.id));
      const created: string[] = [];
      for (const item of asClaimList(args)) {
        const evidenceIds = Array.isArray(item.evidenceIds)
          ? item.evidenceIds.filter((id): id is string => typeof id === "string")
          : [];
        const missing = evidenceIds.filter((id) => !known.has(id));
        if (missing.length > 0) {
          throw new Error(`record_claim unknown evidence ids: ${missing.join(", ")}`);
        }
        const claim = createClaim({
          text: String(item.text ?? ""),
          polarity: parsePolarity(item.polarity),
          critical: item.critical !== false,
        });
        session.state.addClaim(claim);
        const role = parseRole(item.role);
        for (const evidenceId of evidenceIds) {
          session.state.bind(bindClaimEvidence({ claimId: claim.id, evidenceId, role }));
        }
        session.trace.record(session.runId, session.state.currentStep, "claim_created", {
          claimId: claim.id,
          text: claim.text,
          polarity: claim.polarity,
          evidenceIds,
          role,
        });
        created.push(claim.id);
      }
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
      session.state.claimsRecorded = created.length > 0 || session.state.run.claims.length > 0;
      session.state.recordTool({
        tool: "record_claim",
        arguments: { claimCount: created.length },
        success: true,
        evidenceIds: [],
        reason: session.state.lastDecisionReason,
      });
      return {
        claimIds: created,
        notice: "Claims are hypotheses. They are not VERIFIED_COMPLETE.",
        investigation: session.state.hint(),
      };
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
  return [...github, createRecordClaimTool(session)];
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
    default:
      return undefined;
  }
}
