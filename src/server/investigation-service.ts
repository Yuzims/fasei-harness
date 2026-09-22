import { existsSync, readFileSync } from "node:fs";
import type {
  InvestigationCatalogDTO,
  InvestigationCatalogItemDTO,
  InvestigationIssueDTO,
  InvestigationMode,
  InvestigationRequest,
  InvestigationSessionDTO,
  LlmUsageAggregateDTO,
} from "../api/dto.js";
import {
  convertCaseToScenario,
  executeScenario,
  FASEI_RECOVERY_SCENARIOS,
  FASEI_REGRESSION_SCENARIOS,
  loadDataset,
  realDatasetLatestResultPath,
  realDatasetManifestPath,
} from "../benchmark/index.js";
import type { BenchmarkScenario, DatasetBenchmarkResult } from "../benchmark/index.js";
import type { InvestigationAttempt } from "../domain/index.js";
import { investigate, type InvestigationAgentReport } from "../investigation/index.js";
import { formatLlmProfilingSummary } from "../agent/llm-usage.js";
import type { GitHubDataProvider } from "../github/provider.js";
import type { TraceCollector } from "../trace/trace-collector.js";
import { LiveGitHubProvider } from "../github/live-provider.js";
import { GithubGraphQlClient, type ResolutionReferenceSource } from "../github/graphql.js";
import { GithubCommitHintSource, type UnlinkedFixCommitSource } from "../github/commit-hints.js";
import { parseGitHubIssueInput, type ParsedGitHubIssue } from "../github/issue-input.js";
import { InvestigationHttpError } from "./investigation-errors.js";

function splitRepository(repository: string): { owner: string; repository: string } {
  const [owner, name] = repository.split("/");
  return { owner, repository: name };
}

export interface RunInvestigationOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  liveProvider?: GitHubDataProvider;
  signal?: AbortSignal;
  /** Phase 17-B1: SSE streaming observes this same runtime trace. */
  trace?: TraceCollector;
  /** Phase 18-A: injectable GraphQL closing-reference source for the prescan. */
  resolutionGraphQl?: ResolutionReferenceSource;
  /** Phase 18-B: injectable file-scoped commit source for unlinked-fix hints. */
  resolutionCommitHints?: UnlinkedFixCommitSource;
}

export type InvestigationRoute =
  | { mode: "snapshot"; via: "scenario"; scenarioId: string }
  | { mode: "snapshot"; via: "case"; caseId: string }
  | { mode: "snapshot"; via: "issue"; target: ParsedGitHubIssue }
  | { mode: "live"; target: ParsedGitHubIssue };

function requestedMode(input: InvestigationRequest): InvestigationMode | undefined {
  const value = input.mode ?? input.source;
  return value === "live" || value === "snapshot" ? value : undefined;
}

function sameTarget(
  owner: string,
  repository: string,
  issueNumber: number,
  other: { owner: string; repository: string; issueNumber: number },
): boolean {
  return (
    owner.toLowerCase() === other.owner.toLowerCase() &&
    repository.toLowerCase() === other.repository.toLowerCase() &&
    issueNumber === other.issueNumber
  );
}

function realDataset() {
  return loadDataset(realDatasetManifestPath());
}

function recoveryScenarios(): readonly BenchmarkScenario[] {
  return FASEI_RECOVERY_SCENARIOS;
}

function regressionScenarios(): readonly BenchmarkScenario[] {
  return FASEI_REGRESSION_SCENARIOS;
}

function findScenario(id: string): BenchmarkScenario | undefined {
  return (
    recoveryScenarios().find((item) => item.id === id) ??
    regressionScenarios().find((item) => item.id === id)
  );
}

function toCatalogItem(input: {
  id: string;
  group: InvestigationCatalogItemDTO["group"];
  owner: string;
  repository: string;
  issueNumber: number;
  description: string;
  sourceUrl?: string;
}): InvestigationCatalogItemDTO {
  return {
    id: input.id,
    group: input.group,
    owner: input.owner,
    repository: input.repository,
    issueNumber: input.issueNumber,
    label: `${input.owner}/${input.repository}#${input.issueNumber}`,
    description: input.description,
    sourceUrl: input.sourceUrl,
  };
}

