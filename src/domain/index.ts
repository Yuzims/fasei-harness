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
  InvestigationQuestion,
  InvestigationReport,
  InvestigationRun,
  InvestigationRunStatus,
  InvestigationTarget,
  InvestigationTask,
  RecoveryAction,
  RecoveryPlan,
  RequirementSeverity,
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
  isCodeEvidence,
  issueFact,
  pullFact,
} from "./evidence-facts.js";
export type { IssueFact, PullFact } from "./evidence-facts.js";

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
  requirementSatisfied,
  resolutionCandidateEvidence,
  targetIssueEvidence,
} from "./evidence-graph.js";
export type {
  ClaimEvidenceInput,
  EvidenceGraph,
  EvidenceGraphErrorCode,
  RelationInput,
} from "./evidence-graph.js";
