/**
 * Phase 10.2 — Resolution Gap Analyzer evaluation.
 *
 * Observes whether Resolution Gaps correctly expose information holes on
 * Real-v1 C01 / C07 / C08. This is not an accuracy score and not a verifier.
 * Does not reimplement IndependentCompletionVerifier, retrieval, ranking,
 * Evidence-Gap Strategy, RecoveryPlanner, or Ground Truth.
 */
import { DEFAULT_LLM_RUNTIME_BUDGET } from "../agent/llm-runtime.js";
import {
  convertCaseToScenario,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadCaseSnapshot,
  loadDataset,
  realDatasetManifestPath,
} from "../benchmark/dataset/index.js";
import { createInvestigationTask, graphFromRun } from "../domain/index.js";
import type { ResolutionAnalysis, ResolutionGap, VerificationStatus } from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import {
  IndependentCompletionVerifier,
  analyzeResolutionGaps,
  buildResolutionChain,
  investigate,
  type InvestigationAgentReport,
} from "../investigation/index.js";
import { createStrategyEvaluationModel } from "./strategy-evaluation.js";

type StrategyCollector = Parameters<typeof createStrategyEvaluationModel>[1];

export const RESOLUTION_GAP_EVALUATION_VERSION = "10.2";

export const RESOLUTION_GAP_FOCUS_CASES = ["C01", "C07", "C08"] as const;

export const RESOLUTION_GAP_EVALUATION_NOTE =
  "Phase 10.2 observes whether Resolution Gaps expose missing resolution evidence. Gaps are not a completion verdict and cannot become VERIFIED_COMPLETE.";

export interface Phase102GapView {
  type: ResolutionGap["type"];
  severity: ResolutionGap["severity"];
  missingEvidenceTypes: string[];
  evidenceIds: string[];
  recommendedActions: ResolutionGap["recommendedActions"];
  explanation: string;
}

export interface Phase102GapObservation {
  caseId: string;
  overall: string;
  candidatePresent: boolean;
  fileEvidencePresent: boolean;
  patchEvidencePresent: boolean;
  gaps: Phase102GapView[];
  gapTypes: ResolutionGap["type"][];
  verificationStatus: VerificationStatus;
  verifierInvariant: boolean;
  notes: string[];
}

function analysisRank(analysis: ResolutionAnalysis): number {
  const file = analysis.signals.find((item) => item.type === "file_scope_alignment")?.status;
  const patch = analysis.signals.find((item) => item.type === "patch_intent_alignment")?.status;
  const test = analysis.signals.find((item) => item.type === "test_evidence")?.status;
  return (
    (analysis.overall === "supported" ? 8 : analysis.overall === "partial" ? 4 : 0) +
    (file === "supported" ? 4 : file === "partial" ? 2 : 0) +
    (patch === "supported" ? 3 : patch === "partial" ? 1 : 0) +
    (test === "present" ? 1 : 0) +
    analysis.provenance.filter((item) => item.role === "file_change" || item.role === "patch").length
  );
}

function verificationStatusOf(report: InvestigationAgentReport): VerificationStatus {
  const status = report.verification?.status ?? report.run.status;
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return "not_verified";
}

function gapView(gap: ResolutionGap): Phase102GapView {
  return {
    type: gap.type,
    severity: gap.severity,
    missingEvidenceTypes: [...gap.missingEvidenceTypes],
    evidenceIds: [...gap.evidenceIds],
    recommendedActions: [...gap.recommendedActions],
    explanation: gap.explanation,
  };
}

