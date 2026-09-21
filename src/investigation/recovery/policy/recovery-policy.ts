/**
 * Deterministic Recovery Policy.
 *
 * Selects Recovery Action Candidates from Gap coverage, estimated cost,
 * and remaining budget. This module does not execute recovery, call tools,
 * create Evidence, or modify IndependentCompletionVerifier.
 */
import type { ResolutionGap } from "../../../domain/index.js";
import { RESOLUTION_GAP_TYPE_ORDER } from "../recovery-types.js";
import type { RecoveryBudget } from "../recovery-budget.js";
import type { RecoveryActionCandidate } from "../resolution-recovery-adapter.js";
import {
  RECOVERY_POLICY_NOTICE,
  type RecoveryActionProfile,
  type RecoveryDecision,
  type RecoveryPolicyInput,
  type RecoveryPolicyRejectCause,
} from "./recovery-policy-types.js";

export { RECOVERY_POLICY_NOTICE };

export const DEFAULT_RECOVERY_ACTION_PROFILES: RecoveryActionProfile[] = [
  {
    action: "fetch_commit_patch",
    estimatedCost: 1,
    resolvesGapTypes: ["missing_patch_evidence", "insufficient_resolution_context"],
  },
  {
    action: "inspect_changed_files",
    estimatedCost: 1,
    resolvesGapTypes: ["missing_file_evidence", "missing_patch_evidence", "insufficient_resolution_context"],
  },
  {
    action: "search_regression_tests",
    estimatedCost: 1,
    resolvesGapTypes: ["missing_validation_evidence"],
  },
  {
    action: "search_resolution_candidates",
    estimatedCost: 1,
    resolvesGapTypes: ["missing_candidate"],
  },
  {
    action: "inspect_issue_change_alignment",
    estimatedCost: 1,
    resolvesGapTypes: ["weak_issue_change_alignment"],
  },
];

export function createRecoveryActionProfile(input: RecoveryActionProfile): RecoveryActionProfile {
  return {
    action: input.action,
    estimatedCost: input.estimatedCost,
    resolvesGapTypes: [...input.resolvesGapTypes],
  };
}

export function createRecoveryDecision(input: RecoveryDecision): RecoveryDecision {
  return {
    selectedActions: [...input.selectedActions],
    rejectedActions: [...input.rejectedActions],
    reason: input.reason,
  };
}

export function createRecoveryPolicyInput(input: RecoveryPolicyInput): RecoveryPolicyInput {
  return {
    gaps: [...input.gaps],
    intents: [...input.intents],
    candidates: [...input.candidates],
    budget: {
      maxRecoveryRounds: input.budget.maxRecoveryRounds,
      maxAdditionalActions: input.budget.maxAdditionalActions,
      maxAdditionalToolCalls: input.budget.maxAdditionalToolCalls,
    },
    actionProfiles: input.actionProfiles.map(createRecoveryActionProfile),
  };
}

/**
 * Remaining policy budget in estimatedCost units.
 * Reads RecoveryBudget caps. Does not mutate runtime usage.
 */
