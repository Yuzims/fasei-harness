/**
 * Phase 8.9.x — Retrieval Evaluation.
 *
 * Controlled comparison of discovery-order baseline vs evidence-driven ranking.
 * Reuses the Investigation Agent, Fake Model policy, snapshot provider, and
 * existing verifier / budget. Does not reimplement ranking, verifier, recovery,
 * or GitHub providers.
 *
 * Baseline is a controlled baseline, not a historical production system.
 */
import { profileRequestMessages } from "../agent/llm-context-profile.js";
import { DEFAULT_LLM_RUNTIME_BUDGET } from "../agent/llm-runtime.js";
import type { HistoryMessage, Model, ModelResponse } from "../agent/model.js";
import { isFalseCompletion, isVerifierFalsePositive } from "../benchmark/metrics.js";
import {
  convertCaseToScenario,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadCaseSnapshot,
  loadDataset,
  realDatasetManifestPath,
} from "../benchmark/dataset/index.js";
import type { ExpectedOutcome } from "../benchmark/types.js";
import type { ToolResult } from "../core/types.js";
import { createInvestigationTask, type VerificationStatus } from "../domain/index.js";
import {
  SnapshotGitHubProvider,
  UNTRUSTED,
  type CommitSnapshot,
  type GitHubDataProvider,
  type InvestigationSnapshot,
  type PullRequestSnapshot,
  type TimelineEventSnapshot,
} from "../github/index.js";
import {
  MAX_INVESTIGATED_CANDIDATES,
  investigate,
  rankCandidates,
  withCandidateStatus,
  type InvestigateOptions,
  type InvestigationAgentReport,
  type InvestigationSession,
  type RetrievalCandidate,
  type RetrievalCandidateSelection,
} from "../investigation/index.js";
import { verifierInvariantHolds } from "./resolution-analysis-evaluation.js";
import {
  asCandidateView,
  diagnoseRetrieval,
  discoveryFound,
  investigationSucceeded,
  meanDefined,
  precisionAtK,
  recallAtK,
  type ExpectedResolutionCandidate,
  type RetrievalCandidateView,
  type RetrievalDiagnosis,
} from "./retrieval-metrics.js";
import { REAL_CASE_IDS, createStrategyEvaluationModel } from "./strategy-evaluation.js";

export const RETRIEVAL_EVALUATION_VERSION = "8.9.x";

export const RETRIEVAL_EVALUATION_BASELINE_NOTE =
  "baseline is a controlled baseline: the same Investigation Agent, Fake Model policy, snapshot, discovery source, and candidate investigation budget (MAX_INVESTIGATED_CANDIDATES) run with discovery-order bounded selection instead of Evidence-driven Candidate Ranking / Top-K. It is not a historical replay of a previous harness version or a live production retrieval system. controlled baseline ≠ historical production system.";

export type RetrievalEvaluationStrategy = "baseline" | "evidence_driven";

export interface RetrievalGroundTruth {
  caseId: string;
  expectedResolution: "none" | "candidate";
  validCandidates: ExpectedResolutionCandidate[];
  expectedOutcome?: ExpectedOutcome;
}

export interface RetrievalEvaluationCase {
  caseId: string;
  strategy: RetrievalEvaluationStrategy;
  resolutionExpected: boolean;
  groundTruth: ExpectedResolutionCandidate[];
  discovered: RetrievalCandidateView[];
  topK: RetrievalCandidateView[];
  investigated: RetrievalCandidateView[];
  discoveryFound: boolean | null;
  topKFound: boolean | null;
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  precisionAt1: number | null;
  precisionAt3: number | null;
  precisionAt5: number | null;
  diagnosis: RetrievalDiagnosis;
  candidateCount: number;
  investigatedCandidateCount: number;
  rejectedCandidateCount: number;
  promotedCandidateCount: number;
  toolCalls: number;
  llmCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  inputTokensEstimated: boolean;
  providerTokensUnavailable: boolean;
  runtimeMs: number;
  verificationResult: VerificationStatus;
  evidenceCoverage: number;
  investigationSuccess: boolean | null;
  falseCompletion: boolean;
  verifierFalsePositive: boolean;
  verificationInvariant: boolean;
}

