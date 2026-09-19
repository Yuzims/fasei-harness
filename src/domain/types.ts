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
  | "supports"
  | "contradicts"
  | "derived_from"
  | "references"
  | "fixes"
  | "merges"
  | "reviews"
  | "parents"
  | "mentions";

export type ClaimPolarity = "resolved" | "unresolved" | "partial" | "unknown";

export type ClaimEvidenceRole = "supports" | "contradicts" | "contextual";

export type ClaimSupportStatus = "supported" | "unsupported" | "contradicted";

/**
 * How an EvidenceRequirement is judged against the investigation graph.
 * Not a generic rules engine — the GitHub issue-resolution chain.
 */
export type EvidenceRequirementCondition =
  | "has_kind"
  | "issue_identity"
  | "issue_closed"
  | "eligible_closure"
  | "resolution_candidate"
  | "resolution_merged"
  | "resolution_code_evidence"
  | "resolution_effect"
  | "claim_support";

/** 外部抓取一律 untrusted；Harness 自己算出来的汇总可以标 derived。 */
export type EvidenceTrust = "external_untrusted" | "harness_derived";

export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

export type VerificationStatus = "verified_complete" | "not_verified" | "insufficient_evidence";

export type CheckType =
  | "identity"
  | "issue_state"
  | "closure_semantics"
  | "pr_existence"
  | "pr_merge"
  | "commit_existence"
  | "resolution_effect"
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
  | "runtime_budget_exceeded"
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

/**
 * How the next Investigation Attempt will proceed.
 * Distinct from RecoveryAction ("what recovery decided").
 */
export type InvestigationStrategyType =
  | "observe_issue"
  | "retry_failed_tool"
  | "gather_resolution_evidence"
  | "continue_investigation"
  | "change_retrieval"
  | "replan"
  | "recheck_target"
  | "revalidate_evidence";

export interface InvestigationStrategy {
  type: InvestigationStrategyType;
  reason: string;
  recoveryPlanId?: string;
  scope?: string[];
}

export type InvestigationAttemptStatus =
  | "incomplete"
  | "failed"
  | "verified"
  | "stopped"
  | "recovery_exhausted";

export type InvestigationRunStatus =
  | "in_progress"
  | "verified_complete"
  | "not_verified"
  | "insufficient_evidence"
  | "stopped"
  | "recovery_exhausted";

export interface EvidenceRequirement {
  id: string;
  kind: EvidenceKind;
  severity: RequirementSeverity;
  description: string;
  /** Optional evidence IDs associated with this requirement. Never overrides `condition`. */
  satisfiedBy?: string[];
  /**
   * Explicit optional flag. If omitted, `severity === "optional"` is treated as optional.
   * Optional gaps do not block completion; required/critical gaps do.
   */
  optional?: boolean;
  /** Alternate kinds that can satisfy this requirement (e.g. commit | file | code). */
  acceptedKinds?: EvidenceKind[];
  /** What the verifier must establish. Default: presence of an accepted kind. */
  condition?: EvidenceRequirementCondition;
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

/**
 * Agent-side investigation artifact. Hypothesis about whether observed
 * code changes may address the issue. Never a completion verdict.
 */
export interface ResolutionAnalysis {
  id: string;
  candidateEvidenceId: string;
  issueEvidenceId: string;
  mergeCommitSha?: string;
  codeRelevance: string;
  behavioralAlignment: string;
  testSupport: string;
  unresolvedQuestions: string[];
  supportingEvidenceIds: string[];
  claimIds: string[];
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
  id?: string;
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
  id?: string;
  /** FailureEvent that produced this plan. */
  failureEventId?: string;
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
  id: string;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  parentAttemptId?: string;
  recoveryPlanId?: string;
  failureEventId?: string;
  strategy?: InvestigationStrategy;
  status?: InvestigationAttemptStatus;
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
  /** Runtime investigation artifact. Not a snapshot field and not a verifier input. */
  resolutionAnalyses: ResolutionAnalysis[];
}
