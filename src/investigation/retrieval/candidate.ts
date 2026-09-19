/**
 * Retrieval candidates are investigation targets, not evidence.
 *
 * Candidate relevance ≠ Evidence sufficiency ≠ Verification truth.
 */

export type RetrievalCandidateSourceType = "pull_request" | "commit";

export type RetrievalCandidateStatus = "candidate" | "investigating" | "rejected" | "promoted";

export interface RetrievalRelevanceSignals {
  issueReference?: boolean;
  lexicalScore?: number;
  temporalScore?: number;
  structuralScore?: number;
}

export interface RetrievalCandidate {
  id: string;
  sourceType: RetrievalCandidateSourceType;
  sourceId: string;
  relevanceSignals: RetrievalRelevanceSignals;
  retrievalReason: string;
  status: RetrievalCandidateStatus;
}

export function retrievalCandidateId(
  sourceType: RetrievalCandidateSourceType,
  sourceId: string,
): string {
  return `retrieval:${sourceType}:${sourceId}`;
}

export function createRetrievalCandidate(input: {
  sourceType: RetrievalCandidateSourceType;
  sourceId: string;
  relevanceSignals?: RetrievalRelevanceSignals;
  retrievalReason: string;
  status?: RetrievalCandidateStatus;
}): RetrievalCandidate {
  const sourceId = input.sourceId.trim();
  if (!sourceId) {
    throw new Error("RetrievalCandidate.sourceId is required");
  }
  return {
    id: retrievalCandidateId(input.sourceType, sourceId),
    sourceType: input.sourceType,
    sourceId,
    relevanceSignals: { ...input.relevanceSignals },
    retrievalReason: input.retrievalReason.trim() || "Discovered as a retrieval candidate.",
    status: input.status ?? "candidate",
  };
}

export function withCandidateStatus(
  candidate: RetrievalCandidate,
  status: RetrievalCandidateStatus,
): RetrievalCandidate {
  return { ...candidate, status, relevanceSignals: { ...candidate.relevanceSignals } };
}