export interface RetrievalEvaluationAggregate {
  discoveryRate: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  averageCandidates: number;
  averageInvestigatedCandidates: number;
  averageToolCalls: number;
  averageLlmCalls: number;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  averageRuntimeMs: number;
  evidenceCoverage: number;
  investigationSuccessRate: number;
  falseCompletionRate: number;
  verificationInvariantRate: number;
  resolutionExpectedCases: number;
  noResolutionCases: number;
}

export interface RetrievalEvaluationReport {
  datasetId: string;
  strategy: RetrievalEvaluationStrategy;
  version: string;
  baselineNote: string;
  cases: RetrievalEvaluationCase[];
  aggregate: RetrievalEvaluationAggregate;
}

export interface RetrievalEvaluationRun {
  caseId: string;
  strategy: RetrievalEvaluationStrategy;
  metrics: RetrievalEvaluationCase;
  report: InvestigationAgentReport;
}

export interface RetrievalEvaluationComparison {
  caseId: string;
  baselineNote: string;
  baseline: RetrievalEvaluationCase;
  evidenceDriven: RetrievalEvaluationCase;
}

export interface RetrievalEvaluationCaseConfig {
  caseId: string;
  snapshot: InvestigationSnapshot;
  groundTruth: RetrievalGroundTruth;
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
}

type StrategyCollector = Parameters<typeof createStrategyEvaluationModel>[1];

const RETRIEVED_AT = "2026-09-19T00:00:00.000Z";

/**
 * Controlled baseline: same discovery, same budget, discovery order instead of ranking.
 */
export function applyDiscoveryOrderSelection(
  candidates: readonly RetrievalCandidate[],
  limit = MAX_INVESTIGATED_CANDIDATES,
): RetrievalCandidate[] {
  const cap = Math.max(0, limit);
  const promotedCount = candidates.filter((item) => item.status === "promoted").length;
  const remainingCapacity = Math.max(0, cap - promotedCount);
  const investigatingIds = new Set(
    candidates
      .filter((item) => item.status !== "promoted")
      .slice(0, remainingCapacity)
      .map((item) => item.id),
  );
  return candidates.map((candidate) => {
    if (candidate.status === "promoted") {
      return withCandidateStatus(candidate, "promoted");
    }
    if (investigatingIds.has(candidate.id)) {
      return withCandidateStatus(candidate, "investigating");
    }
    return withCandidateStatus(candidate, "rejected");
  });
}

export function selectorForStrategy(
  strategy: RetrievalEvaluationStrategy,
): RetrievalCandidateSelection | undefined {
  if (strategy === "baseline") {
    return applyDiscoveryOrderSelection;
  }
  return undefined;
}

export const REAL_V1_RETRIEVAL_GROUND_TRUTH: Record<string, RetrievalGroundTruth> = {
  C01: {
    caseId: "C01",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "284149" }],
  },
  C02: {
    caseId: "C02",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "14527" }],
  },
  C03: {
    caseId: "C03",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "14022" }],
  },
  C04: {
    caseId: "C04",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "14504" }],
  },
  C05: {
    caseId: "C05",
    expectedResolution: "none",
    validCandidates: [],
  },
  C06: {
    caseId: "C06",
    expectedResolution: "none",
    validCandidates: [],
  },
  C07: {
    caseId: "C07",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "7256" }],
  },
  C08: {
    caseId: "C08",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "commit", sourceId: "e70118a2a11aa239472336f6a961784f04c63c9d" }],
  },
  C09: {
    caseId: "C09",
    expectedResolution: "candidate",
    validCandidates: [{ sourceType: "pull_request", sourceId: "279" }],
  },
  C10: {
    caseId: "C10",
    expectedResolution: "none",
    validCandidates: [],
  },
};

function orderedCandidates(
  candidates: readonly RetrievalCandidate[],
  strategy: RetrievalEvaluationStrategy,
): RetrievalCandidate[] {
  if (strategy === "evidence_driven") {
    return rankCandidates(candidates);
  }
  return [...candidates];
}

function verificationStatusOf(report: InvestigationAgentReport): VerificationStatus {
  const status = report.verification?.status ?? report.run.status;
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return "not_verified";
}

function agentClaimedComplete(report: InvestigationAgentReport): boolean {
  return report.claims.some((claim) => claim.critical && claim.polarity === "resolved");
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}

