export {
  createRetrievalCandidate,
  retrievalCandidateId,
  withCandidateStatus,
} from "./candidate.js";
export type {
  RetrievalCandidate,
  RetrievalCandidateSourceType,
  RetrievalCandidateStatus,
  RetrievalRelevanceSignals,
} from "./candidate.js";
export { retrievalIntentsForGap } from "./intent.js";
export type { RetrievalIntent, RetrievalIntentContext } from "./intent.js";
export {
  ISSUE_REFERENCE_POINTS,
  MAX_TEMPORAL_POINTS,
  STRUCTURAL_POINTS,
  computeRelevanceSignals,
  lexicalOverlapScore,
  mentionsIssueNumber,
  rankCandidates,
  rankingReason,
  rankingScore,
  temporalProximityScore,
  tokenize,
} from "./ranking.js";
export type { IssueRetrievalContext, RankableRecord } from "./ranking.js";
export {
  MAX_INVESTIGATED_CANDIDATES,
  applyCandidateSelection,
  candidateSelectionResult,
  selectTopCandidates,
} from "./selection.js";
export type { RetrievalCandidateSelectionResult } from "./selection.js";
export {
  NO_CANDIDATE_FOUND,
  NO_CANDIDATE_IN_WINDOW,
  discoverCommitCandidates,
  discoverPullCandidates,
  discoveryOutcome,
} from "./discovery.js";
export type { DiscoveredCommit, DiscoveredPull } from "./discovery.js";
export {
  recordCandidateDiscovered,
  recordCandidateRanked,
  recordCandidateRejected,
  recordCandidateSelected,
  recordDiscoveryStarted,
  recordInvestigationStarted,
} from "./trace.js";
export type { RetrievalTraceSink, RetrievalTraceType } from "./trace.js";