export function investigationCatalog(): InvestigationCatalogDTO {
  const dataset = realDataset();
  const snapshots = dataset.cases.map((item) => {
    const { owner, repository } = splitRepository(item.source.repository);
    return toCatalogItem({
      id: item.caseId,
      group: "real-v1",
      owner,
      repository,
      issueNumber: item.source.issueNumber,
      description: item.description ?? `Investigate ${item.source.repository}#${item.source.issueNumber}.`,
      sourceUrl: item.sourceUrl,
    });
  });
  const fixtures = regressionScenarios().map((item) =>
    toCatalogItem({
      id: item.id,
      group: "fixture",
      owner: item.target.owner,
      repository: item.target.repository,
      issueNumber: item.target.issueNumber,
      description: item.description,
    }),
  );
  const recovery = recoveryScenarios().map((item) =>
    toCatalogItem({
      id: item.id,
      group: "recovery",
      owner: item.target.owner,
      repository: item.target.repository,
      issueNumber: item.target.issueNumber,
      description: item.description,
    }),
  );
  return { snapshots, fixtures, recovery };
}

function slimCheck(check: NonNullable<InvestigationAttempt["verification"]>["checks"][number]) {
  return {
    id: check.id,
    name: check.name,
    status: check.status,
    message: check.message,
    evidenceIds: check.evidenceIds,
  };
}

function slimAttempt(attempt: InvestigationAttempt) {
  return {
    id: attempt.id,
    attempt: attempt.attempt,
    status: attempt.status,
    parentAttemptId: attempt.parentAttemptId,
    recoveryPlanId: attempt.recoveryPlanId,
    failureEventId: attempt.failureEventId,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    strategy: attempt.strategy?.type,
    verificationStatus: attempt.verification?.status,
    checks: (attempt.verification?.checks ?? []).map(slimCheck),
    agentConclusion: attempt.agentConclusion,
    failureType: attempt.failure?.type,
    failureReason: attempt.failure?.reason,
    failureTool: attempt.failure?.tool,
    failureErrorCode: attempt.failure?.errorCode,
    failureRetryable: attempt.failure?.retryable,
    missingRequirementIds: attempt.failure?.missingRequirementIds,
    recoveryId: attempt.recovery?.id,
    recoveryAction: attempt.recovery?.action,
    recoveryReason: attempt.recovery?.reason,
    recoveryNextStep: attempt.recovery?.nextStep,
    recoveryNextRequirementIds: attempt.recovery?.nextRequirementIds,
    evidenceIds: attempt.evidenceIds,
    claimIds: attempt.claimIds,
  };
}

