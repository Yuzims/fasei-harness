export { InvestigationAgent, investigate } from "./investigation-agent.js";
export type { InvestigateInput, InvestigateOptions } from "./investigation-agent.js";
export {
  INVESTIGATION_SYSTEM_PROMPT,
  UNTRUSTED_NOTICE,
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
export { createInvestigationToolList, ingestObservation } from "./investigation-tools.js";
export type { InvestigationSession } from "./investigation-tools.js";
export {
  compactInvestigationToolOutput,
  compactRecordClaimOutput,
} from "./tool-result-context.js";
export { IndependentCompletionVerifier, verifyInvestigationCompletion } from "../verification/independent-completion-verifier.js";
export type { IndependentVerifyInput } from "../verification/independent-completion-verifier.js";
