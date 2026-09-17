/**
 * Investigation domain.
 * 不依赖 React、Hono、GitHub SDK、某个 LLM Provider。
 * Agent 的结论只是待验证对象；完成与否由 VerificationResult 决定。
 */

export interface InvestigationTarget {
  owner: string;
  repository: string;
  issueNumber: number;
  url?: string;
}

export type InvestigationQuestion = "is_resolved" | "how_resolved" | "is_resolved_and_how";

export type RequirementSeverity = "critical" | "required" | "optional";

export type EvidenceKind =
  | "issue"
  | "comment"
  | "timeline"
  | "pull_request"
  | "review"
  | "file"
  | "commit"
  | "code"
  | "release"
  | "doc"
  | "other";

export type EvidenceRelationType =
  | "references"
  | "fixes"
  | "merges"
  | "reviews"
  | "parents"
  | "mentions"
  | "contradicts";

export type ClaimPolarity = "resolved" | "unresolved" | "partial" | "unknown";

export type ClaimEvidenceRole = "supports" | "contradicts" | "contextual";

/** 外部抓取一律 untrusted；Harness 自己算出来的汇总可以标 derived。 */
export type EvidenceTrust = "external_untrusted" | "harness_derived";

export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

export type VerificationStatus = "verified_complete" | "not_verified" | "insufficient_evidence";

export type CheckType =
  | "identity"
  | "issue_state"
  | "pr_existence"
  | "pr_merge"
  | "commit_existence"
  | "evidence_existence"
  | "claim_coverage"
  | "other";

export type FailureType =
  | "tool_failure"
  | "retrieval_failure"
  | "premature_completion"
  | "loop_failure"
  | "insufficient_evidence"
  | "invalid_evidence"
  | "wrong_target"
  | "unknown";

export type RecoveryAction =
  | "retry_with_backoff"
  | "refine_query"
  | "change_retrieval_strategy"
  | "continue_investigation"
  | "stop"
  | "replan"
  | "gather_missing_evidence"
  | "revalidate_evidence"
  | "recheck_target";

export type InvestigationRunStatus =
  | "in_progress"
  | "verified_complete"
  | "not_verified"
  | "insufficient_evidence"
  | "stopped";

export interface EvidenceRequirement {
  id: string;
  kind: EvidenceKind;
  severity: RequirementSeverity;
  description: string;
  satisfiedBy?: string[];
}

export interface InvestigationTask {
  id: string;
  target: InvestigationTarget;
  question: InvestigationQuestion;
  description: string;
  requirements: EvidenceRequirement[];
}

export interface EvidenceProvenance {
  source: string;
  /** Provider operation that produced this observation, e.g. getPullRequest. */
  operation?: string;
  /** Resource locator inside the repository, e.g. pull/7. */
  resource?: string;
  url?: string;
  repository?: string;
  retrievedAt: string;
  rawHash?: string;
  trust: EvidenceTrust;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  provenance: EvidenceProvenance;
  summary: string;
  contentRef?: string;
  /** Normalized Provider payload. GitHub bodies inside are untrusted. */
  payload?: unknown;
}

export interface EvidenceRelation {
  id: string;
  fromEvidenceId: string;
  toEvidenceId: string;
  type: EvidenceRelationType;
}

export interface Claim {
  id: string;
  text: string;
  polarity: ClaimPolarity;
  critical: boolean;
}

export interface ClaimEvidence {
  claimId: string;
  evidenceId: string;
  role: ClaimEvidenceRole;
}

export interface VerificationCheck {
  id: string;
  name: string;
  type: CheckType;
  status: CheckStatus;
  severity: RequirementSeverity | "info";
  message: string;
  evidenceIds: string[];
  expected?: unknown;
  actual?: unknown;
}

export interface VerificationResult {
  status: VerificationStatus;
  checks: VerificationCheck[];
  evidenceCoverage: number;
  unsupportedClaimIds: string[];
  missingRequirementIds: string[];
  prematureCompletion: boolean;
}

export interface FailureEvent {
  type: FailureType;
  reason: string;
  evidenceIds: string[];
  missingRequirementIds?: string[];
  confidence: number;
  /** Structured tool / HTTP metadata; not parsed from error.message. */
  tool?: string;
  errorCode?: string;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface RecoveryPlan {
  action: RecoveryAction;
  reason: string;
  resetEvidence?: boolean;
  nextRequirementIds?: string[];
  /** What the next investigation attempt should focus on. Not a full tool script. */
  nextStep?: string;
  maxRetries?: number;
  backoffMs?: number;
  discardEvidenceIds?: string[];
  retrievalStrategy?: string;
}

export interface InvestigationReport {
  conclusion: string;
  polarity: ClaimPolarity;
  resolutionMethod?: string;
  evidenceChain: string[];
  claimIds: string[];
  uncertainty: string;
  openQuestions: string[];
}

export interface InvestigationAttempt {
  attempt: number;
  startedAt: string;
  endedAt?: string;
  agentConclusion?: string;
  report?: InvestigationReport;
  evidenceIds: string[];
  claimIds: string[];
  verification?: VerificationResult;
  failure?: FailureEvent;
  recovery?: RecoveryPlan;
}

export interface InvestigationRun {
  id: string;
  taskId: string;
  status: InvestigationRunStatus;
  startedAt: string;
  endedAt?: string;
  attempts: InvestigationAttempt[];
  evidence: Evidence[];
  relations: EvidenceRelation[];
  claims: Claim[];
  claimEvidence: ClaimEvidence[];
}