function profileDecide(history: HistoryMessage[], toolResults: ToolResult[]) {
  const messages = history.map((item) => ({ role: item.role, content: item.content }));
  const profile = profileRequestMessages(messages, history.length, []);
  const toolResultChars = toolResults.reduce((sum, item) => {
    try {
      return sum + JSON.stringify(item).length;
    } catch {
      return sum;
    }
  }, 0);
  return {
    estimatedInputTokens: profile.estimatedInputTokens,
    messageChars: profile.serializedMessagesChars,
    toolResultChars: profile.totalToolResultChars > 0 ? profile.totalToolResultChars : toolResultChars,
  };
}

function wrapEvaluationModel(session: InvestigationSession, collector: StrategyCollector): Model {
  const inner = createStrategyEvaluationModel(session, collector);
  return {
    async decide(task, history, toolResults, context): Promise<ModelResponse> {
      const before = collector.llmCalls;
      const response = await inner.decide(task, history, toolResults, context);
      if (collector.llmCalls === before) {
        collector.llmCalls += 1;
        const profile = profileDecide(history, toolResults);
        collector.estimatedInputTokens = addNullable(collector.estimatedInputTokens, profile.estimatedInputTokens);
        collector.estimatedMessageChars += profile.messageChars;
        collector.estimatedToolResultChars += profile.toolResultChars;
      }
      return response;
    },
  };
}

export function evaluateRetrievalCandidates(input: {
  caseId: string;
  strategy: RetrievalEvaluationStrategy;
  candidates: readonly RetrievalCandidate[];
  groundTruth: RetrievalGroundTruth;
  report?: InvestigationAgentReport;
  llmCalls?: number;
  estimatedInputTokens?: number | null;
  runtimeMs?: number;
}): RetrievalEvaluationCase {
  const resolutionExpected = input.groundTruth.expectedResolution === "candidate";
  const valid = resolutionExpected ? input.groundTruth.validCandidates : [];
  const discovered = input.candidates.map(asCandidateView);
  const ordered = orderedCandidates(input.candidates, input.strategy).map(asCandidateView);
  const topK = ordered.slice(0, MAX_INVESTIGATED_CANDIDATES);
  const investigated = discovered.filter(
    (item) => item.status === "investigating" || item.status === "promoted",
  );
  const foundDiscovery = resolutionExpected ? discoveryFound(discovered, valid) : null;
  const foundTopK = resolutionExpected ? recallAtK(topK, valid, MAX_INVESTIGATED_CANDIDATES) === 1 : null;
  const investigationSuccess = resolutionExpected ? investigationSucceeded(discovered, valid) : null;
  const verification = input.report ? verificationStatusOf(input.report) : "not_verified";
  const claimed = input.report ? agentClaimedComplete(input.report) : false;
  const expectedStatus = input.groundTruth.expectedOutcome?.verificationStatus;
  return {
    caseId: input.caseId,
    strategy: input.strategy,
    resolutionExpected,
    groundTruth: [...valid],
    discovered,
    topK,
    investigated,
    discoveryFound: foundDiscovery,
    topKFound: foundTopK,
    recallAt1: recallAtK(topK, valid, 1),
    recallAt3: recallAtK(topK, valid, 3),
    recallAt5: recallAtK(topK, valid, 5),
    precisionAt1: precisionAtK(topK, valid, 1),
    precisionAt3: precisionAtK(topK, valid, 3),
    precisionAt5: precisionAtK(topK, valid, 5),
    diagnosis: diagnoseRetrieval({
      resolutionExpected,
      discoveryFound: foundDiscovery === true,
      topKFound: foundTopK === true,
      investigationSuccess: investigationSuccess === true,
      verificationInsufficient: verification === "insufficient_evidence",
    }),
    candidateCount: discovered.length,
    investigatedCandidateCount: investigated.length,
    rejectedCandidateCount: discovered.filter((item) => item.status === "rejected").length,
    promotedCandidateCount: discovered.filter((item) => item.status === "promoted").length,
    toolCalls: input.report?.investigationSteps.length ?? 0,
    llmCalls: input.llmCalls ?? 0,
    inputTokens: input.estimatedInputTokens ?? null,
    outputTokens: input.report?.llmUsage.totalOutputTokens ?? null,
    inputTokensEstimated: true,
    providerTokensUnavailable:
      (input.report?.llmUsage.totalInputTokens ?? null) === null &&
      (input.report?.llmUsage.totalOutputTokens ?? null) === null,
    runtimeMs: input.runtimeMs ?? 0,
    verificationResult: verification,
    evidenceCoverage: input.report?.verification?.evidenceCoverage ?? 0,
    investigationSuccess,
    falseCompletion: isFalseCompletion(claimed, verification),
    verifierFalsePositive: expectedStatus ? isVerifierFalsePositive(expectedStatus, verification) : false,
    verificationInvariant: input.report ? verifierInvariantHolds(input.report) : true,
  };
}

