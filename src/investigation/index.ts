export { InvestigationAgent, investigate } from "./investigation-agent.js";
export type { InvestigateInput, InvestigateOptions } from "./investigation-agent.js";
export {
  INVESTIGATION_SYSTEM_PROMPT,
  UNTRUSTED_NOTICE,
  FINALIZATION_INSTRUCTION,
  READ_ONLY_INVESTIGATION_TOOLS,
  FORBIDDEN_WRITE_TOOLS,
} from "./policy.js";
export { InvestigationState, formatStateForModel, remainingEvidenceSources, investigationFingerprint } from "./state.js";
export { FailureAnalyzer } from "./failure-analyzer.js";
export { RecoveryPlanner } from "./recovery-planner.js";
export {
  applyRecoveryPlan,
  defaultInvestigationStrategy,
  strategyFromRecoveryPlan,
} from "./apply-recovery.js";
export {
  computeEvidenceGap,
  unresolvedRequiredGaps,
  missingRequiredGaps,
} from "./evidence-gap.js";
export type { EvidenceGap, EvidenceGapItem } from "./evidence-gap.js";
export {
  decideInvestigationClosure,
  hasTerminalNegativeEvidence,
  requiredGapsSatisfied,
  GAP_CLOSED_REASON,
  GAP_OPEN_UNRESOLVABLE_REASON,
  FINALIZATION_BUDGET_REASON,
} from "./investigation-closure.js";
export type { InvestigationClosureStatus, InvestigationClosureDecision } from "./investigation-closure.js";
export {
  proposeCandidateActions,
  planInvestigationStrategy,
  matchLegalAction,
  isLegalInvestigationAction,
  ILLEGAL_INVESTIGATION_ACTION,
  NO_LEGAL_INVESTIGATION_ACTION,
} from "./candidate-actions.js";
export type { CandidateInvestigationAction } from "./candidate-actions.js";
export {
  attemptProvenance,
  attemptToolNames,
  canonicalRecoveryTrace,
  CLOSED_LOOP_TRACE_TYPES,
} from "./recovery-trace.js";
export type { CanonicalRecoveryEvent, ClosedLoopTraceType } from "./recovery-trace.js";
export type { AnalysisContext } from "./analysis-context.js";
export {
  deriveInvestigationStatus,
  toAgentReport,
  buildInvestigationReport,
  countTraceToolCalls,
} from "./investigation-report.js";
export type {
  InvestigationActor,
  InvestigationAgentReport,
  InvestigationAgentStatus,
  InvestigationStep,
} from "./investigation-report.js";
export {
  SnapshotInvestigationDriver,
  nextInvestigationAction,
  TEST_DRIVER_NOTICE,
} from "./test-driver.js";
export {
  asClaimInput,
  asClaimInputs,
  captureAgentClaims,
  claimFingerprint,
  record_claim,
} from "./claim-capture.js";
export type { ClaimCaptureSession, ClaimCaptureSource, RecordClaimResult } from "./claim-capture.js";
export type { ClaimInput } from "../core/types.js";
export {
  createInvestigationToolList,
  createRecordResolutionAnalysisTool,
  ingestObservation,
} from "./investigation-tools.js";
export type { InvestigationSession, RetrievalCandidateSelection } from "./investigation-tools.js";
export {
  compactInvestigationToolOutput,
  compactRecordClaimOutput,
  compactRecordResolutionAnalysisOutput,
  exposeCompactPatch,
} from "./tool-result-context.js";
export type { CompactInvestigationToolInput, CompactPatchExposure } from "./tool-result-context.js";
export {
  INSUFFICIENT_CODE_CHANGE_CONTEXT,
  TEST_SUPPORT_NOT_OBSERVED,
  attachClaimsToResolutionAnalyses,
  buildResolutionAnalyses,
  buildResolutionAnalysisForCandidate,
  existingEvidenceIds,
  fileChangeFromEvidence,
  hasBoundedPatch,
  isTestFilePath,
  recordAuthoredResolutionAnalysis,
  upsertResolutionAnalysis,
} from "./resolution-analysis.js";
export {
  RESOLUTION_ANALYZER_NOTICE,
  ResolutionAnalyzer,
  analyzeResolutionSignals,
  attachResolutionSignals,
  filesForCandidate,
} from "./resolution-analyzer.js";
export { buildResolutionChain, buildResolutionChains } from "./resolution-chain.js";
export {
  RESOLUTION_GAP_ANALYZER_NOTICE,
  analyzeResolutionGaps,
  analyzeResolutionGapsForRun,
} from "./resolution-gap-analyzer.js";
export {
  RESOLUTION_GAP_RECOVERY_AUTO_EXECUTE,
  toRecoveryActionCandidates,
} from "./resolution-gap-recovery.js";
export type { ResolutionGapRecoveryCandidate } from "./resolution-gap-recovery.js";
export {
  DEFAULT_INTENT_CONSTRAINTS,
  DEFAULT_RECOVERY_ACTION_PROFILES,
  DEFAULT_RECOVERY_BUDGET,
  RECOVERY_EXECUTOR_NOTICE,
  RECOVERY_INTENT_AUTO_EXECUTE,
  RECOVERY_INTENT_NOTICE,
  RECOVERY_INTENT_OBJECTIVES,
  RECOVERY_POLICY_EVENT_TYPE,
  RECOVERY_POLICY_NOTICE,
  RESOLUTION_GAP_OBJECTIVE_MAPPING,
  RESOLUTION_GAP_TYPE_ORDER,
  blockingRecoveryIntents,
  blockingResolutionGaps,
  canExecuteRecoveryAction,
  canStartRecoveryRound,
  coveredGapTypes,
  createRecoveryActionProfile,
  createRecoveryAttempt,
  createRecoveryBudget,
  createRecoveryBudgetUsage,
  createRecoveryDecision,
  createRecoveryExecutor,
  createRecoveryIntent,
  createRecoveryPolicyInput,
  decideRecoveryPolicy,
  deriveRecoveryIntents,
  evaluateRecoveryEligibility,
  orderedInputGapTypes,
  recordRecoveryAttemptStarted,
  recordRecoveryExecutionCompleted,
  recordRecoveryIntentDecisions,
  recordRecoveryPolicyDecision,
  recoveryAttemptId,
  recoveryIntentId,
  remainingPolicyBudget,
  remainingRecoveryActions,
  resolutionGapId,
  selectRecoveryActionCandidates,
  selectedEstimatedCost,
  toRecoveryActionCandidatesFromIntents,
  toRecoveryIntentEvents,
  toRecoveryPolicyDecisionEvent,
  warningResolutionGaps,
} from "./recovery/index.js";
export type {
  RecoveryActionCandidate,
  RecoveryActionProfile,
  RecoveryAttempt,
  RecoveryAttemptOutcome,
  RecoveryAttemptStatus,
  RecoveryBudget,
  RecoveryBudgetUsage,
  RecoveryCandidateAction,
  RecoveryDecision,
  RecoveryEligibility,
  RecoveryEligibilityInput,
  RecoveryEligibilityReason,
  RecoveryExecutionResult,
  RecoveryExecutor,
  RecoveryIntent,
  RecoveryIntentConstraints,
  RecoveryIntentEvent,
  RecoveryIntentObjective,
  RecoveryIntentPriority,
  RecoveryPolicyDecisionEvent,
  RecoveryPolicyInput,
  RecoveryPolicyRejectCause,
} from "./recovery/index.js";
export {
  CONTROLLED_RECOVERY_NOTICE,
  analyzeGapsForRecovery,
  runControlledRecoveryLoop,
} from "./controlled-recovery-loop.js";
export type {
  ControlledRecoveryLoopInput,
  ControlledRecoveryLoopResult,
  ControlledRecoverySkipReason,
} from "./controlled-recovery-loop.js";
export {
  MAX_INVESTIGATED_CANDIDATES,
  NO_CANDIDATE_FOUND,
  RETRIEVAL_TOP_K,
  applyCandidateSelection,
  applyMetadataEnrichedSelection,
  calculateIssueReferenceStrength,
  calculateMergeStateSignal,
  calculateMessageOrTitleAlignment,
  calculatePathOverlapScore,
  calculateResolutionKeywordSignal,
  calculateStructuralChangeSignal,
  candidateMetadataFromSnapshot,
  candidateSelectionResult,
  createRetrievalCandidate,
  discoverCommitCandidates,
  discoverPullCandidates,
  discoveryOutcome,
  enrichCandidateWithMetadata,
  enrichCandidatesWithMetadata,
  existingRankingScore,
  extractMetadataSignals,
  investigatedCandidatesFromEvents,
  investigationCandidatesOf,
  lexicalOverlapScore,
  metadataScore,
  promotedCandidatesOf,
  rankCandidates,
  rankingScore,
  retrievalIntentsForGap,
  retrievalTopKOf,
  selectTopCandidates,
  temporalProximityScore,
  withCandidateStatus,
} from "./retrieval/index.js";
export type {
  CandidateMetadata,
  CandidateMetadataCatalog,
  RetrievalCandidate,
  RetrievalCandidateSelectionResult,
  RetrievalCandidateSourceType,
  RetrievalCandidateStatus,
  RetrievalIntent,
  IssueRetrievalContext,
} from "./retrieval/index.js";
export { IndependentCompletionVerifier, verifyInvestigationCompletion } from "../verification/independent-completion-verifier.js";
export type { IndependentVerifyInput } from "../verification/independent-completion-verifier.js";
