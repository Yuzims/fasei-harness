/**
 * Phase 11.2 — Recovery Evaluation model.
 *
 * Evaluation reads Baseline vs Recovery results only. It does not mutate
 * InvestigationRun, Evidence, verifier status, or any runtime module.
 *
 * This layer does not prove that Recovery always improves completion rate.
 */

export const RECOVERY_EVALUATION_VERSION = "11.2";

export const RECOVERY_EVALUATION_FOCUS_CASES = ["C07", "C08", "C10"] as const;

export const RECOVERY_EVALUATION_NOTE =
  "Phase 11.2 measures whether a Controlled Recovery Loop can add Evidence and reduce observed Resolution Gaps after a Failure. It does not prove Recovery always improves completion rate, and it does not optimize for completion rate.";

/** Observation label only. Not a winner, ranking, or completion verdict. */
export type VerificationDelta = "unchanged" | "improved" | "worse";

export interface RecoveryEvaluationSnapshot {
  verifierStatus: string;
  gaps: string[];
  evidenceCount: number;
}

export interface RecoveryEvaluationExecution {
  executed: boolean;
  actions: string[];
  recoveryAttempts: number;
}

export interface RecoveryEvaluationMetrics {
  gapReduction: number;
  evidenceGain: number;
  verificationChanged: boolean;
  additionalToolCalls: number;
}

/**
 * Baseline Investigation vs Recovery Enabled Investigation.
 * Evaluation output only. Unknown gap removal is not treated as resolved.
 */
export interface RecoveryEvaluationResult {
  caseId: string;
  baseline: RecoveryEvaluationSnapshot;
  recovery: RecoveryEvaluationExecution;
  afterRecovery: RecoveryEvaluationSnapshot;
  metrics: RecoveryEvaluationMetrics;
}

/** Baseline Investigation: no Recovery Loop. */
export interface RecoveryEvaluationBaselineInput {
  caseId: string;
  verifierStatus: string;
  gaps: readonly string[];
  evidenceCount: number;
}

/**
 * Recovery Enabled Investigation: Phase 11.1 Loop result.
 * Cost fields are observed counts. Do not pass estimated tokens.
 */
export interface RecoveryEvaluationRecoveryInput {
  executed: boolean;
  actions: readonly string[];
  recoveryAttempts: number;
  verifierStatus: string;
  gaps: readonly string[];
  evidenceCount: number;
  additionalToolCalls?: number;
  additionalActions?: number;
  additionalAttempts?: number;
  /** If present, cost is read from these events instead of being re-estimated. */
  traceEvents?: ReadonlyArray<RecoveryEvaluationTraceEvent>;
}

export interface RecoveryEvaluationTraceEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface RecoveryCost {
  additionalToolCalls: number;
  additionalAttempts: number;
  additionalActions: number;
}

export interface GapTypeEffectiveness {
  cases: string[];
  avgGapReduction: number;
}

export interface RecoveryEvaluationObservation {
  caseId: string;
  evaluation: RecoveryEvaluationResult;
  verificationDelta: VerificationDelta;
  cost: RecoveryCost;
  falseCandidateCount: number;
  verifierInvariant: boolean;
  notes: string[];
}

export interface RecoveryEvaluationReport {
  cases: RecoveryEvaluationObservation[];
  byGapType: Record<string, GapTypeEffectiveness>;
}
