/**
 * Candidate investigation actions derived from the current Evidence Gap.
 * Harness enumerates legal tools; the LLM selects among them.
 */
import type { EvidenceKind } from "../domain/index.js";
import type { ToolCall } from "../core/types.js";
import {
  computeEvidenceGap,
  missingRequiredGaps,
  unresolvedRequiredGaps,
  type EvidenceGap,
  type EvidenceGapItem,
} from "./evidence-gap.js";
import {
  decideInvestigationClosure,
  GAP_CLOSED_REASON,
  GAP_OPEN_UNRESOLVABLE_REASON,
  hasTerminalNegativeEvidence,
  isUnresolvableOpenGap,
  NO_LEGAL_INVESTIGATION_ACTION,
  type InvestigationClosureStatus,
} from "./investigation-closure.js";
import {
  resourceKeyForTool,
  toolSignature,
  type InvestigationState,
} from "./state.js";

export { NO_LEGAL_INVESTIGATION_ACTION };

export interface CandidateInvestigationAction {
  tool: string;
  arguments: Record<string, unknown>;
  targetRequirementIds: string[];
  objective: string;
  expectedEvidenceKind?: EvidenceKind;
  resourceKey?: string;
  exploratory?: boolean;
}

export interface ProposeCandidateActionsOptions {
  remainingLlmCalls?: number;
  gap?: EvidenceGap;
}

export const ILLEGAL_INVESTIGATION_ACTION =
  "Tool is not in the current legal investigation actions.";

function expectedEvidenceKind(tool: string): EvidenceKind | undefined {
  switch (tool) {
    case "github_get_issue":
      return "issue";
    case "github_get_issue_comments":
      return "comment";
    case "github_get_issue_timeline":
      return "timeline";
    case "github_get_pull_request":
      return "pull_request";
    case "github_get_pull_request_reviews":
      return "review";
    case "github_get_pull_request_files":
      return "file";
    case "github_list_commits":
      return "commit";
    case "github_get_commit":
      return "commit";
    default:
      return undefined;
  }
}

function targetArgs(state: InvestigationState): {
  owner: string;
  repo: string;
  issueNumber: number;
} {
  return {
    owner: state.task.target.owner,
    repo: state.task.target.repository,
    issueNumber: state.task.target.issueNumber,
  };
}

function action(input: {
  tool: string;
  arguments: Record<string, unknown>;
  targetRequirementIds: string[];
  objective: string;
  exploratory?: boolean;
}): CandidateInvestigationAction {
  return {
    tool: input.tool,
    arguments: input.arguments,
    targetRequirementIds: [...new Set(input.targetRequirementIds)],
    objective: input.objective,
    expectedEvidenceKind: expectedEvidenceKind(input.tool),
    resourceKey: resourceKeyForTool(input.tool, input.arguments),
    exploratory: input.exploratory === true,
  };
}

function identityOf(item: CandidateInvestigationAction): string {
  return `${item.tool}:${item.resourceKey ?? ""}`;
}

function idsFor(gap: EvidenceGap, conditions: EvidenceGapItem["condition"][]): string[] {
  return gap.items
    .filter((item) => conditions.includes(item.condition))
    .map((item) => item.requirementId);
}

function itemFor(
  gap: EvidenceGap,
  condition: EvidenceGapItem["condition"],
): EvidenceGapItem | undefined {
  return gap.items.find((item) => item.condition === condition);
}

function isMissing(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  const item = itemFor(gap, condition);
  return item?.outcome === "missing" && item.optional !== true;
}

function isRejected(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  return itemFor(gap, condition)?.outcome === "rejected";
}

function isSatisfied(gap: EvidenceGap, condition: EvidenceGapItem["condition"]): boolean {
  return itemFor(gap, condition)?.outcome === "satisfied";
}

function resourceAvailable(state: InvestigationState, key: string | undefined): boolean {
  if (!key) {
    return true;
  }
  if (state.refetchResources.has(key)) {
    return true;
  }
  return !state.investigatedResources.has(key);
}

function addIfAvailable(
  state: InvestigationState,
  list: CandidateInvestigationAction[],
  next: CandidateInvestigationAction,
): void {
  if (!resourceAvailable(state, next.resourceKey)) {
    return;
  }
  if (list.some((item) => identityOf(item) === identityOf(next))) {
    return;
  }
  list.push(next);
}

