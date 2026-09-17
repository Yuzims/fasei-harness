export type {
  CheckStatus,
  CheckType,
  Claim,
  ClaimEvidence,
  ClaimEvidenceRole,
  ClaimPolarity,
  Evidence,
  EvidenceKind,
  EvidenceProvenance,
  EvidenceRelation,
  EvidenceRelationType,
  EvidenceRequirement,
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
