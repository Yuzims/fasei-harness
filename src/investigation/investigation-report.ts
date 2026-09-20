import type {
  ClaimPolarity,
  InvestigationReport,
  InvestigationTask,
  VerificationResult,
} from "../domain/index.js";
import type { AgentResult } from "../core/types.js";
import { aggregateLlmUsage, type LlmUsageAggregate } from "../agent/llm-usage.js";
import type { LlmRuntimeBudget } from "../agent/llm-runtime.js";
import type { InvestigationRun, ResolutionAnalysis } from "../domain/index.js";
import type { InvestigationState, ToolHistoryEntry } from "./state.js";
import type { RetrievalCandidate } from "./retrieval/candidate.js";
import type { RecoveryAttempt } from "./recovery/recovery-attempt.js";
import {
  RETRIEVAL_TOP_K,
  investigatedCandidatesFromEvents,
  investigationCandidatesOf,
  promotedCandidatesOf,
  retrievalTopKOf,
} from "./retrieval/selection.js";

export type InvestigationActor = "llm" | "test_driver" | "unconfigured";

/** Investigation outcome only. Never the Harness verification verdict. */
export type InvestigationAgentStatus =
  | "investigated"
  | "partial"
  | "insufficient_evidence"
  | "unconfigured";

export interface InvestigationStep {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  reason?: string;
  success: boolean;
  evidenceIds: string[];
}

export interface InvestigationAgentReport {
  task: InvestigationTask;
  status: InvestigationAgentStatus;
  run: InvestigationRun;
  report: InvestigationReport;
  claims: InvestigationRun["claims"];
  evidence: InvestigationRun["evidence"];
  claimEvidence: InvestigationRun["claimEvidence"];
  resolutionAnalyses: ResolutionAnalysis[];
  unresolvedQuestions: string[];
  investigationSteps: InvestigationStep[];
  actor: InvestigationActor;
  agentResult?: AgentResult;
  /** Produced by IndependentCompletionVerifier, never by the Agent. */
  verification?: VerificationResult;
  llmUsage: LlmUsageAggregate;
  runtimeBudget?: LlmRuntimeBudget;
  retrievalCandidates: RetrievalCandidate[];
  /**
   * Actual AgentLoop tool_call events. Not investigationSteps.length.
   * investigationSteps is tool history / observations, which can differ.
   */
  toolCallCount: number;
  /**
   * Combined retrieval Top-K used for Recall@K / Precision@K.
   * Not inferred from promoted. Not the per-source-type investigation budget.
   */
  retrievalTopKCandidates: RetrievalCandidate[];
  /** Candidates admitted into the per-source-type investigation budget. */
  investigationCandidates: RetrievalCandidate[];
  /**
   * Candidates that actually entered investigation (`retrieval_investigation_started`).
   * Distinct from budget admission and from promotion.
   */
  investigatedCandidates: RetrievalCandidate[];
  /** Candidates promoted by the existing candidate lifecycle. */
  promotedCandidates: RetrievalCandidate[];
  /** Phase 11.1 RecoveryAttempts. Linked to parent InvestigationAttempts; never replace them. */
  recoveryAttempts: RecoveryAttempt[];
}

export function countTraceToolCalls(events: readonly { type: string }[]): number {
  return events.filter((event) => event.type === "tool_call").length;
}

function cloneCandidates(candidates: readonly RetrievalCandidate[]): RetrievalCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    relevanceSignals: { ...candidate.relevanceSignals },
  }));
}

export function stepsFromHistory(history: ToolHistoryEntry[]): InvestigationStep[] {
  return history.map((entry, index) => ({
    step: index + 1,
    tool: entry.tool,
    arguments: entry.arguments,
    reason: entry.reason,
    success: entry.success,
    evidenceIds: entry.evidenceIds,
  }));
}

export function deriveInvestigationStatus(state: InvestigationState): InvestigationAgentStatus {
  const hasIssue = state.evidenceByKind("issue").length > 0;
  if (!hasIssue) {
    return "insufficient_evidence";
  }
  if (state.mergedPrs.size > 0) {
    return "investigated";
  }
  if (state.candidatePrs.size > 0 || state.unmergedPrs.size > 0) {
    return "partial";
  }
  return "insufficient_evidence";
}

