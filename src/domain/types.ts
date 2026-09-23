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
  /** Agent/textual nomination of a fix; never certifies (Phase 18-B). */
  | "hypothesis_fixes"
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

export type ResolutionSignalType =
  | "file_scope_alignment"
  | "patch_intent_alignment"
  | "test_evidence";

export type ResolutionAlignmentStatus = "supported" | "partial" | "unknown";

export type TestEvidenceStatus = "present" | "absent" | "unknown";

export type ResolutionOverallStatus = "supported" | "partial" | "unknown";

export type ResolutionEvidenceRole = "issue" | "candidate" | "file_change" | "patch";

/**
 * Provenance pointer from a ResolutionSignal back to Evidence Graph nodes.
 * A signal without Evidence IDs is not a valid investigation claim.
 */
export interface EvidenceReference {
  evidenceId: string;
  role: ResolutionEvidenceRole;
  trust?: EvidenceTrust;
}

/**
 * Code-constrained investigation signal. Not a completion verdict.
 * Status is assigned by ResolutionAnalyzer, never by LLM prose.
 */
export interface ResolutionSignal {
  type: ResolutionSignalType;
  status: ResolutionAlignmentStatus | TestEvidenceStatus;
  evidenceIds: string[];
  /** Optional explanation text. Must not claim the issue is fixed. */
  explanation?: string;
}

/**
 * Agent-side investigation claim about candidate resolution evidence.
 * Hypothesis only. Never a completion verdict and never VERIFIED_COMPLETE.
 */
export interface ResolutionAnalysis {
  id: string;
  /** Same identity as candidateEvidenceId. Phase 10.0 claim field. */
  candidateId: string;
  candidateEvidenceId: string;
  issueEvidenceId: string;
  mergeCommitSha?: string;
  codeRelevance: string;
  behavioralAlignment: string;
  testSupport: string;
  unresolvedQuestions: string[];
  supportingEvidenceIds: string[];
  claimIds: string[];
  signals: ResolutionSignal[];
  overall: ResolutionOverallStatus;
  provenance: EvidenceReference[];
}

/** Phase 10.0 alias: ResolutionAnalysis is an investigation claim, not verification. */
export type ResolutionClaim = ResolutionAnalysis;

/**
 * Observation of one Resolution Chain node.
 * `unknown` means the evidence was not observed. It is not `absent` and not `unsupported`.
 */
export type ResolutionChainNodeStatus = "observed" | "unknown";

export interface ResolutionChainNode {
  status: ResolutionChainNodeStatus;
  evidenceIds: string[];
}

/**
 * Phase 10.1-shaped Resolution Explanation for one candidate.
 * Investigation structure only. Not a completion verdict.
 */
export interface ResolutionChain {
  candidateId: string;
  issue: ResolutionChainNode;
  candidate: ResolutionChainNode;
  affected_area: ResolutionChainNode;
  code_change: ResolutionChainNode;
  validation: {
    status: TestEvidenceStatus;
    evidenceIds: string[];
  };
  alignment: {
    status: ResolutionAlignmentStatus;
    evidenceIds: string[];
  };
  behaviorHypothesis: {
    present: boolean;
    evidenceIds: string[];
  };
  overall: ResolutionOverallStatus;
}

export type ResolutionGapType =
  | "missing_candidate"
  | "missing_file_evidence"
  | "missing_patch_evidence"
  | "missing_validation_evidence"
  | "weak_issue_change_alignment"
  | "insufficient_resolution_context";

export type ResolutionGapSeverity = "blocking" | "warning";

export type ResolutionGapRecommendedAction =
  | "fetch_commit_patch"
  | "inspect_changed_files"
  | "search_regression_tests"
  | "search_resolution_candidates"
  | "inspect_issue_change_alignment";

/**
 * Why the current Resolution Explanation cannot support further verification.
 * Failure Localization + Recovery Signal only. Not a verifier verdict.
 */
