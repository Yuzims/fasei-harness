/**
 * Adapter only: RecoveryIntent → Recovery Action Candidate.
 *
 * Generates candidates. Does not execute tools, retry, or change
 * investigation state. autoExecute is always false.
 */
import type { RecoveryIntent } from "./recovery-intent.js";
import type { RecoveryCandidateAction } from "./recovery-types.js";

export const RECOVERY_INTENT_AUTO_EXECUTE = false;

export interface RecoveryActionCandidate {
  action: RecoveryCandidateAction;
  reason: string;
  intentId: string;
  /** Always false. Candidates are suggestions, not executions. */
  autoExecute: false;
}

interface CandidateSeed {
  action: RecoveryCandidateAction;
  reason: string;
  when: string[];
}

const OBJECTIVE_CANDIDATES: Record<RecoveryIntent["objective"], CandidateSeed[]> = {
  collect_resolution_evidence: [
    {
      action: "fetch_commit_patch",
      reason: "Collect missing code change evidence",
      when: ["missing_patch_evidence", "insufficient_resolution_context"],
    },
    {
      action: "inspect_changed_files",
      reason: "Collect missing file-change evidence",
      when: ["missing_file_evidence", "insufficient_resolution_context", "missing_patch_evidence"],
    },
  ],
  collect_validation_evidence: [
    {
      action: "search_regression_tests",
      reason: "Collect missing validation evidence",
      when: ["missing_validation_evidence"],
    },
  ],
  expand_candidate_discovery: [
    {
      action: "search_resolution_candidates",
      reason: "Expand resolution candidate discovery",
      when: ["missing_candidate"],
    },
  ],
  improve_issue_change_alignment: [
    {
      action: "inspect_issue_change_alignment",
      reason: "Improve issue-change alignment evidence",
      when: ["weak_issue_change_alignment"],
    },
    {
      action: "inspect_changed_files",
      reason: "Inspect changed files to improve issue-change alignment",
      when: ["weak_issue_change_alignment"],
    },
  ],
};

function matchesTrigger(seed: CandidateSeed, triggerGapTypes: string[]): boolean {
  if (triggerGapTypes.length === 0) {
    return true;
  }
  return seed.when.some((type) => triggerGapTypes.includes(type));
}

export function toRecoveryActionCandidatesFromIntents(
  intents: RecoveryIntent[],
): RecoveryActionCandidate[] {
  const candidates: RecoveryActionCandidate[] = [];
  for (const intent of intents) {
    const seeds = OBJECTIVE_CANDIDATES[intent.objective] ?? [];
    const matched = seeds.filter((seed) => matchesTrigger(seed, intent.triggerGapTypes));
    const limited = matched.slice(0, intent.constraints.maxActions);
    for (const seed of limited) {
      candidates.push({
        action: seed.action,
        reason: seed.reason,
        intentId: intent.id,
        autoExecute: RECOVERY_INTENT_AUTO_EXECUTE,
      });
    }
  }
  return candidates;
}
