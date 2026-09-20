/**
 * Deterministic investigation stop / closure semantics.
 *
 * Legal actions remaining is not the same as "should continue".
 * This decision does not implement IndependentCompletionVerifier verdicts
 * and does not attempt to close semantic resolution_effect alignment.
 */
import {
  unresolvedRequiredGaps,
  type EvidenceGap,
  type EvidenceGapItem,
} from "./evidence-gap.js";
import type { InvestigationState } from "./state.js";

interface ClosureAction {
  tool: string;
  targetRequirementIds: string[];
  exploratory?: boolean;
}

export type InvestigationClosureStatus =
  | "GAP_CLOSED"
  | "GAP_OPEN_ACTIONABLE"
  | "GAP_OPEN_UNRESOLVABLE"
  | "NO_LEGAL_ACTION";

export const GAP_CLOSED_REASON =
  "Harness stopped: current evidence is sufficient to end investigation. Independent verification will judge completion.";

export const GAP_OPEN_UNRESOLVABLE_REASON =
  "Harness stopped: remaining evidence gap cannot be closed by current investigation actions. Not verified.";

export const NO_LEGAL_INVESTIGATION_ACTION =
  "Harness stopped: no remaining legal investigation actions. Not verified.";

/** Phase 16.3-B: the last LLM call is reserved for the Agent's Final decision. */
export const FINALIZATION_BUDGET_REASON =
  "Harness stopped: the remaining LLM call is reserved for the Agent's Final answer. No further investigation actions are legal. Independent verification will judge completion.";

export interface InvestigationClosureDecision<T extends ClosureAction = ClosureAction> {
  status: InvestigationClosureStatus;
  legalActions: T[];
  reason: string;
}

function itemFor(
  gap: EvidenceGap,
  condition: EvidenceGapItem["condition"],
): EvidenceGapItem | undefined {
  return gap.items.find((item) => item.condition === condition);
}

function isMissing(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  const item = itemFor(gap, condition);
  return item?.outcome === "missing" && item.optional !== true;
}

function isRejected(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  return itemFor(gap, condition)?.outcome === "rejected";
}

function isSatisfied(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  return itemFor(gap, condition)?.outcome === "satisfied";
}

function resolutionGapsOpen(gap: EvidenceGap): boolean {
  return (
    isMissing(gap, "resolution_candidate") ||
    isMissing(gap, "resolution_merged") ||
    isMissing(gap, "resolution_code_evidence") ||
    isMissing(gap, "resolution_effect")
  );
}

export function requiredGapsSatisfied(gap: EvidenceGap): boolean {
  return unresolvedRequiredGaps(gap).length === 0;
}

/**
 * Negative evidence that is already enough to stop investigation.
 * Further GitHub fetches cannot turn this into verified_complete.
 *
 * `issue_closed` rejected is not terminal. An open issue only proves the
 * issue is not currently closed; it does not prove “unresolved” and must
 * not empty the legal investigation set. IndependentCompletionVerifier
 * still uses `issue_closed` as a completion condition.
 */
export function hasTerminalNegativeEvidence(gap: EvidenceGap): boolean {
  return isRejected(gap, "eligible_closure") || isRejected(gap, "issue_identity");
}

function allowsRecheckTarget(state: InvestigationState): boolean {
  return state.investigationStrategy?.type === "recheck_target";
}

export function actionCanAdvanceGap(
  action: ClosureAction,
  gap: EvidenceGap,
  state: InvestigationState,
): boolean {
  if (hasTerminalNegativeEvidence(gap) && !allowsRecheckTarget(state)) {
    return false;
  }
  if (requiredGapsSatisfied(gap)) {
    return false;
  }
  if (action.tool === "record_claim") {
    return isMissing(gap, "claim_support") && !resolutionGapsOpen(gap);
  }
  return action.targetRequirementIds.some((id) =>
    gap.items.some((item) => item.requirementId === id && !item.optional && item.outcome !== "satisfied"),
  );
}

/**
 * Remaining gap cannot be closed by another GitHub observation of the
 * same kinds. Semantic resolution_effect is the canonical case: a landed
 * path already exists, and more copies of get_pr/files/commits cannot
 * prove descriptive alignment.
 */
export function isUnresolvableOpenGap(gap: EvidenceGap): boolean {
  return isMissing(gap, "resolution_effect") && isSatisfied(gap, "resolution_merged");
}

function withOptionalClaim<T extends ClosureAction>(advancing: T[], proposed: T[]): T[] {
  const claim = proposed.find((item) => item.tool === "record_claim");
  if (!claim || advancing.some((item) => item.tool === "record_claim")) {
    return advancing;
  }
  return [...advancing, claim];
}

export function decideInvestigationClosure<T extends ClosureAction>(input: {
  gap: EvidenceGap;
  legalActions: T[];
  state: InvestigationState;
}): InvestigationClosureDecision<T> {
  const { gap, state } = input;

  if (hasTerminalNegativeEvidence(gap) && !allowsRecheckTarget(state)) {
    return {
      status: "GAP_CLOSED",
      legalActions: [],
      reason: GAP_CLOSED_REASON,
    };
  }

  if (requiredGapsSatisfied(gap)) {
    return {
      status: "GAP_CLOSED",
      legalActions: [],
      reason: GAP_CLOSED_REASON,
    };
  }

  const advancing = input.legalActions.filter((item) => actionCanAdvanceGap(item, gap, state));
  if (advancing.length > 0) {
    return {
      status: "GAP_OPEN_ACTIONABLE",
      legalActions: withOptionalClaim(advancing, input.legalActions),
      reason: "Required evidence gap remains and at least one legal action can still advance it.",
    };
  }

  if (isUnresolvableOpenGap(gap)) {
    return {
      status: "GAP_OPEN_UNRESOLVABLE",
      legalActions: [],
      reason: GAP_OPEN_UNRESOLVABLE_REASON,
    };
  }

  return {
    status: "NO_LEGAL_ACTION",
    legalActions: [],
    reason: NO_LEGAL_INVESTIGATION_ACTION,
  };
}