function rawAgentOutputFrom(report: InvestigationAgentReport): string | undefined {
  const output = report.agentResult?.output;
  if (output == null) {
    return undefined;
  }
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function issueFromReport(report: InvestigationAgentReport): InvestigationIssueDTO {
  const target = report.task.target;
  const evidence = report.evidence.find((item) => item.kind === "issue");
  const payload =
    evidence?.payload && typeof evidence.payload === "object"
      ? (evidence.payload as Record<string, unknown>)
      : undefined;
  const title = typeof payload?.title === "string" ? payload.title : undefined;
  const state = typeof payload?.state === "string" ? payload.state : undefined;
  return {
    owner: target.owner,
    repository: target.repository,
    number: target.issueNumber,
    title,
    state,
    url: evidence?.provenance.url ?? target.url,
    summary: evidence?.summary,
  };
}

function toLlmUsageDTO(usage: InvestigationAgentReport["llmUsage"]): LlmUsageAggregateDTO {
  const profilingSummary = formatLlmProfilingSummary(usage);
  return {
    model: usage.model,
    llmCalls: usage.llmCalls,
    totalInputTokens: usage.totalInputTokens,
    totalCachedInputTokens: usage.totalCachedInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens,
    overallCacheHitRate: usage.overallCacheHitRate,
    averageInputTokensPerCall: usage.averageInputTokensPerCall,
    averageOutputTokensPerCall: usage.averageOutputTokensPerCall,
    summary: profilingSummary,
    profilingSummary,
    calls: usage.calls.map((call) => ({
      callId: call.callId,
      callIndex: call.callIndex,
      model: call.model,
      usage: { ...call.usage },
      durationMs: call.durationMs,
      historyLength: call.historyLength,
      attempt: call.attempt,
      agentStep: call.agentStep,
      serializedRequestChars: call.serializedRequestChars,
      estimatedInputTokens: call.estimatedInputTokens,
      messageCount: call.messageCount,
      context: call.context
        ? {
            systemMessageChars: call.context.systemMessageChars,
            userMessageChars: call.context.userMessageChars,
            assistantMessageChars: call.context.assistantMessageChars,
            toolMessageChars: call.context.toolMessageChars,
            systemMessageCount: call.context.systemMessageCount,
            userMessageCount: call.context.userMessageCount,
            assistantMessageCount: call.context.assistantMessageCount,
            toolMessageCount: call.context.toolMessageCount,
            messageCount: call.context.messageCount,
            serializedMessagesChars: call.context.serializedMessagesChars,
            serializedToolsChars: call.context.serializedToolsChars,
            estimatedMessageTokens: call.context.estimatedMessageTokens,
            estimatedToolsTokens: call.context.estimatedToolsTokens,
            estimatedTotalInputTokens: call.context.estimatedTotalInputTokens,
            estimatedInputTokens: call.context.estimatedInputTokens,
            historyLength: call.context.historyLength,
            serializedRequestChars: call.context.serializedRequestChars,
            messageRoles: call.context.messageRoles.map((item) => ({ ...item })),
            toolResultCount: call.context.toolResultCount,
            totalToolResultChars: call.context.totalToolResultChars,
            largestToolResultChars: call.context.largestToolResultChars,
            toolContributions: call.context.toolContributions.map((item) => ({ ...item })),
            messagesFingerprint: call.context.messagesFingerprint,
            toolsFingerprint: call.context.toolsFingerprint,
            messagesPrefixFingerprint: call.context.messagesPrefixFingerprint,
            messageSequenceFingerprint: call.context.messageSequenceFingerprint,
          }
        : undefined,
      ok: call.ok,
      errorCategory: call.errorCategory,
    })),
  };
}

export function toInvestigationSessionDTO(
  report: InvestigationAgentReport,
  meta: {
    mode: InvestigationMode;
    catalogId?: string;
    group?: InvestigationCatalogItemDTO["group"];
  },
): InvestigationSessionDTO {
  return {
    mode: meta.mode,
    dataSource: meta.mode,
    catalogId: meta.catalogId,
    group: meta.group,
    actor: report.actor,
    status: report.status,
    runStatus: report.run.status,
    task: {
      owner: report.task.target.owner,
      repository: report.task.target.repository,
      issueNumber: report.task.target.issueNumber,
      description: report.task.description,
    },
    issue: issueFromReport(report),
    agentOutput: rawAgentOutputFrom(report),
    rawAgentOutput: rawAgentOutputFrom(report),
    verification: report.verification
      ? {
          status: report.verification.status,
          evidenceCoverage: report.verification.evidenceCoverage,
          prematureCompletion: report.verification.prematureCompletion,
          missingRequirementIds: report.verification.missingRequirementIds,
          unsupportedClaimIds: report.verification.unsupportedClaimIds,
          checks: report.verification.checks.map(slimCheck),
        }
      : undefined,
    evidence: report.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      trust: item.provenance.trust,
      url: item.provenance.url,
      source: item.provenance.source,
      operation: item.provenance.operation,
      resource: item.provenance.resource,
      repository: item.provenance.repository,
      retrievedAt: item.provenance.retrievedAt,
    })),
    relations: report.run.relations.map((item) => ({
      fromEvidenceId: item.fromEvidenceId,
      toEvidenceId: item.toEvidenceId,
      type: item.type,
    })),
    claims: report.claims.map((item) => ({
      id: item.id,
      text: item.text,
      polarity: item.polarity,
      critical: item.critical,
    })),
    claimEvidence: report.claimEvidence.map((item) => ({
      claimId: item.claimId,
      evidenceId: item.evidenceId,
      role: item.role,
    })),
    resolutionAnalyses: (report.resolutionAnalyses ?? []).map((item) => ({
      candidateId: item.candidateId,
      candidateEvidenceId: item.candidateEvidenceId,
      issueEvidenceId: item.issueEvidenceId,
      mergeCommitSha: item.mergeCommitSha,
      codeRelevance: item.codeRelevance,
      behavioralAlignment: item.behavioralAlignment,
      testSupport: item.testSupport,
      unresolvedQuestions: [...item.unresolvedQuestions],
      supportingEvidenceIds: [...item.supportingEvidenceIds],
      claimIds: [...item.claimIds],
      signals: (item.signals ?? []).map((signal) => ({
        type: signal.type,
        status: signal.status,
        evidenceIds: [...signal.evidenceIds],
        explanation: signal.explanation,
      })),
      overall: item.overall ?? "unknown",
      provenance: (item.provenance ?? []).map((ref) => ({
        evidenceId: ref.evidenceId,
        role: ref.role,
        trust: ref.trust,
      })),
    })),
    steps: report.investigationSteps.map((step) => ({
      step: step.step,
      tool: step.tool,
      success: step.success,
      reason: step.reason,
      evidenceIds: step.evidenceIds,
    })),
    attempts: report.run.attempts.map(slimAttempt),
    report: {
      conclusion: report.report.conclusion,
      polarity: report.report.polarity,
      resolutionMethod: report.report.resolutionMethod,
      uncertainty: report.report.uncertainty,
      openQuestions: report.report.openQuestions,
    },
    llmUsage: toLlmUsageDTO(report.llmUsage),
    runtimeBudget: report.runtimeBudget,
  };
}