export function aggregateRetrievalCases(
  cases: readonly RetrievalEvaluationCase[],
): RetrievalEvaluationAggregate {
  const expected = cases.filter((item) => item.resolutionExpected);
  const inputTokens = cases.map((item) => item.inputTokens);
  const outputTokens = cases.map((item) => item.outputTokens);
  return {
    discoveryRate: meanDefined(expected.map((item) => (item.discoveryFound ? 1 : 0))),
    recallAt1: meanDefined(expected.map((item) => item.recallAt1)),
    recallAt3: meanDefined(expected.map((item) => item.recallAt3)),
    recallAt5: meanDefined(expected.map((item) => item.recallAt5)),
    precisionAt1: meanDefined(expected.map((item) => item.precisionAt1)),
    precisionAt3: meanDefined(expected.map((item) => item.precisionAt3)),
    precisionAt5: meanDefined(expected.map((item) => item.precisionAt5)),
    averageCandidates: meanDefined(cases.map((item) => item.candidateCount)),
    averageInvestigatedCandidates: meanDefined(cases.map((item) => item.investigatedCandidateCount)),
    averageToolCalls: meanDefined(cases.map((item) => item.toolCalls)),
    averageLlmCalls: meanDefined(cases.map((item) => item.llmCalls)),
    averageInputTokens: inputTokens.every((item) => item === null) ? null : meanDefined(inputTokens),
    averageOutputTokens: outputTokens.every((item) => item === null) ? null : meanDefined(outputTokens),
    averageRuntimeMs: meanDefined(cases.map((item) => item.runtimeMs)),
    evidenceCoverage: meanDefined(cases.map((item) => item.evidenceCoverage)),
    investigationSuccessRate: meanDefined(expected.map((item) => (item.investigationSuccess ? 1 : 0))),
    falseCompletionRate: meanDefined(cases.map((item) => (item.falseCompletion ? 1 : 0))),
    verificationInvariantRate: meanDefined(cases.map((item) => (item.verificationInvariant ? 1 : 0))),
    resolutionExpectedCases: expected.length,
    noResolutionCases: cases.length - expected.length,
  };
}

export function buildRetrievalEvaluationReport(input: {
  datasetId: string;
  strategy: RetrievalEvaluationStrategy;
  cases: RetrievalEvaluationCase[];
}): RetrievalEvaluationReport {
  return {
    datasetId: input.datasetId,
    strategy: input.strategy,
    version: RETRIEVAL_EVALUATION_VERSION,
    baselineNote: RETRIEVAL_EVALUATION_BASELINE_NOTE,
    cases: input.cases,
    aggregate: aggregateRetrievalCases(input.cases),
  };
}

export async function runRetrievalEvaluation(input: {
  caseId: string;
  strategy: RetrievalEvaluationStrategy;
  provider: GitHubDataProvider;
  groundTruth: RetrievalGroundTruth;
  task?: InvestigateOptions["task"];
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
}): Promise<RetrievalEvaluationRun> {
  const collector: StrategyCollector = {
    llmCalls: 0,
    estimatedInputTokens: null,
    estimatedMessageChars: 0,
    estimatedToolResultChars: 0,
    actions: [],
    missingCandidateMapping: false,
  };
  const started = Date.now();
  const report = await investigate({
    task: input.task ?? { owner: "acme", repository: "box", issueNumber: 42 },
    provider: input.provider,
    maxAttempts: input.maxAttempts ?? 3,
    maxSteps: input.maxSteps ?? 12,
    llmRuntimeBudget: {
      maxLlmCalls: input.maxLlmCalls ?? DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls,
      maxWallClockMs: input.maxWallClockMs ?? DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs,
    },
    candidateSelection: selectorForStrategy(input.strategy),
    modelFactory: (session) => wrapEvaluationModel(session, collector),
  });
  return {
    caseId: input.caseId,
    strategy: input.strategy,
    metrics: evaluateRetrievalCandidates({
      caseId: input.caseId,
      strategy: input.strategy,
      candidates: report.retrievalCandidates,
      groundTruth: input.groundTruth,
      report,
      llmCalls: collector.llmCalls,
      estimatedInputTokens: collector.estimatedInputTokens,
      runtimeMs: Date.now() - started,
    }),
    report,
  };
}