function resolutionGapsOpen(gap: EvidenceGap): boolean {
  return (
    isMissing(gap, "resolution_candidate") ||
    isMissing(gap, "resolution_merged") ||
    isMissing(gap, "resolution_code_evidence") ||
    isMissing(gap, "resolution_effect")
  );
}

function recoveryTargetIds(state: InvestigationState): string[] {
  const ids = state.lastRecovery?.nextRequirementIds ?? [];
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function focusRequirementIds(state: InvestigationState): string[] {
  return recoveryTargetIds(state);
}

function matchGapItem(gap: EvidenceGap, id: string): EvidenceGapItem | undefined {
  return gap.items.find((item) => item.requirementId === id || item.condition === id);
}

function activeRecoveryRequirements(state: InvestigationState, gap: EvidenceGap): EvidenceGapItem[] {
  const seen = new Set<string>();
  const active: EvidenceGapItem[] = [];
  for (const id of recoveryTargetIds(state)) {
    const item = matchGapItem(gap, id);
    if (!item || seen.has(item.requirementId) || item.outcome === "satisfied") {
      continue;
    }
    seen.add(item.requirementId);
    active.push(item);
  }
  return active;
}

function actionAdvancesRecoveryTarget(
  action: CandidateInvestigationAction,
  gap: EvidenceGap,
  target: EvidenceGapItem,
): boolean {
  if (target.condition === "resolution_effect" && isUnresolvableOpenGap(gap)) {
    return false;
  }
  if (action.targetRequirementIds.includes(target.requirementId)) {
    return true;
  }
  const targetIndex = gap.items.findIndex((item) => item.requirementId === target.requirementId);
  if (targetIndex <= 0) {
    return false;
  }
  return action.targetRequirementIds.some((id) => {
    const item = gap.items.find((entry) => entry.requirementId === id);
    if (!item || item.optional || item.outcome === "satisfied") {
      return false;
    }
    const itemIndex = gap.items.findIndex((entry) => entry.requirementId === item.requirementId);
    return itemIndex >= 0 && itemIndex < targetIndex;
  });
}

function filterActionsForRecoveryTargets(
  actions: CandidateInvestigationAction[],
  gap: EvidenceGap,
  active: EvidenceGapItem[],
): CandidateInvestigationAction[] {
  if (active.length === 0) {
    return actions;
  }
  return actions.filter((action) =>
    active.some((target) => actionAdvancesRecoveryTarget(action, gap, target)),
  );
}

function retryFailedToolAction(
  state: InvestigationState,
  gap: EvidenceGap,
): CandidateInvestigationAction | undefined {
  if (state.investigationStrategy?.type !== "retry_failed_tool") {
    return undefined;
  }
  const tool = state.lastFailure?.tool;
  if (!tool) {
    return undefined;
  }
  const last = [...state.toolHistory].reverse().find((item) => item.tool === tool && !item.success);
  if (!last) {
    return undefined;
  }
  const resolved = state.toolHistory.some(
    (item) =>
      item.success &&
      item.tool === last.tool &&
      JSON.stringify(item.arguments) === JSON.stringify(last.arguments),
  );
  if (resolved) {
    return undefined;
  }
  const targetIds =
    focusRequirementIds(state).length > 0
      ? focusRequirementIds(state)
      : unresolvedRequiredGaps(gap).map((item) => item.requirementId);
  return action({
    tool: last.tool,
    arguments: last.arguments,
    targetRequirementIds: targetIds,
    objective: `Retry the failed ${last.tool} observation after recovery.`,
  });
}

function collectIssueActions(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
): void {
  if (isRejected(gap, "issue_identity") && state.investigationStrategy?.type !== "recheck_target") {
    return;
  }
  if (
    !isMissing(gap, "issue_identity") &&
    !isMissing(gap, "issue_closed") &&
    !isMissing(gap, "eligible_closure")
  ) {
    return;
  }
  addIfAvailable(
    state,
    list,
    action({
      tool: "github_get_issue",
      arguments: targetArgs(state),
      targetRequirementIds: idsFor(gap, ["issue_identity", "issue_closed", "eligible_closure"]),
      objective: "Observe the target issue so identity and closure can be established.",
    }),
  );
}

function collectDiscoveryActions(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
): void {
  if (hasTerminalNegativeEvidence(gap)) {
    return;
  }
  if (!isMissing(gap, "resolution_candidate")) {
    return;
  }
  const target = targetArgs(state);
  const ids = idsFor(gap, ["resolution_candidate"]);
  addIfAvailable(
    state,
    list,
    action({
      tool: "github_get_issue_timeline",
      arguments: target,
      targetRequirementIds: ids,
      objective: "Discover a resolution candidate from the issue timeline.",
      exploratory: true,
    }),
  );
  addIfAvailable(
    state,
    list,
    action({
      tool: "github_get_issue_comments",
      arguments: target,
      targetRequirementIds: ids,
      objective: "Discover a resolution candidate from issue comments.",
      exploratory: true,
    }),
  );
  addRepositoryCommitDiscovery(state, gap, list, {
    targetRequirementIds: ids,
    objective: "Discover a closing-keyword commit when no pull request number is known.",
  });
  collectSelectedCommitInvestigations(state, gap, list, ids);
}

function collectPullActions(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
): void {
  if (hasTerminalNegativeEvidence(gap)) {
    return;
  }
  if (isSatisfied(gap, "resolution_merged")) {
    return;
  }
  const target = targetArgs(state);
  const ids = idsFor(gap, ["resolution_candidate", "resolution_merged"]);
  for (const pullNumber of selectedPullNumbers(state)) {
    addIfAvailable(
      state,
      list,
      action({
        tool: "github_get_pull_request",
        arguments: { owner: target.owner, repo: target.repo, pullNumber },
        targetRequirementIds: ids,
        objective: `Inspect pull request #${pullNumber} as a resolution candidate.`,
      }),
    );
  }
}

function collectCodeActions(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
): void {
  if (hasTerminalNegativeEvidence(gap)) {
    return;
  }
  const codeMissing = isMissing(gap, "resolution_code_evidence");
  const effectMissing = isMissing(gap, "resolution_effect");
  if (!codeMissing && !effectMissing) {
    return;
  }
  const target = targetArgs(state);
  const ids = idsFor(
    gap,
    effectMissing && codeMissing
      ? ["resolution_code_evidence", "resolution_effect"]
      : effectMissing
        ? ["resolution_effect"]
        : ["resolution_code_evidence"],
  );
  const pulls = [...state.mergedPrs];
  for (const pullNumber of pulls) {
    addIfAvailable(
      state,
      list,
      action({
        tool: "github_get_pull_request_files",
        arguments: { owner: target.owner, repo: target.repo, pullNumber },
        targetRequirementIds: ids,
        objective: `Inspect files on PR #${pullNumber} for resolution code evidence.`,
      }),
    );
    addIfAvailable(
      state,
      list,
      action({
        tool: "github_list_commits",
        arguments: { owner: target.owner, repo: target.repo, pullNumber },
        targetRequirementIds: ids,
        objective: `Inspect commits on PR #${pullNumber} for resolution code evidence.`,
      }),
    );
  }
  if (pulls.length === 0 && (codeMissing || isMissing(gap, "resolution_candidate"))) {
    addRepositoryCommitDiscovery(state, gap, list, {
      targetRequirementIds: idsFor(gap, ["resolution_candidate", "resolution_code_evidence"]),
      objective: "Inspect repository commits for a direct-commit resolution.",
    });
    collectSelectedCommitInvestigations(
      state,
      gap,
      list,
      idsFor(gap, ["resolution_candidate", "resolution_code_evidence"]),
    );
  }
}

function selectedPullNumbers(state: InvestigationState): number[] {
  const selected = state
    .selectedRetrievalCandidates("pull_request")
    .map((item) => Number(item.sourceId))
    .filter((number) => Number.isInteger(number) && number > 0);
  if (selected.length > 0) {
    return [...new Set(selected)];
  }
  return [...state.candidatePrs];
}

function collectSelectedCommitInvestigations(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
  targetRequirementIds: string[],
): void {
  if (hasTerminalNegativeEvidence(gap)) {
    return;
  }
  const target = targetArgs(state);
  for (const candidate of state.selectedRetrievalCandidates("commit")) {
    if (candidate.status === "promoted") {
      continue;
    }
    addIfAvailable(
      state,
      list,
      action({
        tool: "github_get_commit",
        arguments: { owner: target.owner, repo: target.repo, sha: candidate.sourceId },
        targetRequirementIds,
        objective: `Investigate commit candidate ${candidate.sourceId.slice(0, 12)}.`,
      }),
    );
  }
}

function addRepositoryCommitDiscovery(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
  input: { targetRequirementIds: string[]; objective: string },
): void {
  if (hasTerminalNegativeEvidence(gap)) {
    return;
  }
  const target = targetArgs(state);
  addIfAvailable(
    state,
    list,
    action({
      tool: "github_list_commits",
      arguments: { owner: target.owner, repo: target.repo },
      targetRequirementIds: input.targetRequirementIds,
      objective: input.objective,
      exploratory: true,
    }),
  );
}

function collectClaimAction(
  state: InvestigationState,
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
  remainingLlmCalls: number | undefined,
): void {
  if (hasTerminalNegativeEvidence(gap) && state.investigationStrategy?.type !== "recheck_target") {
    return;
  }
  const claimGap = itemFor(gap, "claim_support");
  if (claimGap?.outcome === "rejected") {
    return;
  }
  if (state.claimsRecorded && claimGap?.outcome === "satisfied") {
    return;
  }
  const githubRemains = list.some((item) => item.tool.startsWith("github_"));
  const tightBudget = remainingLlmCalls !== undefined && remainingLlmCalls <= 2;
  if (tightBudget && githubRemains && resolutionGapsOpen(gap)) {
    return;
  }
  list.push(
    action({
      tool: "record_claim",
      arguments: {},
      targetRequirementIds: idsFor(gap, ["claim_support"]),
      objective: resolutionGapsOpen(gap)
        ? "Record a structured claim. This does not verify completion and cannot close a resolution evidence gap."
        : "Record structured claims linked to the observed resolution evidence.",
    }),
  );
}

function excludeRepeatedLoopActions(
  state: InvestigationState,
  list: CandidateInvestigationAction[],
): CandidateInvestigationAction[] {
  if (state.investigationStrategy?.type !== "replan" && state.lastFailure?.type !== "loop_failure") {
    return list;
  }
  const recent = new Set(state.toolHistory.slice(-6).map((entry) => toolSignature(entry)));
  return list.filter((item) => {
    if (item.tool === "record_claim") {
      return true;
    }
    return !recent.has(toolSignature({ tool: item.tool, arguments: item.arguments }));
  });
}

function hasNonExploratory(list: CandidateInvestigationAction[]): boolean {
  return list.some((item) => item.exploratory !== true && item.tool !== "record_claim");
}

function applyBudgetFilter(
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
  remainingLlmCalls: number | undefined,
): CandidateInvestigationAction[] {
  if (remainingLlmCalls === undefined || remainingLlmCalls > 2) {
    return list;
  }
  const missing = missingRequiredGaps(gap);
  const firstMissing = missing[0];
  const focused = list.filter((item) => {
    if (item.tool === "record_claim") {
      return !list.some((other) => other.tool.startsWith("github_"));
    }
    if (item.tool === "github_get_issue" && isSatisfied(gap, "issue_identity")) {
      return false;
    }
    if (firstMissing && item.targetRequirementIds.includes(firstMissing.requirementId)) {
      return true;
    }
    return item.targetRequirementIds.some((id) =>
      missing.some((gapItem) => gapItem.requirementId === id),
    );
  });
  if (hasNonExploratory(focused)) {
    return focused.filter((item) => item.exploratory !== true);
  }
  if (remainingLlmCalls <= 1) {
    const first = focused.find((item) => item.tool.startsWith("github_")) ?? focused[0];
    return first ? [first] : focused;
  }
  return focused;
}

function rankForFocus(
  state: InvestigationState,
  list: CandidateInvestigationAction[],
): CandidateInvestigationAction[] {
  const focus = new Set(focusRequirementIds(state));
  if (focus.size === 0) {
    return list;
  }
  return [...list].sort((a, b) => {
    const aHit = a.targetRequirementIds.some((id) => focus.has(id)) ? 0 : 1;
    const bHit = b.targetRequirementIds.some((id) => focus.has(id)) ? 0 : 1;
    if (aHit !== bHit) {
      return aHit - bHit;
    }
    return 0;
  });
}

function dropSatisfiedIssueRepeats(
  gap: EvidenceGap,
  list: CandidateInvestigationAction[],
): CandidateInvestigationAction[] {
  return list.filter((item) => {
    if (item.tool !== "github_get_issue") {
      return true;
    }
    return (
      isMissing(gap, "issue_identity") ||
      isMissing(gap, "issue_closed") ||
      isMissing(gap, "eligible_closure")
    );
  });
}

export function proposeCandidateActions(
  state: InvestigationState,
  options: ProposeCandidateActionsOptions = {},
): CandidateInvestigationAction[] {
  const gap = options.gap ?? computeEvidenceGap(state.task, state.run);
  const remainingLlmCalls = options.remainingLlmCalls;
  const list: CandidateInvestigationAction[] = [];

  const retry = retryFailedToolAction(state, gap);
  if (retry) {
    addIfAvailable(state, list, retry);
  }

  collectIssueActions(state, gap, list);
  collectDiscoveryActions(state, gap, list);
  collectPullActions(state, gap, list);
  collectCodeActions(state, gap, list);
  collectClaimAction(state, gap, list, remainingLlmCalls);

  let next = dropSatisfiedIssueRepeats(gap, list);
  next = excludeRepeatedLoopActions(state, next);
  next = applyBudgetFilter(gap, next, remainingLlmCalls);
  return rankForFocus(state, next);
}

export function matchLegalAction(
  call: Pick<ToolCall, "name" | "arguments">,
  legal: CandidateInvestigationAction[],
): CandidateInvestigationAction | undefined {
  const callKey = resourceKeyForTool(call.name, call.arguments);
  return legal.find((item) => {
    if (item.tool !== call.name) {
      return false;
    }
    if (item.tool === "record_claim") {
      return true;
    }
    if (item.resourceKey || callKey) {
      return item.resourceKey === callKey;
    }
    return true;
  });
}

export function isLegalInvestigationAction(
  call: Pick<ToolCall, "name" | "arguments">,
  legal: CandidateInvestigationAction[] | undefined,
): boolean {
  if (legal === undefined) {
    return true;
  }
  return Boolean(matchLegalAction(call, legal));
}

export function legalActionViews(legal: CandidateInvestigationAction[]): Array<{
  tool: string;
  objective: string;
  targetRequirementIds: string[];
  expectedEvidenceKind?: EvidenceKind;
  resourceKey?: string;
  arguments: Record<string, unknown>;
}> {
  return legal.map((item) => ({
    tool: item.tool,
    objective: item.objective,
    targetRequirementIds: item.targetRequirementIds,
    expectedEvidenceKind: item.expectedEvidenceKind,
    resourceKey: item.resourceKey,
    arguments: item.arguments,
  }));
}

export function planInvestigationStrategy(
  state: InvestigationState,
  options: ProposeCandidateActionsOptions = {},
): {
  gap: EvidenceGap;
  legalActions: CandidateInvestigationAction[];
  remainingLlmCalls?: number;
  closure: InvestigationClosureStatus;
  closureReason: string;
} {
  const gap = options.gap ?? computeEvidenceGap(state.task, state.run);
  const proposed = proposeCandidateActions(state, { ...options, gap });
  const specified = recoveryTargetIds(state).length > 0;
  const active = activeRecoveryRequirements(state, gap);

  if (specified && active.length === 0 && !hasTerminalNegativeEvidence(gap)) {
    return {
      gap,
      legalActions: [],
      remainingLlmCalls: options.remainingLlmCalls,
      closure: "GAP_CLOSED",
      closureReason: GAP_CLOSED_REASON,
    };
  }

  const filtered = specified
    ? filterActionsForRecoveryTargets(proposed, gap, active)
    : proposed;
  const decided = decideInvestigationClosure({ gap, legalActions: filtered, state });
  if (specified && active.length > 0 && decided.status === "NO_LEGAL_ACTION") {
    return {
      gap,
      legalActions: [],
      remainingLlmCalls: options.remainingLlmCalls,
      closure: "GAP_OPEN_UNRESOLVABLE",
      closureReason: GAP_OPEN_UNRESOLVABLE_REASON,
    };
  }
  return {
    gap,
    legalActions: decided.legalActions,
    remainingLlmCalls: options.remainingLlmCalls,
    closure: decided.status,
    closureReason: decided.reason,
  };
}