export function phase102VerifierInvariantHolds(report: InvestigationAgentReport): boolean {
  const verifier = new IndependentCompletionVerifier();
  const withAnalysis = verifier.verify({ task: report.task, run: report.run });
  analyzeResolutionGapsForPrimary(report);
  const afterGaps = verifier.verify({ task: report.task, run: report.run });
  const withoutAnalysis = verifier.verify({
    task: report.task,
    run: { ...report.run, resolutionAnalyses: [] },
  });
  if (withAnalysis.status !== afterGaps.status || withAnalysis.status !== withoutAnalysis.status) {
    return false;
  }
  const fingerprint = (result: { checks: Array<{ id: string; status: string }> }) =>
    result.checks.map((item) => `${item.id}:${item.status}`).join("|");
  return fingerprint(withAnalysis) === fingerprint(afterGaps) && fingerprint(withAnalysis) === fingerprint(withoutAnalysis);
}

function analyzeResolutionGapsForPrimary(report: InvestigationAgentReport): ResolutionGap[] {
  const graph = graphFromRun(report.run);
  const analyses = [...(report.resolutionAnalyses ?? [])].sort((left, right) => analysisRank(right) - analysisRank(left));
  const chain = buildResolutionChain({ graph, analysis: analyses[0] });
  return analyzeResolutionGaps(chain, graph);
}

export function observeResolutionGaps(report: InvestigationAgentReport, caseId: string): Phase102GapObservation {
  const graph = graphFromRun(report.run);
  const analyses = [...(report.resolutionAnalyses ?? [])].sort((left, right) => analysisRank(right) - analysisRank(left));
  const chain = buildResolutionChain({ graph, analysis: analyses[0] });
  const gaps = analyzeResolutionGaps(chain, graph);
  const notes: string[] = [];
  if (!analyses[0]) {
    notes.push("No Resolution Analysis claim was produced for this run.");
  }
  if (gaps.some((item) => item.evidenceIds.length === 0)) {
    notes.push("A gap was produced without Evidence IDs.");
  }
  if (gaps.some((item) => /no code change happened|no tests exist/i.test(item.explanation))) {
    notes.push("A gap claimed absence from unknown evidence.");
  }
  return {
    caseId,
    overall: chain.overall,
    candidatePresent: chain.candidate.status === "observed",
    fileEvidencePresent: chain.affected_area.status === "observed",
    patchEvidencePresent: chain.code_change.status === "observed",
    gaps: gaps.map(gapView),
    gapTypes: gaps.map((item) => item.type),
    verificationStatus: verificationStatusOf(report),
    verifierInvariant: phase102VerifierInvariantHolds(report),
    notes,
  };
}

export async function evaluatePhase102ResolutionCase(caseId: string): Promise<Phase102GapObservation> {
  const dataset = loadDataset(realDatasetManifestPath());
  const datasetCase = loadCase(dataset, caseId);
  const snapshot = loadCaseSnapshot(dataset, datasetCase);
  const scenario = convertCaseToScenario(dataset, datasetCase);
  if ("expectedOutcome" in scenario && scenario.expectedOutcome !== undefined) {
    throw new Error(`real dataset case ${caseId} leaked expectedOutcome into the agent scenario`);
  }
  expectedOutcomeForDatasetCase(dataset, caseId);
  const collector: StrategyCollector = {
    llmCalls: 0,
    estimatedInputTokens: null,
    estimatedMessageChars: 0,
    estimatedToolResultChars: 0,
    actions: [],
    missingCandidateMapping: false,
  };
  const report = await investigate({
    task: createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    }),
    provider: new SnapshotGitHubProvider(snapshot),
    maxAttempts: 3,
    maxSteps: 12,
    llmRuntimeBudget: {
      maxLlmCalls: DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls,
      maxWallClockMs: DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs,
    },
    compactPatchExposure: "patch_enabled",
    modelFactory: (session) => createStrategyEvaluationModel(session, collector),
  });
  return observeResolutionGaps(report, caseId);
}

export async function evaluatePhase102FocusCases(
  caseIds: readonly string[] = RESOLUTION_GAP_FOCUS_CASES,
): Promise<Phase102GapObservation[]> {
  const results: Phase102GapObservation[] = [];
  for (const caseId of caseIds) {
    results.push(await evaluatePhase102ResolutionCase(caseId));
  }
  return results;
}