export async function compareRetrievalEvaluation(input: {
  caseId: string;
  providerFactory: () => GitHubDataProvider;
  groundTruth: RetrievalGroundTruth;
  task?: InvestigateOptions["task"];
  maxAttempts?: number;
  maxSteps?: number;
  maxLlmCalls?: number;
  maxWallClockMs?: number;
}): Promise<RetrievalEvaluationComparison> {
  const shared = {
    caseId: input.caseId,
    groundTruth: input.groundTruth,
    task: input.task,
    maxAttempts: input.maxAttempts,
    maxSteps: input.maxSteps,
    maxLlmCalls: input.maxLlmCalls,
    maxWallClockMs: input.maxWallClockMs,
  };
  const baseline = await runRetrievalEvaluation({
    ...shared,
    strategy: "baseline",
    provider: input.providerFactory(),
  });
  const evidenceDriven = await runRetrievalEvaluation({
    ...shared,
    strategy: "evidence_driven",
    provider: input.providerFactory(),
  });
  return {
    caseId: input.caseId,
    baselineNote: RETRIEVAL_EVALUATION_BASELINE_NOTE,
    baseline: baseline.metrics,
    evidenceDriven: evidenceDriven.metrics,
  };
}

function meta(id: string, url: string) {
  return {
    id,
    repository: "acme/box",
    source: "github" as const,
    url,
    retrievedAt: RETRIEVED_AT,
    trust: UNTRUSTED,
  };
}

function pullRecord(number: number, title: string, body: string, merged = true): PullRequestSnapshot {
  const sha = `sha${number}`.padEnd(40, "0");
  return {
    ...meta(`pr:acme/box#${number}`, `https://github.com/acme/box/pull/${number}`),
    number,
    title,
    body,
    state: "closed",
    merged,
    mergeCommitSha: merged ? sha : null,
    headSha: sha,
  };
}

function commitRecord(sha: string, message: string): CommitSnapshot {
  return {
    ...meta(`commit:acme/box@${sha}`, `https://github.com/acme/box/commit/${sha}`),
    sha,
    message,
    author: "maintainer",
  };
}

function timelinePull(number: number): TimelineEventSnapshot {
  return {
    ...meta(`timeline:acme/box:pr-${number}`, `https://github.com/acme/box/pull/${number}`),
    event: "connected",
    createdAt: RETRIEVED_AT,
    actor: "maintainer",
    body: "",
    pullRequestNumber: number,
  };
}

