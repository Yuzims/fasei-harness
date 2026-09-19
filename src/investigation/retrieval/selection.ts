import { withCandidateStatus, type RetrievalCandidate } from "./candidate.js";
import {
  enrichCandidatesWithMetadata,
  type CandidateMetadataCatalog,
} from "./metadata-signals.js";
import { rankCandidates, type IssueRetrievalContext } from "./ranking.js";

/**
 * Investigation budget for already-discovered candidates, applied per source type.
 * Distinct from MAX_REPOSITORY_COMMIT_DISCOVERY (network discovery window).
 * Distinct from RETRIEVAL_TOP_K (combined Recall@K / Precision@K list).
 */
export const MAX_INVESTIGATED_CANDIDATES = 5;

/**
 * Combined retrieval Top-K used for Recall@K / Precision@K.
 * Independent of MAX_INVESTIGATED_CANDIDATES. Membership here is not
 * promotion and does not by itself mean the candidate was investigated.
 */
export const RETRIEVAL_TOP_K = 5;

export interface RetrievalCandidateSelectionResult {
  selected: RetrievalCandidate[];
}

export function candidateSelectionResult(
  candidates: readonly RetrievalCandidate[],
): RetrievalCandidateSelectionResult {
  return {
    selected: investigationCandidatesOf(candidates),
  };
}

/** Candidates admitted into the per-source-type investigation budget. */
export function investigationCandidatesOf(
  candidates: readonly RetrievalCandidate[],
): RetrievalCandidate[] {
  return candidates.filter(
    (item) => item.status === "investigating" || item.status === "promoted",
  );
}

/**
 * Explicit retrieval Top-K for Recall@K / Precision@K.
 * Current policy: first K of the combined investigation-admitted list,
 * in runtime order. This can be smaller than the per-type budget total.
 * Evaluation must not re-rank to derive this list.
 */
export function retrievalTopKOf(
  candidates: readonly RetrievalCandidate[],
  k = RETRIEVAL_TOP_K,
): RetrievalCandidate[] {
  return investigationCandidatesOf(candidates).slice(0, Math.max(0, k));
}

export function promotedCandidatesOf(
  candidates: readonly RetrievalCandidate[],
): RetrievalCandidate[] {
  return candidates.filter((item) => item.status === "promoted");
}

export function investigatedCandidatesFromEvents(
  candidates: readonly RetrievalCandidate[],
  events: readonly { type: string; data?: Record<string, unknown> }[],
): RetrievalCandidate[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "retrieval_investigation_started") {
      continue;
    }
    const candidateId = event.data?.candidateId;
    const sourceType = event.data?.sourceType;
    const sourceId = event.data?.sourceId;
    if (typeof candidateId === "string" && candidateId) {
      ids.add(candidateId);
    } else if (typeof sourceType === "string" && typeof sourceId === "string" && sourceId) {
      ids.add(`retrieval:${sourceType}:${sourceId}`);
    }
  }
  return candidates.filter((item) => ids.has(item.id));
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
 * Apply the per-source-type investigation budget.
 *
 * Re-ranks the full current group every time. Promoted candidates stay
 * promoted and consume investigation budget. Remaining slots go to the
 * current ranked prefix of not-yet-promoted candidates. Previous
 * investigating status cannot keep a candidate in budget if it is no
 * longer inside this group's budget.
 *
 * This is investigation admission, not combined retrieval Top-K.
 * rejected means "not in the current per-type budget". It is not a
 * verifier verdict and is not a promotion decision.
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

export interface MetadataEnrichedSelectionInput {
  catalog: CandidateMetadataCatalog;
  context: Pick<IssueRetrievalContext, "issueNumber" | "issueTitle" | "issueBody">;
  limit?: number;
}

/**
 * Existing ranking plus metadata signals. Same investigation budget.
 * Missing metadata never removes a candidate.
 */
export function applyMetadataEnrichedSelection(
  candidates: readonly RetrievalCandidate[],
  input: MetadataEnrichedSelectionInput,
): RetrievalCandidate[] {
  const enriched = enrichCandidatesWithMetadata(candidates, input.catalog, input.context);
  return applyCandidateSelection(enriched, input.limit ?? MAX_INVESTIGATED_CANDIDATES);
}