export function derivePolarity(
  status: InvestigationAgentStatus,
  recorded: ClaimPolarity,
): ClaimPolarity {
  if (status === "investigated") {
    return recorded === "unresolved" ? "resolved" : recorded === "unknown" ? "resolved" : recorded;
  }
  if (status === "partial") {
    return recorded === "resolved" ? "partial" : recorded === "unknown" ? "partial" : recorded;
  }
  if (status === "insufficient_evidence") {
    return recorded === "resolved" ? "unknown" : recorded;
  }
  return "unknown";
}

export function buildInvestigationReport(
  state: InvestigationState,
  status: InvestigationAgentStatus,
): InvestigationReport {
  const polarity = derivePolarity(status, state.polarity);
  const merged = [...state.mergedPrs];
  const resolutionMethod =
    merged.length > 0 ? `candidate merged PR: ${merged.map((n) => `#${n}`).join(", ")}` : undefined;
  const questions = [...state.unresolvedQuestions];
  if (status === "insufficient_evidence" && questions.length === 0) {
    questions.push("No merged pull request, commit, or other resolution evidence was found.");
  }
  if (status === "partial" && questions.length === 0) {
    questions.push("A related pull request exists but is not merged.");
  }

  const conclusion =
    state.conclusion ||
    (status === "investigated"
      ? `Issue ${state.task.target.owner}/${state.task.target.repository}#${state.task.target.issueNumber} has a merged PR candidate; this is an investigation claim, not verification.`
      : status === "partial"
        ? `Issue #${state.task.target.issueNumber} is closed or related to a PR, but merge evidence is missing.`
        : `Insufficient evidence to explain how issue #${state.task.target.issueNumber} was resolved.`);

  return {
    conclusion,
    polarity,
    resolutionMethod,
    evidenceChain: state.run.evidence.map((item) => item.id),
    claimIds: state.run.claims.map((item) => item.id),
    uncertainty:
      "Investigation claims are hypotheses. IndependentCompletionVerifier decides VerificationResult. Agent conclusion is not verification.",
    openQuestions: questions,
  };
}

export function toAgentReport(input: {
  state: InvestigationState;
  actor: InvestigationActor;
  agentResult?: AgentResult;
  status?: InvestigationAgentStatus;
  verification?: VerificationResult;
  llmUsage?: LlmUsageAggregate;
  runtimeBudget?: LlmRuntimeBudget;
  traceEvents?: readonly { type: string; data?: Record<string, unknown> }[];
}): InvestigationAgentReport {
  const status = input.status ?? deriveInvestigationStatus(input.state);
  const report = buildInvestigationReport(input.state, status);
  const discovered = cloneCandidates(input.state.retrievalCandidates);
  const investigation = cloneCandidates(investigationCandidatesOf(input.state.retrievalCandidates));
  return {
    task: input.state.task,
    status,
    run: input.state.run,
    report,
    claims: input.state.run.claims,
    evidence: input.state.run.evidence,
    claimEvidence: input.state.run.claimEvidence,
    resolutionAnalyses: input.state.run.resolutionAnalyses ?? [],
    unresolvedQuestions: report.openQuestions,
    investigationSteps: stepsFromHistory(input.state.toolHistory),
    actor: input.actor,
    agentResult: input.agentResult,
    verification: input.verification,
    llmUsage: input.llmUsage ?? aggregateLlmUsage([]),
    runtimeBudget: input.runtimeBudget,
    retrievalCandidates: discovered,
    toolCallCount: countTraceToolCalls(input.traceEvents ?? []),
    retrievalTopKCandidates: cloneCandidates(retrievalTopKOf(input.state.retrievalCandidates, RETRIEVAL_TOP_K)),
    investigationCandidates: investigation,
    investigatedCandidates: cloneCandidates(
      investigatedCandidatesFromEvents(input.state.retrievalCandidates, input.traceEvents ?? []),
    ),
    promotedCandidates: cloneCandidates(promotedCandidatesOf(input.state.retrievalCandidates)),
    recoveryAttempts: [...input.state.recoveryAttempts],
  };
}
