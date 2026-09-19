import type { TraceEventType } from "../../trace/trace-collector.js";
import type { RetrievalCandidate } from "./candidate.js";
import { rankingReason, rankingScore } from "./ranking.js";

export type RetrievalTraceType =
  | "retrieval_discovery_started"
  | "retrieval_candidate_discovered"
  | "retrieval_candidate_ranked"
  | "retrieval_candidate_selected"
  | "retrieval_candidate_rejected"
  | "retrieval_investigation_started";

export interface RetrievalTraceSink {
  runId: string;
  state: { currentStep: number };
  trace: {
    record(runId: string, step: number, type: TraceEventType, data: Record<string, unknown>): void;
  };
}

function record(
  session: RetrievalTraceSink,
  type: RetrievalTraceType,
  data: Record<string, unknown>,
): void {
  session.trace.record(session.runId, session.state.currentStep, type, data);
}

export function recordDiscoveryStarted(
  session: RetrievalTraceSink,
  data: Record<string, unknown>,
): void {
  record(session, "retrieval_discovery_started", data);
}

export function recordCandidateDiscovered(
  session: RetrievalTraceSink,
  candidate: RetrievalCandidate,
): void {
  record(session, "retrieval_candidate_discovered", {
    candidateId: candidate.id,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    rankingSignals: candidate.relevanceSignals,
    status: candidate.status,
    retrievalReason: candidate.retrievalReason,
  });
}

export function recordCandidateRanked(
  session: RetrievalTraceSink,
  candidate: RetrievalCandidate,
  rank: number,
): void {
  record(session, "retrieval_candidate_ranked", {
    candidateId: candidate.id,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    rankingSignals: candidate.relevanceSignals,
    rankingScore: rankingScore(candidate),
    rankingReason: rankingReason(candidate),
    status: candidate.status,
    rank,
  });
}

export function recordCandidateSelected(
  session: RetrievalTraceSink,
  candidate: RetrievalCandidate,
): void {
  record(session, "retrieval_candidate_selected", {
    candidateId: candidate.id,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    rankingSignals: candidate.relevanceSignals,
    rankingReason: rankingReason(candidate),
    status: candidate.status,
  });
}

export function recordCandidateRejected(
  session: RetrievalTraceSink,
  candidate: RetrievalCandidate,
): void {
  record(session, "retrieval_candidate_rejected", {
    candidateId: candidate.id,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    rankingSignals: candidate.relevanceSignals,
    rankingReason: rankingReason(candidate),
    status: candidate.status,
  });
}

export function recordInvestigationStarted(
  session: RetrievalTraceSink,
  candidate: RetrievalCandidate,
): void {
  record(session, "retrieval_investigation_started", {
    candidateId: candidate.id,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    rankingSignals: candidate.relevanceSignals,
    status: candidate.status,
  });
}