export interface ResolutionGap {
  candidateId: string;
  type: ResolutionGapType;
  severity: ResolutionGapSeverity;
  missingEvidenceTypes: string[];
  evidenceIds: string[];
  explanation: string;
  recommendedActions: ResolutionGapRecommendedAction[];
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

export type ResolutionPrescanSourceState = "completed" | "failed" | "skipped";

export interface ResolutionPrescanSourceRecord {
  source:
    | "rest_issue_mentions"
    | "rest_comment_mentions"
    | "rest_timeline_references"
    | "graphql_issue_linked"
    | "graphql_commit_associated_prs"
    | "graphql_closing_references"
    | "pr_detail_fetch";
  state: ResolutionPrescanSourceState;
  errorCode?: string;
  detail?: string;
}

export interface ResolutionPrescanCandidate {
  pullNumber: number;
  /** Deterministic channels that surfaced this candidate (field extraction, not text judgment). */
  enumeratedBy: string[];
  /**
   * Raw GraphQL `closingIssuesReferences` field fact: true when the PR's
   * structured closing references include the target issue. A fact, not a verdict.
   */
  structuredClosingReference?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  prCreatedAt?: string | null;
  baseRefName?: string | null;
  mergeCommitSha?: string | null;
  /** "not_a_pull_request": GraphQL authoritatively found no PR with this number. */
  detailState: ResolutionPrescanSourceState | "not_a_pull_request";
}

/** Phase 18-B hypothesis-only hint: a commit touching an investigated file. */
export interface UnlinkedFixHint {
  sha: string;
  files: string[];
}

/**
 * Phase 18-B unlinked-fix hint scan. Exhaustive only when state is
 * "completed"; hints are nominates-for-human/Agent-review and are consumed
 * by NO verifier condition. This sub-record never changes the parent
 * prescan `state` (18-A semantics stay frozen).
 */
export interface UnlinkedFixScan {
  state: "completed" | "incomplete" | "skipped";
  hints: UnlinkedFixHint[];
  filesExamined: number;
  filesTruncated: boolean;
  /** Issue createdAt — the committer-date window start. */
  windowStart?: string;
  baseRefs: string[];
  /** Honest reason when state is not "completed". */
  reason?: string;
}

/**
 * Phase 18-A machine record: did the deterministic resolution-reference
 * pre-scan actually exhaust its structured sources. 18-C turns this into
 * attributionCoverage; presence + `state` are machine-decidable.
 */
export interface ResolutionPrescanRecord {
  state: "completed" | "incomplete";
  startedAt: string;
  completedAt?: string;
  /** Prescan performs zero LLM calls by construction; recorded for honesty checks. */
  llmCalls: 0;
  /** Repository id after GitHub rename resolution (e.g. react/react for facebook/react). */
  repositoryNameWithOwner?: string;
  sources: ResolutionPrescanSourceRecord[];
  candidates: ResolutionPrescanCandidate[];
  candidatesEnumerated: number;
  candidatesTruncated: boolean;
  /** Commit SHAs observed in the issue timeline (deduped, lowercase). */
  commitCandidates: string[];
  /** Phase 18-B hypothesis-only side-scan; never feeds the verifier. */
  unlinkedFixScan?: UnlinkedFixScan;
}

/**
 * Phase 18-C attribution coverage machine record: pure field derivation over
 * the 18-A prescan record and runtime budget counters, zero LLM. Verdict
 * metadata only — no verifier condition may read it.
 */
export interface AttributionCoverage {
  /**
   * "exhausted": prescan completed and every enumerated candidate reached a
   * machine verdict. "mid_run": structured attribution is not exhausted.
   * "not_assertable": no prescan record, so nothing may be claimed.
   */
  state: "exhausted" | "mid_run" | "not_assertable";
  prescanState: "completed" | "incomplete" | "absent";
  candidatesEnumerated: number;
  /** Candidates whose facts were fully read, so field-based rules decided them. */
  candidatesAdjudicated: number;
  /** Pull numbers enumerated but not adjudicated (detail fetch failed/skipped). */
  unadjudicatedCandidates: number[];
  /** Enumerated candidates cut by the prescan cap — numbers unknown, resume input. */
  unenumeratedCandidates: number;
  /** LLM runtime budget fully consumed (calls or wall clock) — not a text judgment. */
  budgetExhausted: boolean;
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
  /** Phase 18-A prescan machine record. Absent means no prescan ran. */
  resolutionPrescan?: ResolutionPrescanRecord;
  /** Phase 18-C coverage metadata. Verifier never reads it; checks stay untouched. */
  attributionCoverage?: AttributionCoverage;
}
