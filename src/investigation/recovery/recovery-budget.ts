/**
 * Recovery Budget. Enforced at the Runtime layer.
 *
 * This phase tests controlled recovery, not unlimited autonomous search.
 * Agent code cannot raise these caps.
 */
export interface RecoveryBudget {
  maxRecoveryRounds: number;
  maxAdditionalActions: number;
  maxAdditionalToolCalls: number;
}

export interface RecoveryBudgetUsage {
  rounds: number;
  actions: number;
  toolCalls: number;
}

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxRecoveryRounds: 1,
  maxAdditionalActions: 2,
  maxAdditionalToolCalls: 4,
};

export function createRecoveryBudget(partial?: Partial<RecoveryBudget>): RecoveryBudget {
  return {
    maxRecoveryRounds: partial?.maxRecoveryRounds ?? DEFAULT_RECOVERY_BUDGET.maxRecoveryRounds,
    maxAdditionalActions: partial?.maxAdditionalActions ?? DEFAULT_RECOVERY_BUDGET.maxAdditionalActions,
    maxAdditionalToolCalls: partial?.maxAdditionalToolCalls ?? DEFAULT_RECOVERY_BUDGET.maxAdditionalToolCalls,
  };
}

export function createRecoveryBudgetUsage(): RecoveryBudgetUsage {
  return { rounds: 0, actions: 0, toolCalls: 0 };
}

export function canStartRecoveryRound(budget: RecoveryBudget, usage: RecoveryBudgetUsage): boolean {
  if (budget.maxRecoveryRounds <= 0) {
    return false;
  }
  if (budget.maxAdditionalActions <= 0) {
    return false;
  }
  if (budget.maxAdditionalToolCalls <= 0) {
    return false;
  }
  return usage.rounds < budget.maxRecoveryRounds;
}

export function canExecuteRecoveryAction(budget: RecoveryBudget, usage: RecoveryBudgetUsage): boolean {
  return (
    canStartRecoveryRound(budget, usage) &&
    usage.actions < budget.maxAdditionalActions &&
    usage.toolCalls < budget.maxAdditionalToolCalls
  );
}

export function remainingRecoveryActions(budget: RecoveryBudget, usage: RecoveryBudgetUsage): number {
  if (!canStartRecoveryRound(budget, usage)) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(budget.maxAdditionalActions - usage.actions, budget.maxAdditionalToolCalls - usage.toolCalls),
  );
}