function parseRequestTarget(input: InvestigationRequest): ParsedGitHubIssue | undefined {
  const raw = typeof input.issue === "string" ? input.issue : typeof input.input === "string" ? input.input : "";
  if (raw.trim()) {
    return parseGitHubIssueInput(raw);
  }
  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const issueNumber =
    typeof input.issueNumber === "number"
      ? input.issueNumber
      : typeof input.issueNumber === "string" && /^\d+$/.test(input.issueNumber)
        ? Number(input.issueNumber)
        : undefined;
  if (owner && repository && issueNumber) {
    return parseGitHubIssueInput(`${owner}/${repository}#${issueNumber}`);
  }
  return undefined;
}

export function resolveInvestigationRoute(input: InvestigationRequest): InvestigationRoute {
  const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId.trim() : "";
  if (scenarioId) {
    return { mode: "snapshot", via: "scenario", scenarioId };
  }
  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  if (caseId) {
    return { mode: "snapshot", via: "case", caseId };
  }
  const mode = requestedMode(input) ?? "live";
  const target = parseRequestTarget(input);
  if (!target) {
    throw new InvestigationHttpError(400, {
      code: "INVALID_GITHUB_ISSUE_INPUT",
      message: "Enter a GitHub Issue URL or owner/repo#number.",
    });
  }
  if (mode === "snapshot") {
    return { mode: "snapshot", via: "issue", target };
  }
  return { mode: "live", target };
}

async function runSnapshotIssue(
  target: ParsedGitHubIssue,
  trace?: TraceCollector,
): Promise<InvestigationSessionDTO> {
  const dataset = realDataset();
  const matchedCase = dataset.cases.find((item) => {
    const { owner, repository } = splitRepository(item.source.repository);
    return sameTarget(target.owner, target.repository, target.issueNumber, {
      owner,
      repository,
      issueNumber: item.source.issueNumber,
    });
  });
  if (matchedCase) {
    const scenario = convertCaseToScenario(dataset, matchedCase);
    const report = await executeScenario(scenario, trace);
    return toInvestigationSessionDTO(report, {
      mode: "snapshot",
      catalogId: matchedCase.caseId,
      group: "real-v1",
    });
  }
  const matchedFixture = regressionScenarios().find((item) =>
    sameTarget(target.owner, target.repository, target.issueNumber, {
      owner: item.target.owner,
      repository: item.target.repository,
      issueNumber: item.target.issueNumber,
    }),
  );
  if (matchedFixture) {
    const report = await executeScenario(matchedFixture, trace);
    return toInvestigationSessionDTO(report, {
      mode: "snapshot",
      catalogId: matchedFixture.id,
      group: "fixture",
    });
  }
  throw new InvestigationHttpError(404, {
    code: "SNAPSHOT_NOT_FOUND",
    message: `No recorded snapshot for ${target.owner}/${target.repository}#${target.issueNumber}.`,
  });
}

