/**
 * Phase 10.0 — Resolution Effect Analysis evaluation.
 *
 * Observes Candidate Resolution Evidence Analysis on Real-v1 C01 / C07 / C08.
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
import { createInvestigationTask } from "../domain/index.js";
import type { ResolutionAnalysis, ResolutionSignal, VerificationStatus } from "../domain/index.js";
import { SnapshotGitHubProvider } from "../github/snapshot-provider.js";
import {
  IndependentCompletionVerifier,
  investigate,
  type InvestigationAgentReport,
} from "../investigation/index.js";
import { createStrategyEvaluationModel } from "./strategy-evaluation.js";

type StrategyCollector = Parameters<typeof createStrategyEvaluationModel>[1];

export const RESOLUTION_EFFECT_EVALUATION_VERSION = "10.0";

export const RESOLUTION_EFFECT_FOCUS_CASES = ["C01", "C07", "C08"] as const;

export const RESOLUTION_EFFECT_EVALUATION_NOTE =
  "Phase 10.0 observes whether a PR/commit candidate has supporting resolution evidence. Signals are investigation claims. They do not decide that an issue is solved and cannot become VERIFIED_COMPLETE.";

export interface Phase10SignalView {
  type: ResolutionSignal["type"];
  status: ResolutionSignal["status"];
  evidenceIds: string[];
  explanation?: string;
}

export interface Phase10ResolutionObservation {
  caseId: string;
  candidatePresent: boolean;
  candidateKinds: string[];
  fileEvidencePresent: boolean;
  patchEvidencePresent: boolean;
  fileScope?: Phase10SignalView;
  patchIntent?: Phase10SignalView;
  testEvidence?: Phase10SignalView;
  overall: string;
  verificationStatus: VerificationStatus;
  verifierInvariant: boolean;
  resolutionClaimPresent: boolean;
  notes: string[];
}

function signalView(signal: ResolutionSignal | undefined): Phase10SignalView | undefined {
  if (!signal) {
    return undefined;
  }
  return {
    type: signal.type,
    status: signal.status,
    evidenceIds: [...signal.evidenceIds],
    explanation: signal.explanation,
  };
}

function verificationStatusOf(report: InvestigationAgentReport): VerificationStatus {
  const status = report.verification?.status ?? report.run.status;
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return "not_verified";
}

export function phase10VerifierInvariantHolds(report: InvestigationAgentReport): boolean {
  const verifier = new IndependentCompletionVerifier();
  const withAnalysis = verifier.verify({ task: report.task, run: report.run });
  const withoutAnalysis = verifier.verify({
    task: report.task,
    run: { ...report.run, resolutionAnalyses: [] },
  });
  if (withAnalysis.status !== withoutAnalysis.status) {
    return false;
  }
  const left = withAnalysis.checks.map((item) => `${item.id}:${item.status}`).join("|");
  const right = withoutAnalysis.checks.map((item) => `${item.id}:${item.status}`).join("|");
  return left === right;
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

export function observeResolutionEffect(report: InvestigationAgentReport, caseId: string): Phase10ResolutionObservation {
  const analyses = report.resolutionAnalyses ?? [];
  const analysis = [...analyses].sort((left, right) => analysisRank(right) - analysisRank(left))[0];
  const evidence = report.run.evidence;
  const candidatePresent = evidence.some(
    (item) =>
      (item.kind === "pull_request" && item.contentRef?.startsWith("pr:") && !item.contentRef.startsWith("pr-merge:")) ||
      item.kind === "commit",
  );
  const fileEvidencePresent = evidence.some((item) => item.kind === "file");
  const patchEvidencePresent = evidence.some((item) => {
    if (item.kind !== "file" || !item.payload || typeof item.payload !== "object") {
      return false;
    }
    const patch = (item.payload as { patch?: unknown }).patch;
    return typeof patch === "string" && patch.length > 0;
  });
  const notes: string[] = [];
  if (!analysis) {
    notes.push("No Resolution Analysis claim was produced for this run.");
  }
  if (analysis && analysis.overall !== "unknown" && analysis.overall !== "partial" && analysis.overall !== "supported") {
    notes.push("Unexpected overall status.");
  }
  if (analysis?.signals.some((item) => item.evidenceIds.length === 0)) {
    notes.push("A signal was produced without Evidence IDs.");
  }
  return {
    caseId,
    candidatePresent,
    candidateKinds: [
      ...new Set(
        evidence
          .filter(
            (item) =>
              (item.kind === "pull_request" && item.contentRef?.startsWith("pr:") && !item.contentRef.startsWith("pr-merge:")) ||
              item.kind === "commit",
          )
          .map((item) => item.kind),
      ),
    ],
    fileEvidencePresent,
    patchEvidencePresent,
    fileScope: signalView(analysis?.signals.find((item) => item.type === "file_scope_alignment")),
    patchIntent: signalView(analysis?.signals.find((item) => item.type === "patch_intent_alignment")),
    testEvidence: signalView(analysis?.signals.find((item) => item.type === "test_evidence")),
    overall: analysis?.overall ?? "unknown",
    verificationStatus: verificationStatusOf(report),
    verifierInvariant: phase10VerifierInvariantHolds(report),
    resolutionClaimPresent: analyses.length > 0,
    notes,
  };
}

export async function evaluatePhase10ResolutionCase(caseId: string): Promise<Phase10ResolutionObservation> {
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
  return observeResolutionEffect(report, caseId);
}

export async function evaluatePhase10FocusCases(
  caseIds: readonly string[] = RESOLUTION_EFFECT_FOCUS_CASES,
): Promise<Phase10ResolutionObservation[]> {
  const results: Phase10ResolutionObservation[] = [];
  for (const caseId of caseIds) {
    results.push(await evaluatePhase10ResolutionCase(caseId));
  }
  return results;
}
