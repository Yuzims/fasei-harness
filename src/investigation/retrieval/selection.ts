import { withCandidateStatus, type RetrievalCandidate } from "./candidate.js";
import { rankCandidates } from "./ranking.js";

/**
 * Investigation budget for already-discovered candidates.
 * Distinct from MAX_REPOSITORY_COMMIT_DISCOVERY (network discovery window).
 */
export const MAX_INVESTIGATED_CANDIDATES = 5;

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
 * Selected candidates become investigating; the rest are rejected.
 * Rejection here is a retrieval-lifecycle status, not a verifier verdict.
 */
export function applyCandidateSelection(
  candidates: readonly RetrievalCandidate[],
  limit = MAX_INVESTIGATED_CANDIDATES,
): RetrievalCandidate[] {
  const ranked = rankCandidates(candidates);
  const selectedIds = new Set(selectTopCandidates(ranked, limit).map((item) => item.id));
  return ranked.map((candidate) => {
    if (selectedIds.has(candidate.id)) {
      return withCandidateStatus(candidate, "investigating");
    }
    if (candidate.status === "promoted" || candidate.status === "investigating") {
      return candidate;
    }
    return withCandidateStatus(candidate, "rejected");
  });
}
