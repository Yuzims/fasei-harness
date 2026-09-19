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
  existingRankingScore,
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
  MAX_ISSUE_REFERENCE_STRENGTH,
  MAX_MERGE_STATE_POINTS,
  MAX_MESSAGE_TITLE_ALIGNMENT,
  MAX_PATH_OVERLAP_POINTS,
  MAX_RESOLUTION_KEYWORD_POINTS,
  MAX_STRUCTURAL_CHANGE_POINTS,
  calculateIssueReferenceStrength,
  calculateMergeStateSignal,
  calculateMessageOrTitleAlignment,
  calculatePathOverlapScore,
  calculateResolutionKeywordSignal,
  calculateStructuralChangeSignal,
  candidateMetadataFromSnapshot,
  candidateMetadataKey,
  enrichCandidateWithMetadata,
  enrichCandidatesWithMetadata,
  extractMetadataSignals,
  lookupCandidateMetadata,
  metadataScore,
} from "./metadata-signals.js";
export type { CandidateChangedFile, CandidateMetadata, CandidateMetadataCatalog } from "./metadata-signals.js";
export {
  MAX_INVESTIGATED_CANDIDATES,
  RETRIEVAL_TOP_K,
  applyCandidateSelection,
  applyMetadataEnrichedSelection,
  candidateSelectionResult,
  investigatedCandidatesFromEvents,
  investigationCandidatesOf,
  promotedCandidatesOf,
  retrievalTopKOf,
  selectTopCandidates,
} from "./selection.js";
export type { MetadataEnrichedSelectionInput, RetrievalCandidateSelectionResult } from "./selection.js";
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
