import { existsSync, readFileSync } from "node:fs";
import type {
  InvestigationCatalogDTO,
  InvestigationCatalogItemDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
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
import type { InvestigationAgentReport } from "../investigation/index.js";
import type { InvestigationAttempt } from "../domain/index.js";

function splitRepository(repository: string): { owner: string; repository: string } {
  const [owner, name] = repository.split("/");
  return { owner, repository: name };
}

function parseIssueRef(raw: string): { owner: string; repository: string; issueNumber: number } | undefined {
  const text = raw.trim();
  const url = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i);
  if (url) {
    return { owner: url[1], repository: url[2], issueNumber: Number(url[3]) };
  }
  const short = text.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short) {
    return { owner: short[1], repository: short[2], issueNumber: Number(short[3]) };
  }
  return undefined;
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
    evidenceIds: attempt.evidenceIds,
    claimIds: attempt.claimIds,
  };
}

export function toInvestigationSessionDTO(
  report: InvestigationAgentReport,
  meta: {
    dataSource: InvestigationSessionDTO["dataSource"];
    catalogId?: string;
    group?: InvestigationCatalogItemDTO["group"];
  },
): InvestigationSessionDTO {
  return {
    dataSource: meta.dataSource,
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
  };
}

function resolveTarget(input: InvestigationRequest): {
  owner?: string;
  repository?: string;
  issueNumber?: number;
} {
  if (typeof input.issue === "string") {
    const parsed = parseIssueRef(input.issue);
    if (parsed) {
      return parsed;
    }
  }
  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const issueNumber =
    typeof input.issueNumber === "number"
      ? input.issueNumber
      : typeof input.issueNumber === "string" && /^\d+$/.test(input.issueNumber)
        ? Number(input.issueNumber)
        : undefined;
  return {
    owner: owner || undefined,
    repository: repository || undefined,
    issueNumber,
  };
}

export async function runInvestigation(input: InvestigationRequest): Promise<InvestigationSessionDTO> {
  const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId.trim() : "";
  if (scenarioId) {
    const scenario = findScenario(scenarioId);
    if (!scenario) {
      throw Object.assign(new Error(`未知 scenario：${scenarioId}`), { status: 404 });
    }
    const report = await executeScenario(scenario);
    return toInvestigationSessionDTO(report, {
      dataSource: "snapshot",
      catalogId: scenario.id,
      group: recoveryScenarios().some((item) => item.id === scenario.id) ? "recovery" : "fixture",
    });
  }

  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  const dataset = realDataset();
  if (caseId) {
    const found = dataset.cases.find((item) => item.caseId === caseId);
    if (!found) {
      throw Object.assign(new Error(`未知 Real-v1 case：${caseId}`), { status: 404 });
    }
    const scenario = convertCaseToScenario(dataset, found);
    const report = await executeScenario(scenario);
    return toInvestigationSessionDTO(report, {
      dataSource: "snapshot",
      catalogId: found.caseId,
      group: "real-v1",
    });
  }

  const target = resolveTarget(input);
  if (!target.owner || !target.repository || !target.issueNumber) {
    throw Object.assign(
      new Error("需要 GitHub Issue（owner/repository#number）、caseId 或 scenarioId"),
      { status: 400 },
    );
  }

  const matchedCase = dataset.cases.find((item) => {
    const { owner, repository } = splitRepository(item.source.repository);
    return sameTarget(target.owner!, target.repository!, target.issueNumber!, {
      owner,
      repository,
      issueNumber: item.source.issueNumber,
    });
  });
  if (matchedCase) {
    const scenario = convertCaseToScenario(dataset, matchedCase);
    const report = await executeScenario(scenario);
    return toInvestigationSessionDTO(report, {
      dataSource: "snapshot",
      catalogId: matchedCase.caseId,
      group: "real-v1",
    });
  }

  const matchedFixture = regressionScenarios().find((item) =>
    sameTarget(target.owner!, target.repository!, target.issueNumber!, {
      owner: item.target.owner,
      repository: item.target.repository,
      issueNumber: item.target.issueNumber,
    }),
  );
  if (matchedFixture) {
    const report = await executeScenario(matchedFixture);
    return toInvestigationSessionDTO(report, {
      dataSource: "snapshot",
      catalogId: matchedFixture.id,
      group: "fixture",
    });
  }

  throw Object.assign(
    new Error(
      `没有 ${target.owner}/${target.repository}#${target.issueNumber} 的 recorded snapshot。当前 API 只跑 Snapshot replay（Real-v1 / fixtures / recovery scenarios），不调用 live GitHub。`,
    ),
    { status: 404 },
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
