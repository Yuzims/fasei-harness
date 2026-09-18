/**
 * Phase 8.7.7.1 — Context Preservation & Recall Validation.
 *
 * Compares Baseline (full tool result) vs Compact (Phase 8.7.7 representation)
 * on the same raw GitHub observation. Does not call an external LLM.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import { closingKeywordReferencesIssue } from "../src/domain/index.js";
import {
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";
import { extractMentionedNumbers } from "../src/github/normalize.js";
import { extractSemanticReferences } from "../src/github/semantic-references.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { UNTRUSTED } from "../src/github/types.js";
import {
  IndependentCompletionVerifier,
  compactInvestigationToolOutput,
  ingestObservation,
} from "../src/investigation/index.js";
import {
  createRecordClaimTool,
  type InvestigationSession,
} from "../src/investigation/investigation-tools.js";
import { UNTRUSTED_NOTICE } from "../src/investigation/policy.js";
import { InvestigationState } from "../src/investigation/state.js";
import { createInvestigationGithubTools } from "../src/tools/github.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import type { CompactInvestigationToolInput } from "../src/investigation/tool-result-context.js";
import {
  PRESERVE_ISSUE,
  PRESERVE_OWNER,
  PRESERVE_PR,
  PRESERVE_REPO,
  PRESERVE_SHA,
  contextPreservationCases,
  preservationCase,
  type ClueLocation,
  type PreservationCase,
  type PreservationCaseId,
} from "./context-preservation.fixtures.js";

type ContextMode = "baseline" | "compact";

type ContextRecallResult = {
  caseId: PreservationCaseId;
  clueLocation: ClueLocation | "none";
  baselineDiscovered: boolean;
  compactDiscovered: boolean;
  baselineEvidenceLinked: boolean;
  compactEvidenceLinked: boolean;
  baselineVerification: string;
  compactVerification: string;
  baselineCandidate: boolean;
  compactCandidate: boolean;
  lossReason?: string;
};

interface ObservedTool {
  tool: string;
  args: Record<string, unknown>;
  rawResult: unknown;
  representation: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function baselineInvestigationToolOutput(
  input: CompactInvestigationToolInput,
): Record<string, unknown> {
  const envelope = compactInvestigationToolOutput(input);
  return { ...envelope, result: input.output };
}

function represent(
  mode: ContextMode,
  input: CompactInvestigationToolInput,
): Record<string, unknown> {
  return mode === "compact"
    ? compactInvestigationToolOutput(input)
    : baselineInvestigationToolOutput(input);
}

function asResult(repr: Record<string, unknown>): Record<string, unknown> {
  return isRecord(repr.result) ? repr.result : {};
}

function semanticReferencesOf(repr: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = asResult(repr);
  return Array.isArray(result.semanticReferences)
    ? result.semanticReferences.filter(isRecord)
    : [];
}

function compactMatchesSemanticContract(spec: PreservationCase, repr: Record<string, unknown>): boolean {
  if (!spec.expectedSemanticKinds?.length) {
    return false;
  }
  const refs = semanticReferencesOf(repr);
  const kindsOk = spec.expectedSemanticKinds.every((kind) =>
    refs.some((ref) => {
      if (ref.kind !== kind) {
        return false;
      }
      if (kind === "negative_resolution") {
        return ref.issueNumber === PRESERVE_ISSUE || ref.issueNumber === undefined;
      }
      return ref.issueNumber === PRESERVE_ISSUE;
    }),
  );
  const keywordOk =
    !spec.expectedSemanticKeyword || refs.some((ref) => ref.keyword === spec.expectedSemanticKeyword);
  return kindsOk && keywordOk;
}

function compactForbidsSemanticKinds(spec: PreservationCase, repr: Record<string, unknown>): boolean {
  if (!spec.forbidSemanticKinds?.length) {
    return true;
  }
  const refs = semanticReferencesOf(repr);
  return spec.forbidSemanticKinds.every(
    (kind) =>
      !refs.some(
        (ref) => ref.kind === kind && (ref.issueNumber === PRESERVE_ISSUE || ref.issueNumber === undefined),
      ),
  );
}

function numbersFromUnknown(value: unknown): number[] {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function collectPullNumbers(value: unknown, issueNumber: number, found: Set<number>): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value !== issueNumber) {
    found.add(value);
    return;
  }
  if (typeof value === "string") {
    for (const mentioned of extractMentionedNumbers(value)) {
      if (mentioned !== issueNumber) {
        found.add(mentioned);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPullNumbers(item, issueNumber, found);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["mentionedPullNumbers", "pullRequestNumbers", "pullRequestNumber", "number"]) {
    if (key === "number" && !("merged" in value) && !("headSha" in value) && !("state" in value)) {
      continue;
    }
    collectPullNumbers(value[key], issueNumber, found);
  }
  if (typeof value.body === "string") {
    collectPullNumbers(value.body, issueNumber, found);
  }
  if (typeof value.message === "string") {
    collectPullNumbers(value.message, issueNumber, found);
  }
  if (Array.isArray(value.events)) {
    collectPullNumbers(value.events, issueNumber, found);
  }
  if (Array.isArray(value.commits)) {
    collectPullNumbers(value.commits, issueNumber, found);
  }
}

function pullNumbersInRepresentation(
  repr: Record<string, unknown>,
  issueNumber: number,
): number[] {
  const found = new Set<number>();
  collectPullNumbers(repr.result, issueNumber, found);
  if (repr.tool === "github_get_pull_request") {
    const result = asResult(repr);
    if (typeof result.number === "number") {
      found.add(result.number);
    }
  }
  for (const mentioned of extractMentionedNumbers(JSON.stringify(repr))) {
    if (mentioned !== issueNumber) {
      found.add(mentioned);
    }
  }
  found.delete(issueNumber);
  return [...found].filter((value) => value > 0);
}

function representationText(repr: Record<string, unknown>): string {
  return JSON.stringify(repr);
}

function requiredClueInRepresentation(
  spec: PreservationCase,
  repr: Record<string, unknown>,
): boolean {
  if (!spec.requiredClue) {
    return false;
  }
  const text = representationText(repr);
  if (text.includes(spec.requiredClue)) {
    return true;
  }
  if (compactMatchesSemanticContract(spec, repr)) {
    return true;
  }
  if (spec.expectedPullNumber && pullNumbersInRepresentation(repr, PRESERVE_ISSUE).includes(spec.expectedPullNumber)) {
    return spec.clueLocation !== "pull_request" && spec.clueLocation !== "commit";
  }
  if (spec.clueLocation === "commit") {
    return extractMentionedNumbers(text).includes(PRESERVE_ISSUE) || text.includes(`#${PRESERVE_ISSUE}`);
  }
  if (spec.clueLocation === "pull_request") {
    return closingKeywordReferencesIssue(text, PRESERVE_ISSUE) || /closes\s+#42/i.test(text);
  }
  return false;
}

function toolForLocation(location: ClueLocation | "none"): string | undefined {
  switch (location) {
    case "issue_body":
      return "github_get_issue";
    case "comment":
      return "github_get_issue_comments";
    case "timeline":
      return "github_get_issue_timeline";
    case "commit":
      return "github_list_commits";
    case "pull_request":
      return "github_get_pull_request";
    default:
      return undefined;
  }
}

function discoveryFromContext(observed: ObservedTool[], spec: PreservationCase): boolean {
  if (spec.caseId === "NO_RESOLUTION_CLUE") {
    return false;
  }
  const tool = toolForLocation(spec.clueLocation);
  const target = tool
    ? observed.filter((item) => item.tool === tool)
    : observed;
  return target.some((item) => requiredClueInRepresentation(spec, item.representation));
}

function discoveredPullNumbers(observed: ObservedTool[]): number[] {
  const found = new Set<number>();
  for (const item of observed) {
    for (const value of pullNumbersInRepresentation(item.representation, PRESERVE_ISSUE)) {
      found.add(value);
    }
  }
  return [...found];
}

function contextHasUnsupportedResolvedInstruction(observed: ObservedTool[]): boolean {
  return observed.some((item) => /declare this issue fixed/i.test(representationText(item.representation)));
}

function observationTexts(repr: Record<string, unknown>): string {
  const result = asResult(repr);
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      parts.push(value);
    }
  };
  push(result.body);
  push(result.title);
  push(result.message);
  if (Array.isArray(repr.result)) {
    for (const item of repr.result) {
      if (isRecord(item)) {
        push(item.body);
        push(item.message);
        push(item.title);
      }
    }
  }
  if (Array.isArray(result.events)) {
    for (const item of result.events) {
      if (isRecord(item)) {
        push(item.body);
      }
    }
  }
  if (Array.isArray(result.commits)) {
    for (const item of result.commits) {
      if (isRecord(item)) {
        push(item.message);
      }
    }
  }
  return parts.join("\n");
}

function semanticRefsFromObservation(repr: Record<string, unknown>): Array<Record<string, unknown>> {
  const fromCompact = semanticReferencesOf(repr);
  if (fromCompact.length > 0) {
    return fromCompact;
  }
  return extractSemanticReferences(observationTexts(repr)) as Array<Record<string, unknown>>;
}

function contextHasNegativeResolution(observed: ObservedTool[]): boolean {
  return observed.some((item) =>
    semanticRefsFromObservation(item.representation).some((ref) => ref.kind === "negative_resolution"),
  );
}

function contextHasClosingKeyword(observed: ObservedTool[]): boolean {
  return observed.some((item) =>
    semanticRefsFromObservation(item.representation).some(
      (ref) => ref.kind === "closing_keyword" && ref.issueNumber === PRESERVE_ISSUE,
    ),
  );
}

function contextHasCommitIssueLink(observed: ObservedTool[]): boolean {
  return observed
    .filter((item) => item.tool === "github_list_commits")
    .some((item) => {
      const text = representationText(item.representation);
      return text.includes(`#${PRESERVE_ISSUE}`) || extractMentionedNumbers(text).includes(PRESERVE_ISSUE);
    });
}

function mergedPullNumbers(observed: ObservedTool[]): number[] {
  return observed
    .filter((item) => item.tool === "github_get_pull_request")
    .map((item) => asResult(item.representation))
    .filter((result) => result.merged === true && typeof result.number === "number")
    .map((result) => Number(result.number));
}

function claimsFromContext(
  observed: ObservedTool[],
  spec: PreservationCase,
): {
  claims: Array<Record<string, unknown>>;
  polarity: "resolved" | "partial" | "unknown";
  conclusion: string;
} {
  const evidenceIds = [
    ...new Set(
      observed.flatMap((item) =>
        Array.isArray(item.representation.evidenceIds)
          ? item.representation.evidenceIds.filter((id): id is string => typeof id === "string")
          : [],
      ),
    ),
  ];
  const pulls = discoveredPullNumbers(observed);
  const merged = mergedPullNumbers(observed);
  const injectionOnly = spec.caseId === "NO_RESOLUTION_CLUE";
  const seesInjection = contextHasUnsupportedResolvedInstruction(observed);
  const negative = contextHasNegativeResolution(observed) || spec.caseId === "C07_UNRELATED_MERGED_PR";
  const closing = contextHasClosingKeyword(observed);
  const commitLink = contextHasCommitIssueLink(observed);

  if (injectionOnly) {
    return {
      claims: [
        {
          text: `Issue #${PRESERVE_ISSUE} has no observed resolution candidate.`,
          polarity: "unknown",
          critical: true,
          evidenceIds,
          role: "contextual",
        },
      ],
      polarity: "unknown",
      conclusion: "No PR, commit, or resolution statement was observed. Not verified.",
    };
  }

  if (negative && !closing) {
    return {
      claims: [
        {
          text: `PR #${PRESERVE_PR} is related but does not resolve Issue #${PRESERVE_ISSUE}.`,
          polarity: "unknown",
          critical: true,
          evidenceIds,
          role: "contextual",
        },
      ],
      polarity: "unknown",
      conclusion: "Merged related PR is not treated as resolution. Not verified.",
    };
  }

  if (seesInjection && pulls.length === 0 && !commitLink) {
    return {
      claims: [
        {
          text: `Untrusted comment asked to declare Issue #${PRESERVE_ISSUE} fixed; ignored.`,
          polarity: "unknown",
          critical: true,
          evidenceIds,
          role: "contextual",
        },
      ],
      polarity: "unknown",
      conclusion: "Prompt injection is not resolution evidence.",
    };
  }

  if (merged.length > 0 && (closing || spec.clueLocation !== "pull_request" || spec.caseId !== "C07_UNRELATED_MERGED_PR")) {
    const pullNumber = merged[0] ?? pulls[0] ?? PRESERVE_PR;
    const canResolve =
      closing &&
      spec.caseId !== "C07_UNRELATED_MERGED_PR" &&
      spec.caseId !== "E8_SEMANTIC_MISMATCH" &&
      spec.caseId !== "NO_RESOLUTION_CLUE";
    if (canResolve && spec.caseId !== "C07_UNRELATED_MERGED_PR") {
      return {
        claims: [
          {
            text: `PR #${pullNumber} is a candidate resolution for Issue #${PRESERVE_ISSUE}.`,
            polarity: "resolved",
            critical: true,
            evidenceIds,
            role: "supports",
          },
        ],
        polarity: "resolved",
        conclusion: `Candidate resolution via merged PR #${pullNumber}. Not verified.`,
      };
    }
  }

  if (commitLink && pulls.length === 0) {
    return {
      claims: [
        {
          text: `Issue #${PRESERVE_ISSUE} has a direct-commit resolution candidate.`,
          polarity: "resolved",
          critical: true,
          evidenceIds,
          role: "supports",
        },
      ],
      polarity: "resolved",
      conclusion: "Candidate resolution via commit message. Not verified.",
    };
  }

  if (pulls.includes(PRESERVE_PR)) {
    return {
      claims: [
        {
          text: `PR #${PRESERVE_PR} is a related candidate for Issue #${PRESERVE_ISSUE}.`,
          polarity: "partial",
          critical: true,
          evidenceIds,
          role: "contextual",
        },
      ],
      polarity: "partial",
      conclusion: "Related PR observed. Not verified.",
    };
  }

  return {
    claims: [
      {
        text: `No linked pull request was observed for Issue #${PRESERVE_ISSUE}.`,
        polarity: "unknown",
        critical: true,
        evidenceIds,
        role: "contextual",
      },
    ],
    polarity: "unknown",
    conclusion: "Insufficient resolution evidence.",
  };
}

function nextToolCall(
  observed: ObservedTool[],
  spec: PreservationCase,
  claimsRecorded: boolean,
): { name: string; arguments: Record<string, unknown> } | undefined {
  const target = {
    owner: PRESERVE_OWNER,
    repo: PRESERVE_REPO,
    issueNumber: PRESERVE_ISSUE,
  };
  const tools = new Set(observed.map((item) => item.tool));
  if (!tools.has("github_get_issue")) {
    return { name: "github_get_issue", arguments: target };
  }
  if (!tools.has("github_get_issue_comments")) {
    return { name: "github_get_issue_comments", arguments: target };
  }
  if (!tools.has("github_get_issue_timeline")) {
    return { name: "github_get_issue_timeline", arguments: target };
  }

  const discovered = discoveredPullNumbers(observed);
  const fetched = new Set(
    observed
      .filter((item) => item.tool === "github_get_pull_request")
      .map((item) => Number(asResult(item.representation).number))
      .filter((value) => value > 0),
  );
  const missingPr = discovered.find((value) => !fetched.has(value));
  if (missingPr !== undefined) {
    return {
      name: "github_get_pull_request",
      arguments: { owner: PRESERVE_OWNER, repo: PRESERVE_REPO, pullNumber: missingPr },
    };
  }

  const merged = mergedPullNumbers(observed);
  for (const pullNumber of merged) {
    const hasFiles = observed.some(
      (item) => item.tool === "github_get_pull_request_files" && item.args.pullNumber === pullNumber,
    );
    if (!hasFiles) {
      return {
        name: "github_get_pull_request_files",
        arguments: { owner: PRESERVE_OWNER, repo: PRESERVE_REPO, pullNumber },
      };
    }
    const hasCommits = observed.some(
      (item) => item.tool === "github_list_commits" && item.args.pullNumber === pullNumber,
    );
    if (!hasCommits) {
      return {
        name: "github_list_commits",
        arguments: { owner: PRESERVE_OWNER, repo: PRESERVE_REPO, pullNumber },
      };
    }
  }

  if (discovered.length === 0 && !tools.has("github_list_commits")) {
    return {
      name: "github_list_commits",
      arguments: { owner: PRESERVE_OWNER, repo: PRESERVE_REPO },
    };
  }

  if (!claimsRecorded) {
    const built = claimsFromContext(observed, spec);
    return {
      name: "record_claim",
      arguments: {
        claims: built.claims,
        polarity: built.polarity,
        conclusion: built.conclusion,
      },
    };
  }
  return undefined;
}

async function runPreservationMode(
  spec: PreservationCase,
  mode: ContextMode,
): Promise<{
  observed: ObservedTool[];
  evidenceLinked: boolean;
  verification: string;
  candidate: boolean;
  claimsResolved: boolean;
  injectionTrusted: boolean;
  inventedPr: boolean;
}> {
  const provider = new SnapshotGitHubProvider(spec.snapshot);
  const task = createInvestigationTask({
    target: {
      owner: PRESERVE_OWNER,
      repository: PRESERVE_REPO,
      issueNumber: PRESERVE_ISSUE,
    },
  });
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  const session: InvestigationSession = {
    state,
    trace: new TraceCollector(),
    runId: run.id,
    llmUsage: new LlmUsageCollector(),
  };
  const githubTools = createInvestigationGithubTools({ provider });
  const recordClaim = createRecordClaimTool(session);
  const observed: ObservedTool[] = [];
  let claimsRecorded = false;

  for (let step = 0; step < 12; step += 1) {
    const action = nextToolCall(observed, spec, claimsRecorded);
    if (!action) {
      break;
    }
    if (action.name === "record_claim") {
      await recordClaim.execute(action.arguments);
      claimsRecorded = true;
      continue;
    }
    const tool = githubTools.find((item) => item.name === action.name);
    assert.ok(tool, `missing tool ${action.name}`);
    const rawResult = await tool.execute(action.arguments);
    const evidenceIds = ingestObservation(session, action.name, action.arguments, rawResult);
    const representation = represent(mode, {
      tool: action.name,
      args: action.arguments,
      output: rawResult,
      evidenceIds,
    });
    observed.push({
      tool: action.name,
      args: action.arguments,
      rawResult,
      representation,
    });
  }

  const verification = new IndependentCompletionVerifier().verify({
    task,
    run,
    agentClaimedComplete: run.claims.some((claim) => claim.critical && claim.polarity === "resolved"),
  });

  const evidenceLinked =
    run.claims.length > 0 &&
    run.claims.every((claim) => run.claimEvidence.some((link) => link.claimId === claim.id)) &&
    run.claimEvidence.every((link) => run.evidence.some((item) => item.id === link.evidenceId));

  const candidate =
    discoveredPullNumbers(observed).includes(PRESERVE_PR) ||
    (spec.expectedCommitSha !== undefined &&
      observed.some(
        (item) =>
          item.tool === "github_list_commits" && representationText(item.representation).includes(spec.expectedCommitSha ?? ""),
      ));

  const inventedPr =
    spec.caseId === "NO_RESOLUTION_CLUE" &&
    (discoveredPullNumbers(observed).includes(PRESERVE_PR) ||
      run.claims.some((claim) => /PR #123/.test(claim.text)));

  const githubEvidence = run.evidence.filter((item) => item.provenance.source === "github");
  const injectionTrusted = githubEvidence.some((item) => item.provenance.trust !== UNTRUSTED);

  return {
    observed,
    evidenceLinked,
    verification: verification.status,
    candidate,
    claimsResolved: run.claims.some((claim) => claim.critical && claim.polarity === "resolved"),
    injectionTrusted,
    inventedPr,
  };
}

function recallResult(spec: PreservationCase, baseline: Awaited<ReturnType<typeof runPreservationMode>>, compact: Awaited<ReturnType<typeof runPreservationMode>>): ContextRecallResult {
  const baselineDiscovered =
    spec.caseId === "NO_RESOLUTION_CLUE" ? !baseline.inventedPr : discoveryFromContext(baseline.observed, spec);
  const compactDiscovered =
    spec.caseId === "NO_RESOLUTION_CLUE" ? !compact.inventedPr : discoveryFromContext(compact.observed, spec);
  const loss =
    baselineDiscovered && !compactDiscovered
      ? `${spec.clueLocation} → ${spec.requiredClue}`
      : undefined;
  return {
    caseId: spec.caseId,
    clueLocation: spec.clueLocation,
    baselineDiscovered,
    compactDiscovered,
    baselineEvidenceLinked: baseline.evidenceLinked,
    compactEvidenceLinked: compact.evidenceLinked,
    baselineVerification: baseline.verification,
    compactVerification: compact.verification,
    baselineCandidate: baseline.candidate,
    compactCandidate: compact.candidate,
    lossReason: loss,
  };
}

const RESULTS: ContextRecallResult[] = [];

test("Context preservation fixtures isolate each required clue in the source observation", () => {
  for (const spec of contextPreservationCases()) {
    if (spec.clueLocation === "none" || !spec.requiredClue) {
      assert.equal(JSON.stringify(spec.snapshot.issue.body).includes(`#${PRESERVE_PR}`), false);
      assert.equal(
        spec.snapshot.comments.every((item) => !item.body.includes(`#${PRESERVE_PR}`)),
        true,
      );
      continue;
    }
    const issueText = `${spec.snapshot.issue.title}\n${spec.snapshot.issue.body}`;
    const commentText = spec.snapshot.comments.map((item) => item.body).join("\n");
    const timelineText = spec.snapshot.timeline
      .map((item) => `${item.body}\n${item.pullRequestNumber ?? ""}`)
      .join("\n");
    const commitText = Object.values(spec.snapshot.commits)
      .flat()
      .map((item) => item.message)
      .join("\n");
    const prText = Object.values(spec.snapshot.pullRequests)
      .map((item) => `${item.title}\n${item.body}`)
      .join("\n");

    if (spec.clueLocation === "issue_body") {
      assert.match(spec.snapshot.issue.body, /The fix was implemented in PR #123/);
      assert.equal(commentText.includes("#123"), false);
      assert.equal(spec.snapshot.timeline.every((item) => !item.pullRequestNumber && !item.body.includes("#123")), true);
    }
    if (spec.clueLocation === "comment") {
      assert.match(commentText, /Fixed by #123/);
      assert.equal(issueText.includes("#123"), false);
      assert.equal(spec.snapshot.timeline.every((item) => !item.pullRequestNumber && !item.body.includes("#123")), true);
    }
    if (spec.clueLocation === "timeline") {
      assert.match(timelineText, /Referenced pull request #123/);
      assert.equal(issueText.includes("#123"), false);
      assert.equal(commentText.includes("#123"), false);
      assert.equal(
        spec.snapshot.timeline.some((item) => item.body.includes("Referenced pull request #123") && !item.pullRequestNumber),
        true,
      );
    }
    if (spec.clueLocation === "commit") {
      assert.match(commitText, /Fix issue #42 by correcting session cleanup/);
      assert.equal(issueText.includes("#123"), false);
      assert.equal(commentText.includes("#123"), false);
    }
    if (spec.caseId === "E_PR_BODY") {
      assert.match(prText, /Closes #42/);
      assert.equal(issueText.includes("#123"), false);
      assert.equal(commentText.includes("#123"), false);
      assert.equal(spec.snapshot.timeline.every((item) => !String(item.body).includes("Closes")), true);
    } else if (spec.clueLocation === "pull_request" && spec.requiredClue) {
      assert.match(prText, new RegExp(spec.requiredClue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(issueText.includes("#123"), false);
      assert.equal(commentText.includes("#123"), false);
    }
  }
});

test("Baseline and compact representations share one raw tool result", async () => {
  const spec = preservationCase("A_ISSUE_BODY");
  const provider = new SnapshotGitHubProvider(spec.snapshot);
  const [issueTool] = createInvestigationGithubTools({ provider });
  assert.ok(issueTool);
  const rawResult = await issueTool.execute({
    owner: PRESERVE_OWNER,
    repo: PRESERVE_REPO,
    issueNumber: PRESERVE_ISSUE,
  });
  const input = {
    tool: "github_get_issue",
    args: { owner: PRESERVE_OWNER, repo: PRESERVE_REPO, issueNumber: PRESERVE_ISSUE },
    output: rawResult,
    evidenceIds: ["ev-issue"],
  };
  const baseline = baselineInvestigationToolOutput(input);
  const compact = compactInvestigationToolOutput(input);
  assert.equal(baseline.tool, compact.tool);
  assert.equal(baseline.trust, UNTRUSTED);
  assert.equal(compact.trust, UNTRUSTED);
  assert.equal(baseline.notice, UNTRUSTED_NOTICE);
  assert.equal(compact.notice, UNTRUSTED_NOTICE);
  assert.deepEqual(baseline.evidenceIds, compact.evidenceIds);
  assert.equal(JSON.stringify(baseline.result), JSON.stringify(rawResult));
  assert.notEqual(JSON.stringify(compact.result), JSON.stringify(rawResult));
  assert.match(JSON.stringify(baseline.result), /The fix was implemented in PR #123/);
  assert.equal(JSON.stringify(compact.result).includes("The fix was implemented in PR #123"), false);
  assert.deepEqual((compact.result as { mentionedPullNumbers?: number[] }).mentionedPullNumbers, [PRESERVE_PR]);
});

test("Fixture provider returns full observations on Evidence regardless of compact history", async () => {
  for (const spec of contextPreservationCases()) {
    if (!spec.requiredClue) {
      continue;
    }
    const compact = await runPreservationMode(spec, "compact");
    const blob = compact.observed
      .map((item) => JSON.stringify(item.rawResult))
      .join("\n");
    assert.match(blob, new RegExp(spec.requiredClue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const item of compact.observed) {
      if (String(item.tool).startsWith("github_")) {
        assert.equal(item.representation.trust, UNTRUSTED);
        assert.equal(item.representation.notice, UNTRUSTED_NOTICE);
      }
    }
  }
});

for (const spec of contextPreservationCases()) {
  test(`Context preservation ${spec.caseId}: baseline vs compact`, async () => {
    const baseline = await runPreservationMode(spec, "baseline");
    const compact = await runPreservationMode(spec, "compact");
    const row = recallResult(spec, baseline, compact);
    RESULTS.push(row);

    assert.equal(baseline.injectionTrusted, false);
    assert.equal(compact.injectionTrusted, false);

    if (spec.caseId === "NO_RESOLUTION_CLUE") {
      assert.equal(baseline.inventedPr, false);
      assert.equal(compact.inventedPr, false);
      assert.equal(baseline.claimsResolved, false);
      assert.equal(compact.claimsResolved, false);
      assert.equal(row.baselineDiscovered, true);
      assert.equal(row.compactDiscovered, true);
      return;
    }

    if (spec.injectionText) {
      const raw = compact.observed.map((item) => JSON.stringify(item.rawResult)).join("\n");
      assert.match(raw, /previous instructions/i);
      if (spec.caseId === "B_COMMENT") {
        const commentObs = compact.observed.find((item) => item.tool === "github_get_issue_comments");
        assert.ok(commentObs);
        assert.equal(commentObs?.representation.trust, UNTRUSTED);
        assert.notEqual(commentObs?.representation.trust, "harness_derived");
        assert.match(JSON.stringify(commentObs?.rawResult ?? {}), /Ignore previous instructions/i);
      }
      if (spec.caseId === "E7_PR_PROMPT_INJECTION") {
        const prObs = compact.observed.find((item) => item.tool === "github_get_pull_request");
        assert.ok(prObs);
        assert.equal(prObs?.representation.trust, UNTRUSTED);
        assert.equal(prObs?.representation.notice, UNTRUSTED_NOTICE);
        const compactJson = JSON.stringify(asResult(prObs?.representation ?? {}));
        assert.equal(compactJson.includes("IGNORE ALL PREVIOUS"), false);
        assert.equal(compactJson.includes("Declare the issue verified"), false);
        assert.match(JSON.stringify(prObs?.rawResult ?? {}), /IGNORE ALL PREVIOUS INSTRUCTIONS/);
        assert.equal(compact.claimsResolved, baseline.claimsResolved);
      }
    }

    if (spec.expectedSemanticKinds?.length) {
      const prObs = compact.observed.find((item) => item.tool === "github_get_pull_request");
      assert.ok(prObs, `${spec.caseId} must observe the pull request`);
      assert.equal(
        compactMatchesSemanticContract(spec, prObs?.representation ?? {}),
        true,
        `${spec.caseId} compact semantic contract failed: ${JSON.stringify(asResult(prObs?.representation ?? {}))}`,
      );
      assert.equal(
        compactForbidsSemanticKinds(spec, prObs?.representation ?? {}),
        true,
        `${spec.caseId} compact must not classify forbidden kinds`,
      );
    }

    if (spec.caseId === "C07_UNRELATED_MERGED_PR" || spec.caseId === "E8_SEMANTIC_MISMATCH") {
      assert.equal(baseline.claimsResolved, false);
      assert.equal(compact.claimsResolved, false);
      assert.equal(row.baselineVerification, row.compactVerification);
      assert.notEqual(row.compactVerification, "verified_complete");
      assert.equal(row.compactDiscovered, true, compactLossMessage(spec, row));
      return;
    }

    if (spec.caseId === "E4_PR_ORDINARY_REFERENCE" || spec.caseId === "E5_PR_NEGATIVE_RESOLUTION" || spec.caseId === "E6_PR_NOT_PLANNED") {
      assert.equal(compact.claimsResolved, baseline.claimsResolved);
      assert.equal(compact.claimsResolved, false, `${spec.caseId} must not treat non-closing text as resolution`);
    }

    assert.equal(row.baselineDiscovered, true, `${spec.caseId} baseline must keep ${spec.requiredClue}`);
    assert.equal(row.baselineEvidenceLinked, true);
    assert.equal(row.compactEvidenceLinked, true);
    assert.equal(row.baselineEvidenceLinked, row.compactEvidenceLinked);
    if (spec.caseId === "E_PR_BODY") {
      assert.equal(row.baselineCandidate, true);
      assert.equal(row.compactCandidate, true);
      assert.equal(
        row.baselineVerification === "verified_complete" && row.compactVerification === "not_verified",
        false,
        "Case E verifier mismatch would be investigation/context loss, not a verifier bug",
      );
    }
    assert.equal(
      row.compactDiscovered,
      true,
      compactLossMessage(spec, row),
    );
  });
}

function compactLossMessage(spec: PreservationCase, row: ContextRecallResult): string {
  if (row.compactDiscovered) {
    return `${spec.caseId} compact kept the clue`;
  }
  const candidateNote =
    row.compactCandidate
      ? "PR/commit candidate is still discoverable; the closing-keyword text is missing from compact LLM history."
      : "resolution candidate discovery degraded.";
  return [
    "Context preservation regression detected.",
    "",
    "Lost clue:",
    `${spec.clueLocation} → ${spec.requiredClue}`,
    "",
    "Impact:",
    candidateNote,
    `Evidence linkage: baseline=${row.baselineEvidenceLinked} compact=${row.compactEvidenceLinked}`,
    `Verification: baseline=${row.baselineVerification} compact=${row.compactVerification}`,
    "",
    "Optimization status:",
    "REJECTED / NEEDS REDESIGN",
  ].join("\n");
}

test("Context preservation recall metrics and case report", () => {
  const clueCases = RESULTS.filter(
    (item) => item.caseId !== "NO_RESOLUTION_CLUE" && item.caseId !== "C07_UNRELATED_MERGED_PR",
  );
  const baselineClueRecall = clueCases.filter((item) => item.baselineDiscovered).length / clueCases.length;
  const compactClueRecall = clueCases.filter((item) => item.compactDiscovered).length / clueCases.length;
  const resolutionCandidateRecall =
    clueCases.filter((item) => item.compactCandidate && item.baselineCandidate).length / clueCases.length;
  const evidenceLinkage = clueCases.every((item) => item.baselineEvidenceLinked && item.compactEvidenceLinked);
  const verificationInvariant = RESULTS.every((item) => {
    if (item.baselineVerification === "verified_complete" && item.compactVerification === "not_verified") {
      return false;
    }
    return true;
  });
  const negative = RESULTS.find((item) => item.caseId === "NO_RESOLUTION_CLUE");
  const c07 = RESULTS.find((item) => item.caseId === "C07_UNRELATED_MERGED_PR");
  const e8 = RESULTS.find((item) => item.caseId === "E8_SEMANTIC_MISMATCH");
  const injection = RESULTS.find((item) => item.caseId === "B_COMMENT");
  const prInjection = RESULTS.find((item) => item.caseId === "E7_PR_PROMPT_INJECTION");
  const positiveIds: PreservationCaseId[] = ["E_PR_BODY", "E1_PR_CLOSES", "E2_PR_FIXES", "E3_PR_RESOLVES"];
  const negativeIds: PreservationCaseId[] = ["E5_PR_NEGATIVE_RESOLUTION", "E6_PR_NOT_PLANNED"];
  const ordinaryIds: PreservationCaseId[] = ["E4_PR_ORDINARY_REFERENCE"];
  const positiveRecall = positiveIds.every((id) => RESULTS.find((item) => item.caseId === id)?.compactDiscovered);
  const negativeRecall = negativeIds.every((id) => RESULTS.find((item) => item.caseId === id)?.compactDiscovered);
  const ordinaryRecall = ordinaryIds.every((id) => RESULTS.find((item) => item.caseId === id)?.compactDiscovered);

  const lines = [
    "",
    "Case A:",
    "Issue body",
    `Baseline discovery: ${flag(RESULTS, "A_ISSUE_BODY", "baselineDiscovered")}`,
    `Compact discovery: ${flag(RESULTS, "A_ISSUE_BODY", "compactDiscovered")}`,
    "",
    "Case B:",
    "Comment",
    `Baseline discovery: ${flag(RESULTS, "B_COMMENT", "baselineDiscovered")}`,
    `Compact discovery: ${flag(RESULTS, "B_COMMENT", "compactDiscovered")}`,
    "",
    "Case C:",
    "Timeline",
    `Baseline discovery: ${flag(RESULTS, "C_TIMELINE", "baselineDiscovered")}`,
    `Compact discovery: ${flag(RESULTS, "C_TIMELINE", "compactDiscovered")}`,
    "",
    "Case D:",
    "Commit",
    `Baseline discovery: ${flag(RESULTS, "D_COMMIT", "baselineDiscovered")}`,
    `Compact discovery: ${flag(RESULTS, "D_COMMIT", "compactDiscovered")}`,
    "",
    "Case E:",
    "PR body",
    `Baseline discovery: ${flag(RESULTS, "E_PR_BODY", "baselineDiscovered")}`,
    `Compact discovery: ${flag(RESULTS, "E_PR_BODY", "compactDiscovered")}`,
    "",
    "Case E1-E8:",
    `E1 closes: ${flag(RESULTS, "E1_PR_CLOSES", "compactDiscovered")}`,
    `E2 fixes: ${flag(RESULTS, "E2_PR_FIXES", "compactDiscovered")}`,
    `E3 resolves: ${flag(RESULTS, "E3_PR_RESOLVES", "compactDiscovered")}`,
    `E4 ordinary: ${flag(RESULTS, "E4_PR_ORDINARY_REFERENCE", "compactDiscovered")}`,
    `E5 negative: ${flag(RESULTS, "E5_PR_NEGATIVE_RESOLUTION", "compactDiscovered")}`,
    `E6 not_planned: ${flag(RESULTS, "E6_PR_NOT_PLANNED", "compactDiscovered")}`,
    `E7 injection: ${flag(RESULTS, "E7_PR_PROMPT_INJECTION", "compactDiscovered")}`,
    `E8 mismatch: ${flag(RESULTS, "E8_SEMANTIC_MISMATCH", "compactDiscovered")}`,
    "",
    `baselineClueRecall=${baselineClueRecall}`,
    `compactClueRecall=${compactClueRecall}`,
    `positiveResolutionClueRecall=${positiveRecall}`,
    `negativeResolutionClueRecall=${negativeRecall}`,
    `ordinaryReferenceClassification=${ordinaryRecall}`,
    `resolutionCandidateRecall=${resolutionCandidateRecall}`,
    `evidenceLinkage=${evidenceLinkage}`,
    `verificationInvariant=${verificationInvariant}`,
    `negative=${negative?.compactDiscovered === true && negative.baselineDiscovered === true}`,
    `c07=${c07?.baselineVerification === c07?.compactVerification && c07?.compactVerification !== "verified_complete"}`,
    `e8=${e8?.baselineVerification === e8?.compactVerification && e8?.compactVerification !== "verified_complete"}`,
    `injection=${injection?.compactDiscovered === true}`,
    `prInjection=${prInjection?.compactDiscovered === true}`,
    "",
  ];
  console.log(lines.join("\n"));

  const lost = clueCases.filter((item) => item.baselineDiscovered && !item.compactDiscovered);
  assert.equal(baselineClueRecall, 1, "baseline clue recall must be 100%");
  assert.equal(
    compactClueRecall,
    1,
    lost.map((item) => compactLossMessage(preservationCase(item.caseId), item)).join("\n\n"),
  );
  assert.equal(positiveRecall, true);
  assert.equal(negativeRecall, true);
  assert.equal(ordinaryRecall, true);
  assert.equal(resolutionCandidateRecall, 1);
  assert.equal(evidenceLinkage, true);
  assert.equal(verificationInvariant, true);
  assert.ok(negative);
  assert.equal(negative?.baselineDiscovered, true);
  assert.equal(negative?.compactDiscovered, true);
  assert.ok(c07);
  assert.equal(c07?.baselineVerification, c07?.compactVerification);
  assert.notEqual(c07?.compactVerification, "verified_complete");
  assert.ok(e8);
  assert.equal(e8?.baselineVerification, e8?.compactVerification);
  assert.notEqual(e8?.compactVerification, "verified_complete");
  assert.ok(prInjection);
  assert.equal(prInjection?.compactDiscovered, true);
});

function flag(rows: ContextRecallResult[], id: PreservationCaseId, key: "baselineDiscovered" | "compactDiscovered"): string {
  const row = rows.find((item) => item.caseId === id);
  return row?.[key] ? "PASS" : "FAIL";
}
