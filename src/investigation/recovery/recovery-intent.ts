/**
 * Recovery Intent domain model.
 *
 * Describes the capability that is missing after Failure Localization.
 * Does not name a tool, API, or execution.
 */
import type {
  RecoveryIntentConstraints,
  RecoveryIntentObjective,
  RecoveryIntentPriority,
} from "./recovery-types.js";
import { RESOLUTION_GAP_TYPE_ORDER } from "./recovery-types.js";

export const RECOVERY_INTENT_NOTICE =
  "Recovery Intent names the missing capability. It is not a tool call and is not recovery execution.";

export interface RecoveryIntent {
  id: string;
  objective: RecoveryIntentObjective;
  triggerGapTypes: string[];
  priority: RecoveryIntentPriority;
  constraints: RecoveryIntentConstraints;
}

export function recoveryIntentId(objective: RecoveryIntentObjective): string {
  return `recovery-intent:${objective}`;
}

function uniqueGapTypes(types: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const type of RESOLUTION_GAP_TYPE_ORDER) {
    if (types.includes(type) && !seen.has(type)) {
      seen.add(type);
      ordered.push(type);
    }
  }
  for (const type of types) {
    if (!seen.has(type)) {
      seen.add(type);
      ordered.push(type);
    }
  }
  return ordered;
}

/**
 * Build a RecoveryIntent with only decision fields.
 * Extra input properties are discarded so tool/API/execution data cannot leak in.
 */
export function createRecoveryIntent(input: {
  objective: RecoveryIntentObjective;
  triggerGapTypes: string[];
  priority: RecoveryIntentPriority;
  constraints: RecoveryIntentConstraints;
}): RecoveryIntent {
  const constraints: RecoveryIntentConstraints = {
    maxActions: input.constraints.maxActions,
  };
  if (input.constraints.maxCost !== undefined) {
    constraints.maxCost = input.constraints.maxCost;
  }
  return {
    id: recoveryIntentId(input.objective),
    objective: input.objective,
    triggerGapTypes: uniqueGapTypes(input.triggerGapTypes),
    priority: input.priority,
    constraints,
  };
}
