/**
 * Phase 11.0 — Recovery Intent evaluation.
 *
 * Observes Gap → Intent → Candidate Action contracts.
 * This is not a success-rate score and does not execute recovery.
 */
import type { ResolutionGap } from "../domain/index.js";
import {
  IndependentCompletionVerifier,
  deriveRecoveryIntents,
  toRecoveryActionCandidatesFromIntents,
  type InvestigationAgentReport,
  type RecoveryActionCandidate,
  type RecoveryIntent,
} from "../investigation/index.js";
import {
  RESOLUTION_GAP_FOCUS_CASES,
  evaluatePhase102FocusCases,
  type Phase102GapObservation,
} from "./resolution-gap-evaluation.js";

export const RECOVERY_INTENT_EVALUATION_VERSION = "11.0";

export const RECOVERY_INTENT_FOCUS_CASES = RESOLUTION_GAP_FOCUS_CASES;

export const RECOVERY_INTENT_EVALUATION_NOTE =
  "Phase 11.0 observes Recovery Intent contracts: deterministic Gap → Intent mapping, merge, no tool execution, and verifier invariance. Intents are not recovery execution.";

const EXECUTION_LEAK =
  /\btool call\b|\bAPI call\b|\bapi call\b|\bexecution\b|\btool_call\b|\bgithub_get_/i;

export interface Phase110IntentView {
  id: string;
  objective: RecoveryIntent["objective"];
  triggerGapTypes: string[];
  priority: RecoveryIntent["priority"];
  maxActions: number;
}

export interface Phase110CandidateView {
  action: RecoveryActionCandidate["action"];
  reason: string;
  autoExecute: false;
}

export interface Phase110IntentObservation {
  caseId: string;
  gapTypes: ResolutionGap["type"][];
  intents: Phase110IntentView[];
  objectives: RecoveryIntent["objective"][];
  candidates: Phase110CandidateView[];
  mappingHold: boolean;
  mergeHold: boolean;
  noToolExecution: boolean;
  autoExecuteFalse: boolean;
  verifierInvariant: boolean;
  notes: string[];
}

function gapFromView(view: Phase102GapObservation["gaps"][number]): ResolutionGap {
  return {
    candidateId: "primary",
    type: view.type,
    severity: view.severity,
    missingEvidenceTypes: [...view.missingEvidenceTypes],
    evidenceIds: [...view.evidenceIds],
    explanation: view.explanation,
    recommendedActions: [...view.recommendedActions],
  };
}

export function intentHasExecutionLeak(value: unknown): boolean {
  return EXECUTION_LEAK.test(JSON.stringify(value));
}

export function mappingHolds(gaps: ResolutionGap[], intents: RecoveryIntent[]): boolean {
  for (const gap of gaps) {
    const expected =
      gap.type === "missing_validation_evidence"
        ? "collect_validation_evidence"
        : gap.type === "missing_candidate"
          ? "expand_candidate_discovery"
          : gap.type === "weak_issue_change_alignment"
            ? "improve_issue_change_alignment"
            : "collect_resolution_evidence";
    if (!intents.some((intent) => intent.objective === expected && intent.triggerGapTypes.includes(gap.type))) {
      return false;
    }
  }
  return true;
}

export function mergeHolds(intents: RecoveryIntent[]): boolean {
  const objectives = intents.map((item) => item.objective);
  return objectives.length === new Set(objectives).size;
}

export function phase110VerifierInvariantHolds(report: InvestigationAgentReport, intents: RecoveryIntent[]): boolean {
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task: report.task, run: report.run });
  toRecoveryActionCandidatesFromIntents(intents);
  const after = verifier.verify({ task: report.task, run: report.run });
  if (before.status !== after.status) {
    return false;
  }
  const fingerprint = (result: { checks: Array<{ id: string; status: string }> }) =>
    result.checks.map((item) => `${item.id}:${item.status}`).join("|");
  return fingerprint(before) === fingerprint(after);
}

export function observeRecoveryIntents(
  gaps: ResolutionGap[],
  caseId = "synthetic",
  verifierInvariant = true,
): Phase110IntentObservation {
  const intents = deriveRecoveryIntents(gaps);
  const candidates = toRecoveryActionCandidatesFromIntents(intents);
  const notes: string[] = [];
  const noToolExecution = !intentHasExecutionLeak(intents) && !intentHasExecutionLeak(candidates);
  const autoExecuteFalse = candidates.every((item) => item.autoExecute === false);
  if (!noToolExecution) {
    notes.push("Intent or candidate leaked tool/API/execution wording.");
  }
  if (!autoExecuteFalse) {
    notes.push("A candidate was marked autoExecute.");
  }
  return {
    caseId,
    gapTypes: gaps.map((item) => item.type),
    intents: intents.map((intent) => ({
      id: intent.id,
      objective: intent.objective,
      triggerGapTypes: [...intent.triggerGapTypes],
      priority: intent.priority,
      maxActions: intent.constraints.maxActions,
    })),
    objectives: intents.map((item) => item.objective),
    candidates: candidates.map((item) => ({
      action: item.action,
      reason: item.reason,
      autoExecute: item.autoExecute,
    })),
    mappingHold: mappingHolds(gaps, intents),
    mergeHold: mergeHolds(intents),
    noToolExecution,
    autoExecuteFalse,
    verifierInvariant,
    notes,
  };
}

export function observeRecoveryIntentsFromGapObservation(
  observation: Phase102GapObservation,
): Phase110IntentObservation {
  return observeRecoveryIntents(
    observation.gaps.map(gapFromView),
    observation.caseId,
    observation.verifierInvariant,
  );
}

export async function evaluatePhase110FocusCases(
  caseIds: readonly string[] = RECOVERY_INTENT_FOCUS_CASES,
): Promise<Phase110IntentObservation[]> {
  const gapObservations = await evaluatePhase102FocusCases(caseIds);
  return gapObservations.map(observeRecoveryIntentsFromGapObservation);
}
