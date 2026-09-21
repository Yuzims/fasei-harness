/**
 * Deterministic ResolutionGap → RecoveryIntent mapping.
 *
 * Same gap types merge into one intent. LLM does not decide the mapping.
 * This module does not execute recovery.
 */
import type { ResolutionGap, ResolutionGapType } from "../../domain/index.js";
import { createRecoveryIntent, type RecoveryIntent } from "./recovery-intent.js";
import {
  RECOVERY_INTENT_OBJECTIVES,
  type RecoveryIntentConstraints,
  type RecoveryIntentObjective,
  type RecoveryIntentPriority,
} from "./recovery-types.js";

export const RESOLUTION_GAP_OBJECTIVE_MAPPING: Record<ResolutionGapType, RecoveryIntentObjective> = {
  missing_patch_evidence: "collect_resolution_evidence",
  missing_file_evidence: "collect_resolution_evidence",
  insufficient_resolution_context: "collect_resolution_evidence",
  missing_validation_evidence: "collect_validation_evidence",
  missing_candidate: "expand_candidate_discovery",
  weak_issue_change_alignment: "improve_issue_change_alignment",
};

export const DEFAULT_INTENT_CONSTRAINTS: Record<RecoveryIntentObjective, RecoveryIntentConstraints> = {
  collect_resolution_evidence: { maxActions: 2 },
  collect_validation_evidence: { maxActions: 1 },
  expand_candidate_discovery: { maxActions: 1 },
  improve_issue_change_alignment: { maxActions: 2 },
};

function objectiveForGap(type: ResolutionGap["type"]): RecoveryIntentObjective {
  return RESOLUTION_GAP_OBJECTIVE_MAPPING[type];
}

function mergedPriority(gaps: ResolutionGap[]): RecoveryIntentPriority {
  return gaps.some((item) => item.severity === "blocking") ? "blocking" : "warning";
}

/**
 * Map resolution gaps onto recovery intents.
 * Duplicate gap types do not duplicate intents. Multiple gap types that
 * share an objective merge into one intent and keep triggerGapTypes.
 */
export function deriveRecoveryIntents(resolutionGaps: ResolutionGap[]): RecoveryIntent[] {
  const grouped = new Map<RecoveryIntentObjective, ResolutionGap[]>();
  for (const gap of resolutionGaps) {
    const objective = objectiveForGap(gap.type);
    const bucket = grouped.get(objective);
    if (bucket) {
      bucket.push(gap);
    } else {
      grouped.set(objective, [gap]);
    }
  }

  const intents: RecoveryIntent[] = [];
  for (const objective of RECOVERY_INTENT_OBJECTIVES) {
    const gaps = grouped.get(objective);
    if (!gaps || gaps.length === 0) {
      continue;
    }
    intents.push(
      createRecoveryIntent({
        objective,
        triggerGapTypes: gaps.map((item) => item.type),
        priority: mergedPriority(gaps),
        constraints: { ...DEFAULT_INTENT_CONSTRAINTS[objective] },
      }),
    );
  }
  return intents;
}