export function remainingPolicyBudget(budget: RecoveryBudget): number {
  if (budget.maxRecoveryRounds <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(budget.maxAdditionalActions, budget.maxAdditionalToolCalls));
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function orderedGapTypes(gaps: ResolutionGap[]): string[] {
  const types = gaps.map((item) => item.type);
  const ordered: string[] = [];
  const seen = new Set<string>();
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

function profileFor(
  action: string,
  profiles: RecoveryActionProfile[],
): RecoveryActionProfile | undefined {
  return profiles.find((item) => item.action === action);
}

function coveringGaps(gaps: ResolutionGap[], profile: RecoveryActionProfile): ResolutionGap[] {
  return gaps.filter((gap) => profile.resolvesGapTypes.includes(gap.type));
}

interface RankedCandidate {
  action: string;
  index: number;
  cost: number;
  coverage: number;
  blockingCoverage: number;
}

function rankAgainst(
  candidate: RankedCandidate,
  gaps: ResolutionGap[],
  profile: RecoveryActionProfile,
): RankedCandidate {
  const covered = coveringGaps(gaps, profile);
  return {
    ...candidate,
    coverage: covered.length,
    blockingCoverage: covered.filter((item) => item.severity === "blocking").length,
  };
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  if (left.blockingCoverage !== right.blockingCoverage) {
    return right.blockingCoverage - left.blockingCoverage;
  }
  if (left.coverage !== right.coverage) {
    return right.coverage - left.coverage;
  }
  if (left.cost !== right.cost) {
    return left.cost - right.cost;
  }
  return left.index - right.index;
}

function formatReason(
  selected: Array<{ action: string; blockingCoverage: number; coverage: number; cost: number }>,
  rejected: Array<{ action: string; cause: RecoveryPolicyRejectCause }>,
): string {
  const selectedPart =
    selected.length === 0
      ? "Selected none."
      : `Selected ${selected
          .map(
            (item) =>
              `${item.action} (blocking=${item.blockingCoverage}, coverage=${item.coverage}, cost=${item.cost})`,
          )
          .join(", ")}.`;
  const rejectedPart =
    rejected.length === 0
      ? "Rejected none."
      : `Rejected ${rejected.map((item) => `${item.action} (${item.cause})`).join(", ")}.`;
  return `${selectedPart} ${rejectedPart}`;
}

/**
 * Choose Recovery Actions from candidates. Deterministic. No LLM / ML / RL.
 */
export function decideRecoveryPolicy(input: RecoveryPolicyInput): RecoveryDecision {
  const snapshot = createRecoveryPolicyInput(input);
  const remainingStart = remainingPolicyBudget(snapshot.budget);
  let remaining = remainingStart;
  const uncovered = [...snapshot.gaps];
  const selected: RankedCandidate[] = [];
  const rejected: Array<{ action: string; cause: RecoveryPolicyRejectCause }> = [];
  const rejectedActions = new Set<string>();
  const selectedActions = new Set<string>();

  const pending: Array<{
    candidate: RecoveryActionCandidate;
    index: number;
    profile?: RecoveryActionProfile;
  }> = snapshot.candidates.map((candidate, index) => ({
    candidate,
    index,
    profile: profileFor(candidate.action, snapshot.actionProfiles),
  }));

  for (const item of pending) {
    const action = item.candidate.action;
    if (selectedActions.has(action) || rejectedActions.has(action)) {
      continue;
    }
    if (!item.profile) {
      rejected.push({ action, cause: "no_profile" });
      rejectedActions.add(action);
      continue;
    }
    const cost = item.profile.estimatedCost;
    if (!Number.isFinite(cost) || cost > remainingStart) {
      rejected.push({ action, cause: "over_budget" });
      rejectedActions.add(action);
      continue;
    }
    const covered = coveringGaps(snapshot.gaps, item.profile);
    if (covered.length === 0) {
      rejected.push({ action, cause: "no_gap_coverage" });
      rejectedActions.add(action);
    }
  }

  while (true) {
    const ranked: RankedCandidate[] = [];
    for (const item of pending) {
      const action = item.candidate.action;
      if (selectedActions.has(action) || rejectedActions.has(action) || !item.profile) {
        continue;
      }
      const base: RankedCandidate = {
        action,
        index: item.index,
        cost: item.profile.estimatedCost,
        coverage: 0,
        blockingCoverage: 0,
      };
      const scored = rankAgainst(base, uncovered, item.profile);
      if (scored.coverage <= 0) {
        continue;
      }
      if (scored.cost > remaining) {
        continue;
      }
      ranked.push(scored);
    }
    if (ranked.length === 0) {
      break;
    }
    ranked.sort(compareRanked);
    const pick = ranked[0];
    if (!pick) {
      break;
    }
    selected.push(pick);
    selectedActions.add(pick.action);
    remaining -= pick.cost;
    const profile = profileFor(pick.action, snapshot.actionProfiles);
    if (profile) {
      const still: ResolutionGap[] = [];
      for (const gap of uncovered) {
        if (!profile.resolvesGapTypes.includes(gap.type)) {
          still.push(gap);
        }
      }
      uncovered.length = 0;
      uncovered.push(...still);
    }
  }

  for (const item of pending) {
    const action = item.candidate.action;
    if (selectedActions.has(action) || rejectedActions.has(action)) {
      continue;
    }
    const cause: RecoveryPolicyRejectCause =
      item.profile && item.profile.estimatedCost > remaining ? "over_budget" : "redundant";
    rejected.push({ action, cause });
    rejectedActions.add(action);
  }

  return createRecoveryDecision({
    selectedActions: selected.map((item) => item.action),
    rejectedActions: uniqueInOrder(snapshot.candidates.map((item) => item.action)).filter(
      (action) => rejectedActions.has(action),
    ),
    reason: formatReason(selected, rejected),
  });
}

export function selectedEstimatedCost(
  selectedActions: readonly string[],
  actionProfiles: readonly RecoveryActionProfile[],
): number {
  let total = 0;
  for (const action of selectedActions) {
    const profile = actionProfiles.find((item) => item.action === action);
    if (profile) {
      total += profile.estimatedCost;
    }
  }
  return total;
}

export function coveredGapTypes(
  selectedActions: readonly string[],
  actionProfiles: readonly RecoveryActionProfile[],
): string[] {
  const types: string[] = [];
  for (const action of selectedActions) {
    const profile = actionProfiles.find((item) => item.action === action);
    if (!profile) {
      continue;
    }
    types.push(...profile.resolvesGapTypes);
  }
  return uniqueInOrder(types);
}

export function orderedInputGapTypes(gaps: ResolutionGap[]): string[] {
  return orderedGapTypes(gaps);
}
