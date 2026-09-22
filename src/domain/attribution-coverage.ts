import type { AttributionCoverage, ResolutionPrescanCandidate, ResolutionPrescanRecord } from "./types.js";

/**
 * A prescan candidate is adjudicated when its facts were fully read: detail
 * fetch completed, or GitHub authoritatively said it is not a PR. Field
 * comparison only — no text, no LLM.
 */
function isAdjudicated(candidate: ResolutionPrescanCandidate): boolean {
  return candidate.detailState === "completed" || candidate.detailState === "not_a_pull_request";
}

export interface AttributionCoverageInput {
  /** Absent prescan record means the structured chain was never enumerated. */
  prescan?: ResolutionPrescanRecord;
  llmCallsSent: number;
  maxLlmCalls: number;
  /** Runtime aborted on the wall-clock budget (failure type field, not text). */
  runtimeBudgetFailure?: boolean;
}

/**
 * Phase 18-C: machine-decidable attribution coverage. A budget-exhausted
 * middle conclusion must never masquerade as an exhausted converged verdict:
 * "exhausted" requires prescan completion plus full candidate adjudication,
 * and is never asserted when no prescan ran.
 */
export function deriveAttributionCoverage(input: AttributionCoverageInput): AttributionCoverage {
  const { prescan } = input;
  const budgetExhausted =
    input.runtimeBudgetFailure === true || input.llmCallsSent >= input.maxLlmCalls;

  if (!prescan) {
    return {
      state: "not_assertable",
      prescanState: "absent",
      candidatesEnumerated: 0,
      candidatesAdjudicated: 0,
      unadjudicatedCandidates: [],
      unenumeratedCandidates: 0,
      budgetExhausted,
    };
  }

  const prescanState = prescan.state;
  const unadjudicatedCandidates = prescan.candidates
    .filter((candidate) => !isAdjudicated(candidate))
    .map((candidate) => candidate.pullNumber);
  const candidatesAdjudicated = prescan.candidates.length - unadjudicatedCandidates.length;
  const unenumeratedCandidates = Math.max(
    0,
    prescan.candidatesEnumerated - prescan.candidates.length,
  );

  const exhausted =
    prescanState === "completed" &&
    unadjudicatedCandidates.length === 0 &&
    unenumeratedCandidates === 0;

  return {
    state: exhausted ? "exhausted" : "mid_run",
    prescanState,
    candidatesEnumerated: prescan.candidatesEnumerated,
    candidatesAdjudicated,
    unadjudicatedCandidates,
    unenumeratedCandidates,
    budgetExhausted,
  };
}
