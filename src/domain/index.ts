export type {
  CheckStatus,
  CheckType,
  Claim,
  ClaimEvidence,
  ClaimEvidenceRole,
  ClaimPolarity,
  ClaimSupportStatus,
  Evidence,
  EvidenceKind,
  EvidenceProvenance,
  EvidenceRelation,
  EvidenceRelationType,
  EvidenceRequirement,
  EvidenceRequirementCondition,
  EvidenceTrust,
  FailureEvent,
  FailureType,
  InvestigationAttempt,
  InvestigationAttemptStatus,
  InvestigationQuestion,
  InvestigationReport,
  InvestigationRun,
  InvestigationRunStatus,
  InvestigationStrategy,
  InvestigationStrategyType,
  InvestigationTarget,
  InvestigationTask,
  RecoveryAction,
  RecoveryPlan,
  RequirementSeverity,
  ResolutionAnalysis,
  VerificationCheck,
  VerificationResult,
  VerificationStatus,
} from "./types.js";

export {
  appendAttempt,
  bindClaimEvidence,
  createClaim,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
  createResolutionAnalysis,
  createTarget,
  defaultResolutionRequirements,
} from "./factories.js";

export {
  buildVerificationResult,
  criticalChecksPassed,
  evidenceCoverage,
  latestAttempt,
  missingRequirements,
  supportingEvidenceIds,
  unsupportedClaims,
} from "./queries.js";

export {
  RECOVERY_BOUNDS,
  isRetryableToolCode,
  planRecovery,
  recoveryActionFor,
} from "./recovery-policy.js";
export type { RecoveryBounds } from "./recovery-policy.js";

export {
  CODE_EVIDENCE_KINDS,
  EXPLICIT_NON_RESOLUTION_REASONS,
  commitFact,
  isCodeEvidence,
  isExplicitNonResolutionReason,
  issueFact,
  pullFact,
} from "./evidence-facts.js";
export type { CommitFact, IssueFact, PullFact } from "./evidence-facts.js";

export {
  CLAIM_EVIDENCE_ROLES,
  CODE_LINK_RELATIONS,
  EVIDENCE_RELATION_TYPES,
  EvidenceGraphError,
  RESOLUTION_CANDIDATE_RELATIONS,
  claimSupportStatus,
  codeEvidenceFor,
  contradictingRelations,
  createClaimEvidenceBinding,
  createEvidenceRelation,
  graphFromRun,
  hasRelation,
  isClaimEvidenceRole,
  isEvidenceRelationType,
  isOptionalRequirement,
  issueEvidenceItems,
  mergeContradiction,
  relatedEvidence,
  requirementKinds,
  resolutionCandidateEvidence,
  targetIssueEvidence,
} from "./evidence-graph.js";
export type {
  ClaimEvidenceInput,
  EvidenceGraph,
  EvidenceGraphErrorCode,
  RelationInput,
} from "./evidence-graph.js";

export {
  evaluateEvidenceRequirement,
  isOptionalRequirementAbsent,
  requirementEvalContext,
  requirementSatisfied,
} from "./requirement-eval.js";
export type {
  RequirementEvalContext,
  RequirementEvaluation,
  RequirementOutcome,
} from "./requirement-eval.js";

export {
  RESOLUTION_PATHS,
  asResolutionCandidate,
  closingKeywordReferencesIssue,
  codeEvidenceForCandidates,
  landedResolutionCandidates,
  resolveResolutionCandidates,
} from "./resolution-path.js";
export type { ResolutionCandidate, ResolutionPathKind } from "./resolution-path.js";

export { describeResolutionAlignment, contentTokens, identifierTokens } from "./resolution-alignment.js";
export type { AlignmentOutcome } from "./resolution-alignment.js";