async function runLiveIssue(
  target: ParsedGitHubIssue,
  options: RunInvestigationOptions,
): Promise<InvestigationSessionDTO> {
  const provider =
    options.liveProvider ??
    new LiveGitHubProvider({
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl,
    });
  await provider.getIssue({
    owner: target.owner,
    repo: target.repository,
    issueNumber: target.issueNumber,
  });
  const report = await investigate({
    task: {
      owner: target.owner,
      repository: target.repository,
      issueNumber: target.issueNumber,
      description: `Investigate whether ${target.owner}/${target.repository}#${target.issueNumber} is independently resolved.`,
    },
    provider,
    env: options.env,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    trace: options.trace,
    resolutionPrescan: {
      enabled: true,
      graphQl:
        options.resolutionGraphQl ??
        new GithubGraphQlClient({
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
        }),
      commitHints: options.resolutionCommitHints ?? new GithubCommitHintSource(),
    },
  });
  return toInvestigationSessionDTO(report, { mode: "live" });
}

export async function runInvestigation(
  input: InvestigationRequest,
  options: RunInvestigationOptions = {},
): Promise<InvestigationSessionDTO> {
  const route = resolveInvestigationRoute(input);
  if (route.mode === "snapshot" && route.via === "scenario") {
    const scenario = findScenario(route.scenarioId);
    if (!scenario) {
      throw Object.assign(new Error(`Unknown scenario: ${route.scenarioId}`), { status: 404 });
    }
    const report = await executeScenario(scenario, options.trace);
    return toInvestigationSessionDTO(report, {
      mode: "snapshot",
      catalogId: scenario.id,
      group: recoveryScenarios().some((item) => item.id === scenario.id) ? "recovery" : "fixture",
    });
  }
  if (route.mode === "snapshot" && route.via === "case") {
    const dataset = realDataset();
    const found = dataset.cases.find((item) => item.caseId === route.caseId);
    if (!found) {
      throw Object.assign(new Error(`Unknown Real-v1 case: ${route.caseId}`), { status: 404 });
    }
    const scenario = convertCaseToScenario(dataset, found);
    const report = await executeScenario(scenario, options.trace);
    return toInvestigationSessionDTO(report, {
      mode: "snapshot",
      catalogId: found.caseId,
      group: "real-v1",
    });
  }
  if (route.mode === "snapshot") {
    return runSnapshotIssue(route.target, options.trace);
  }
  return runLiveIssue(route.target, options);
}

export interface InvestigateGitHubIssueOptions extends RunInvestigationOptions {
  mode?: InvestigationMode;
}

export async function investigateGitHubIssue(
  input: string,
  options: InvestigateGitHubIssueOptions = {},
): Promise<InvestigationSessionDTO> {
  const target = parseGitHubIssueInput(input);
  const mode = options.mode ?? "live";
  return runInvestigation(
    {
      owner: target.owner,
      repository: target.repository,
      issueNumber: target.issueNumber,
      mode,
    },
    options,
  );
}

export function loadRealV1BenchmarkResult(): DatasetBenchmarkResult {
  const path = realDatasetLatestResultPath();
  if (!existsSync(path)) {
    throw Object.assign(new Error("还没有 Real-v1 CLI 结果。请先运行 npm run benchmark:real。"), {
      status: 404,
    });
  }
  return JSON.parse(readFileSync(path, "utf8")) as DatasetBenchmarkResult;
}
