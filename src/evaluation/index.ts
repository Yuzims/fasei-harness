export {
  STRATEGY_EVALUATION_BASELINE_NOTE,
  STRATEGY_EVALUATION_VERSION,
  REAL_CASE_IDS,
  classifyExecutedAction,
  compareStrategyEvaluation,
  createStrategyEvaluationModel,
  differenceOf,
  exactActionSignature,
  evaluateAllSyntheticCases,
  evaluateRealV1Case,
  evaluateRealV1Cases,
  evaluateSyntheticCase,
  normalizedArgumentSignature,
  runStrategyEvaluation,
  seedClosedIssue,
  seedFileAndCommit,
  seedMergedPr,
  syntheticStrategyCases,
} from "./strategy-evaluation.js";
export type {
  StrategyComparison,
  StrategyEvaluationCaseConfig,
  StrategyEvaluationFailureMode,
  StrategyEvaluationMetrics,
  StrategyEvaluationMode,
  StrategyEvaluationRun,
  StrategyMetricDifference,
} from "./strategy-evaluation.js";
export {
  RESOLUTION_ANALYSIS_EVALUATION_BASELINE_NOTE,
  RESOLUTION_ANALYSIS_EVALUATION_VERSION,
  RESOLUTION_ANALYSIS_GROUNDING_LIMITATION,
  RESOLUTION_ANALYSIS_INJECTION_MARKERS,
  RESOLUTION_ANALYSIS_REAL_CASE_IDS,
  compareResolutionAnalysisEvaluation,
  createPatchedSnapshotProvider,
  differenceOfResolutionAnalysis,
  evaluateAllSyntheticResolutionCases,
  evaluateRealV1ResolutionCase,
  evaluateRealV1ResolutionCases,
  evaluateSyntheticResolutionCase,
  runResolutionAnalysisEvaluation,
  syntheticResolutionAnalysisCases,
  verifierInvariantHolds,
} from "./resolution-analysis-evaluation.js";
export type {
  ResolutionAnalysisCaseConfig,
  ResolutionAnalysisComparison,
  ResolutionAnalysisEvaluationMetrics,
  ResolutionAnalysisEvaluationMode,
  ResolutionAnalysisEvaluationRun,
  ResolutionAnalysisFailureClass,
  ResolutionAnalysisMetricDifference,
} from "./resolution-analysis-evaluation.js";
export {
  analysisCorpus,
  collectBoundedPatches,
  evaluateResolutionAnalysisGrounding,
} from "./resolution-analysis-grounding.js";
export type {
  BoundedPatchView,
  ResolutionAnalysisGrounding,
  ResolutionAnalysisGroundingInput,
} from "./resolution-analysis-grounding.js";
export { RETRIEVAL_TOP_K } from "../investigation/index.js";
export {
  RETRIEVAL_EVALUATION_BASELINE_NOTE,
  RETRIEVAL_EVALUATION_REAL_CASE_IDS,
  RETRIEVAL_EVALUATION_VERSION,
  RETRIEVAL_METADATA_ENRICHED_NOTE,
  REAL_V1_RETRIEVAL_GROUND_TRUTH,
  aggregateRetrievalCases,
  applyDiscoveryOrderSelection,
  buildRetrievalEvaluationReport,
  compareRetrievalEvaluation,
  evaluateAllSyntheticRetrievalCases,
  evaluateRealV1RetrievalCase,
  evaluateRealV1RetrievalCases,
  evaluateRetrievalCandidates,
  evaluateSyntheticRetrievalCase,
  metadataSelectionOptions,
  realV1RetrievalReports,
  runRetrievalEvaluation,
  selectorForStrategy,
  syntheticRetrievalCases,
} from "./retrieval-evaluation.js";
export type {
  RetrievalEvaluationAggregate,
  RetrievalEvaluationCase,
  RetrievalEvaluationCaseConfig,
  RetrievalEvaluationComparison,
  RetrievalEvaluationReport,
  RetrievalEvaluationRun,
  RetrievalEvaluationStrategy,
  RetrievalGroundTruth,
} from "./retrieval-evaluation.js";
export {
  candidateIdsMatch,
  diagnoseRetrieval,
  discoveryFound,
  investigationCandidatesOfViews,
  investigationSucceeded,
  isRelevantCandidate,
  precisionAtK,
  promotedCandidatesOfViews,
  recallAtK,
  retrievalTopKOfViews,
  selectedTopK,
  topKFound,
} from "./retrieval-metrics.js";
export type {
  ExpectedResolutionCandidate,
  RetrievalCandidateView,
  RetrievalDiagnosis,
} from "./retrieval-metrics.js";
export {
  RESOLUTION_EFFECT_EVALUATION_NOTE,
  RESOLUTION_EFFECT_EVALUATION_VERSION,
  RESOLUTION_EFFECT_FOCUS_CASES,
  evaluatePhase10FocusCases,
  evaluatePhase10ResolutionCase,
  observeResolutionEffect,
  phase10VerifierInvariantHolds,
} from "./resolution-effect-evaluation.js";
export type { Phase10ResolutionObservation, Phase10SignalView } from "./resolution-effect-evaluation.js";
export {
  RESOLUTION_GAP_EVALUATION_NOTE,
  RESOLUTION_GAP_EVALUATION_VERSION,
  RESOLUTION_GAP_FOCUS_CASES,
  evaluatePhase102FocusCases,
  evaluatePhase102ResolutionCase,
  observeResolutionGaps,
  phase102VerifierInvariantHolds,
} from "./resolution-gap-evaluation.js";
export type { Phase102GapObservation, Phase102GapView } from "./resolution-gap-evaluation.js";
export {
  RECOVERY_INTENT_EVALUATION_NOTE,
  RECOVERY_INTENT_EVALUATION_VERSION,
  RECOVERY_INTENT_FOCUS_CASES,
  evaluatePhase110FocusCases,
  intentHasExecutionLeak,
  mappingHolds,
  mergeHolds,
  observeRecoveryIntents,
  observeRecoveryIntentsFromGapObservation,
  phase110VerifierInvariantHolds,
} from "./recovery-intent-evaluation.js";
export type {
  Phase110CandidateView,
  Phase110IntentObservation,
  Phase110IntentView,
} from "./recovery-intent-evaluation.js";
export {
  RECOVERY_LOOP_EVALUATION_NOTE,
  RECOVERY_LOOP_EVALUATION_VERSION,
  RECOVERY_LOOP_FOCUS_CASES,
  evaluatePhase111FocusCases,
  evaluatePhase111RecoveryCase,
  phase111VerifierInvariantHolds,
} from "./recovery-loop-evaluation.js";
export type { Phase111Observation } from "./recovery-loop-evaluation.js";