function baseSnapshot(
  issueNumber: number,
  title: string,
  body: string,
  extra?: {
    stateReason?: string | null;
    pulls?: PullRequestSnapshot[];
    repoCommits?: CommitSnapshot[];
    timeline?: TimelineEventSnapshot[];
  },
): InvestigationSnapshot {
  const pulls = extra?.pulls ?? [];
  const repoCommits = extra?.repoCommits ?? [];
  const pullRequests: Record<string, PullRequestSnapshot> = {};
  const reviews: InvestigationSnapshot["reviews"] = {};
  const files: InvestigationSnapshot["files"] = {};
  const commits: InvestigationSnapshot["commits"] = { repo: repoCommits };
  const commitIndex: InvestigationSnapshot["commitIndex"] = {};
  for (const pull of pulls) {
    pullRequests[String(pull.number)] = pull;
    reviews[String(pull.number)] = [];
    files[String(pull.number)] = [
      {
        ...meta(
          `file:acme/box#${pull.number}:src/cart.ts`,
          `https://github.com/acme/box/pull/${pull.number}`,
        ),
        pullNumber: pull.number,
        filename: "src/cart.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ];
    const sha = String(pull.mergeCommitSha ?? `sha${pull.number}`.padEnd(40, "0"));
    const commit = commitRecord(sha, `${pull.title}\n\n${pull.body}`);
    commits[`pr:${pull.number}`] = [commit];
    commitIndex[sha] = commit;
  }
  for (const commit of repoCommits) {
    commitIndex[commit.sha] = commit;
  }
  return {
    snapshotId: `retrieval-${issueNumber}`,
    schemaVersion: 1,
    createdAt: RETRIEVED_AT,
    source: "github",
    owner: "acme",
    repository: "box",
    issueNumber,
    retrievedAt: RETRIEVED_AT,
    trust: UNTRUSTED,
    repositoryData: {
      ...meta("repo:acme/box", "https://github.com/acme/box"),
      owner: "acme",
      name: "box",
      description: "Sample service",
      defaultBranch: "main",
    },
    issue: {
      ...meta(`issue:acme/box#${issueNumber}`, `https://github.com/acme/box/issues/${issueNumber}`),
      number: issueNumber,
      title,
      body,
      state: "closed",
      stateReason: extra?.stateReason ?? "completed",
      closedAt: RETRIEVED_AT,
    },
    comments: [],
    timeline: extra?.timeline ?? [
      {
        ...meta("timeline:acme/box:closed", `https://github.com/acme/box/issues/${issueNumber}`),
        event: "closed",
        createdAt: RETRIEVED_AT,
        actor: "maintainer",
        body: "",
      },
    ],
    pullRequests,
    reviews,
    files,
    commits,
    commitIndex,
  };
}

export function syntheticRetrievalCases(): RetrievalEvaluationCaseConfig[] {
  const strongPr = pullRecord(7, "Fix empty cart save", "Fixes #42");
  const altPr = pullRecord(8, "Also fix empty cart", "Fixes #42");
  const noise = [21, 22, 23].map((number) => pullRecord(number, "Docs only", "changelog", true));
  const rankedOut = [99, 101, 102, 103, 104, 105].map((number) =>
    pullRecord(number, number === 99 ? "True fix" : "Distractor", number === 99 ? "patch" : "Fixes #42"),
  );
  const directSha = "cafebabe0123456789abcdef0123456789abcdef";
  const missingSha = "deadbeef0123456789abcdef0123456789abcdef";
  return [
    {
      caseId: "SRE01",
      snapshot: baseSnapshot(42, "Null pointer when saving empty cart", "Saving an empty cart throws. See #7", {
        pulls: [strongPr],
        timeline: [timelinePull(7)],
      }),
      groundTruth: {
        caseId: "SRE01",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
    {
      caseId: "SRE02",
      snapshot: baseSnapshot(42, "Null pointer when saving empty cart", "Saving an empty cart throws.", {
        repoCommits: [commitRecord(directSha, "Fix empty cart save\n\nFixes #42")],
      }),
      groundTruth: {
        caseId: "SRE02",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "commit", sourceId: directSha }],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
    {
      caseId: "SRE03",
      snapshot: baseSnapshot(42, "Null pointer when saving empty cart", "See #7 and #8", {
        pulls: [strongPr, altPr],
        timeline: [timelinePull(7), timelinePull(8)],
      }),
      groundTruth: {
        caseId: "SRE03",
        expectedResolution: "candidate",
        validCandidates: [
          { sourceType: "pull_request", sourceId: "7" },
          { sourceType: "pull_request", sourceId: "8" },
        ],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
    {
      caseId: "SRE04",
      snapshot: baseSnapshot(
        42,
        "Null pointer when saving empty cart",
        "Saving an empty cart throws. See #7 #21 #22 #23",
        {
          pulls: [strongPr, ...noise],
          timeline: [timelinePull(7), timelinePull(21), timelinePull(22), timelinePull(23)],
        },
      ),
      groundTruth: {
        caseId: "SRE04",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
    {
      caseId: "SRE05",
      snapshot: baseSnapshot(42, "Closed not planned", "Will not fix.", {
        stateReason: "not_planned",
      }),
      groundTruth: {
        caseId: "SRE05",
        expectedResolution: "none",
        validCandidates: [],
        expectedOutcome: { verificationStatus: "not_verified" },
      },
    },
    {
      caseId: "SRE06",
      snapshot: baseSnapshot(42, "Null pointer when saving empty cart", "See #99 #101 #102 #103 #104 #105", {
        pulls: rankedOut,
        timeline: [99, 101, 102, 103, 104, 105].map(timelinePull),
      }),
      groundTruth: {
        caseId: "SRE06",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "pull_request", sourceId: "99" }],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
    {
      caseId: "SRE07",
      snapshot: baseSnapshot(42, "Null pointer when saving empty cart", "Saving an empty cart throws.", {
        repoCommits: [commitRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "unrelated chore")],
      }),
      groundTruth: {
        caseId: "SRE07",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "commit", sourceId: missingSha }],
        expectedOutcome: { verificationStatus: "verified_complete" },
      },
    },
  ];
}

export async function evaluateSyntheticRetrievalCase(caseId: string): Promise<RetrievalEvaluationComparison> {
  const config = syntheticRetrievalCases().find((item) => item.caseId === caseId);
  if (!config) {
    throw new Error(`unknown synthetic retrieval evaluation case: ${caseId}`);
  }
  return compareRetrievalEvaluation({
    caseId: config.caseId,
    providerFactory: () => new SnapshotGitHubProvider(config.snapshot),
    groundTruth: config.groundTruth,
    task: {
      owner: config.snapshot.owner,
      repository: config.snapshot.repository,
      issueNumber: config.snapshot.issueNumber,
    },
    maxAttempts: config.maxAttempts,
    maxSteps: config.maxSteps,
    maxLlmCalls: config.maxLlmCalls,
    maxWallClockMs: config.maxWallClockMs,
  });
}

export async function evaluateAllSyntheticRetrievalCases(): Promise<RetrievalEvaluationComparison[]> {
  const results: RetrievalEvaluationComparison[] = [];
  for (const item of syntheticRetrievalCases()) {
    results.push(await evaluateSyntheticRetrievalCase(item.caseId));
  }
  return results;
}

export async function evaluateRealV1RetrievalCase(caseId: string): Promise<RetrievalEvaluationComparison> {
  const dataset = loadDataset(realDatasetManifestPath());
  const datasetCase = loadCase(dataset, caseId);
  const snapshot = loadCaseSnapshot(dataset, datasetCase);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  if ("expectedOutcome" in scenario && scenario.expectedOutcome !== undefined) {
    throw new Error(`real dataset case ${caseId} leaked expectedOutcome into the agent scenario`);
  }
  const retrievalTruth = REAL_V1_RETRIEVAL_GROUND_TRUTH[caseId];
  if (!retrievalTruth) {
    throw new Error(`missing retrieval ground truth for ${caseId}`);
  }
  const expected = expectedOutcomeForDatasetCase(dataset, caseId);
  return compareRetrievalEvaluation({
    caseId,
    providerFactory: () => new SnapshotGitHubProvider(snapshot),
    groundTruth: { ...retrievalTruth, expectedOutcome: expected },
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
  });
}

export async function evaluateRealV1RetrievalCases(
  caseIds: readonly string[] = REAL_CASE_IDS,
): Promise<RetrievalEvaluationComparison[]> {
  const results: RetrievalEvaluationComparison[] = [];
  for (const caseId of caseIds) {
    results.push(await evaluateRealV1RetrievalCase(caseId));
  }
  return results;
}

export function realV1RetrievalReports(comparisons: readonly RetrievalEvaluationComparison[]): {
  baseline: RetrievalEvaluationReport;
  evidenceDriven: RetrievalEvaluationReport;
} {
  return {
    baseline: buildRetrievalEvaluationReport({
      datasetId: "real-v1",
      strategy: "baseline",
      cases: comparisons.map((item) => item.baseline),
    }),
    evidenceDriven: buildRetrievalEvaluationReport({
      datasetId: "real-v1",
      strategy: "evidence_driven",
      cases: comparisons.map((item) => item.evidenceDriven),
    }),
  };
}

export { REAL_CASE_IDS as RETRIEVAL_EVALUATION_REAL_CASE_IDS };
