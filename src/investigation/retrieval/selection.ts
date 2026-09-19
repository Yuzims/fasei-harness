import { withCandidateStatus, type RetrievalCandidate } from "./candidate.js";
import { rankCandidates } from "./ranking.js";

/**
 * Investigation budget for already-discovered candidates.
 * Distinct from MAX_REPOSITORY_COMMIT_DISCOVERY (network discovery window).
 */
export const MAX_INVESTIGATED_CANDIDATES = 5;

export interface RetrievalCandidateSelectionResult {
  selected: RetrievalCandidate[];
}

export function candidateSelectionResult(
  candidates: readonly RetrievalCandidate[],
): RetrievalCandidateSelectionResult {
  return {
    selected: candidates.filter(
      (item) => item.status === "investigating" || item.status === "promoted",
    ),
  };
}

export function selectTopCandidates(
  candidates: readonly RetrievalCandidate[],
  limit = MAX_INVESTIGATED_CANDIDATES,
): RetrievalCandidate[] {
  const cap = Math.max(0, limit);
  return rankCandidates(candidates)
    .slice(0, cap)
    .map((candidate) => withCandidateStatus(candidate, "investigating"));
}

/**
 * Apply Top-K selection to one source-type group.
 *
 * Re-ranks the full current group every time. Promoted candidates stay
 * promoted and consume investigation budget. Remaining slots go to the
 * current Top-K of not-yet-promoted candidates. Previous investigating
 * status cannot keep a candidate in budget if it is no longer Top-K.
 *
 * rejected means "not in the current Top-K". It is not a verifier verdict.
 */
export function applyCandidateSelection(
  candidates: readonly RetrievalCandidate[],
  limit = MAX_INVESTIGATED_CANDIDATES,
): RetrievalCandidate[] {
  const cap = Math.max(0, limit);
  const ranked = rankCandidates(candidates);
  const promotedCount = ranked.filter((item) => item.status === "promoted").length;
  const remainingCapacity = Math.max(0, cap - promotedCount);
  const investigatingIds = new Set(
    ranked
      .filter((item) => item.status !== "promoted")
      .slice(0, remainingCapacity)
      .map((item) => item.id),
  );
  return ranked.map((candidate) => {
    if (candidate.status === "promoted") {
      return withCandidateStatus(candidate, "promoted");
    }
    if (investigatingIds.has(candidate.id)) {
      return withCandidateStatus(candidate, "investigating");
    }
    return withCandidateStatus(candidate, "rejected");
  });
}
