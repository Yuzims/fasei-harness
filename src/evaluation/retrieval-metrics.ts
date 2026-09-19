/**
 * Deterministic retrieval evaluation metrics.
 *
 * Ground truth is evaluator-only. These functions never run inside
 * production ranking, discovery, or verification.
 */
import type {
  RetrievalCandidate,
  RetrievalCandidateSourceType,
  RetrievalCandidateStatus,
} from "../investigation/index.js";

export interface ExpectedResolutionCandidate {
  sourceType: RetrievalCandidateSourceType;
  sourceId: string;
}

export interface RetrievalCandidateView {
  sourceType: RetrievalCandidateSourceType;
  sourceId: string;
  status?: RetrievalCandidateStatus;
}

export type RetrievalDiagnosis =
  | "no_resolution_expected"
  | "discovery_failure"
  | "ranked_out_of_top_k"
  | "investigation_failed"
  | "evidence_insufficient"
  | "retrieval_complete";

export function candidateIdsMatch(
  actual: RetrievalCandidateView,
  expected: ExpectedResolutionCandidate,
): boolean {
  if (actual.sourceType !== expected.sourceType) {
    return false;
  }
  const left = actual.sourceId.trim().toLowerCase();
  const right = expected.sourceId.trim().toLowerCase();
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (actual.sourceType === "commit" && left.length >= 7 && right.length >= 7) {
    return left.startsWith(right) || right.startsWith(left);
  }
  return false;
}

export function isRelevantCandidate(
  candidate: RetrievalCandidateView,
  validCandidates: readonly ExpectedResolutionCandidate[],
): boolean {
  return validCandidates.some((item) => candidateIdsMatch(candidate, item));
}

export function discoveryFound(
  discovered: readonly RetrievalCandidateView[],
  validCandidates: readonly ExpectedResolutionCandidate[],
): boolean {
  return discovered.some((item) => isRelevantCandidate(item, validCandidates));
}

/**
 * Recall@K = 1 if any valid GT candidate is in the first K returned items.
 * Returns null when no resolution candidate is expected.
 */
export function recallAtK(
  topK: readonly RetrievalCandidateView[],
  validCandidates: readonly ExpectedResolutionCandidate[],
  k: number,
): number | null {
  if (validCandidates.length === 0) {
    return null;
  }
  const slice = topK.slice(0, Math.max(0, k));
  return slice.some((item) => isRelevantCandidate(item, validCandidates)) ? 1 : 0;
}

/**
 * Precision@K = relevant in the returned prefix / returned prefix length.
 * Denominator is the actual returned count, not a padded K.
 * Returns null when no resolution candidate is expected.
 */
export function precisionAtK(
  topK: readonly RetrievalCandidateView[],
  validCandidates: readonly ExpectedResolutionCandidate[],
  k: number,
): number | null {
  if (validCandidates.length === 0) {
    return null;
  }
  const slice = topK.slice(0, Math.max(0, k));
  if (slice.length === 0) {
    return 0;
  }
  const relevant = slice.filter((item) => isRelevantCandidate(item, validCandidates)).length;
  return relevant / slice.length;
}

export function topKFound(
  topK: readonly RetrievalCandidateView[],
  validCandidates: readonly ExpectedResolutionCandidate[],
  k: number,
): boolean {
  return recallAtK(topK, validCandidates, k) === 1;
}

export function investigationSucceeded(
  candidates: readonly RetrievalCandidateView[],
  validCandidates: readonly ExpectedResolutionCandidate[],
): boolean {
  return candidates.some(
    (item) => item.status === "promoted" && isRelevantCandidate(item, validCandidates),
  );
}

export function diagnoseRetrieval(input: {
  resolutionExpected: boolean;
  discoveryFound: boolean;
  topKFound: boolean;
  investigationSuccess: boolean;
  verificationInsufficient: boolean;
}): RetrievalDiagnosis {
  if (!input.resolutionExpected) {
    return "no_resolution_expected";
  }
  if (!input.discoveryFound) {
    return "discovery_failure";
  }
  if (!input.topKFound) {
    return "ranked_out_of_top_k";
  }
  if (!input.investigationSuccess) {
    return "investigation_failed";
  }
  if (input.verificationInsufficient) {
    return "evidence_insufficient";
  }
  return "retrieval_complete";
}

export function asCandidateView(
  candidate: Pick<RetrievalCandidate, "sourceType" | "sourceId" | "status">,
): RetrievalCandidateView {
  return {
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    status: candidate.status,
  };
}

export function meanDefined(values: readonly (number | null | undefined)[]): number {
  const defined = values.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (defined.length === 0) {
    return 0;
  }
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}
