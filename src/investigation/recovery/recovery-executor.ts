/**
 * Recovery Executor abstraction.
 *
 * Executes a Recovery Action Candidate. Does not judge issue resolution,
 * mutate IndependentCompletionVerifier, or emit completion.
 * Does not bind to a GitHub HTTP client.
 */
import type { RecoveryActionCandidate } from "./resolution-recovery-adapter.js";

export interface RecoveryExecutionResult {
  action: string;
  /** Newly added Evidence IDs. Not verification evidence. */
  addedEvidenceIds: string[];
  status: "completed" | "failed";
}

export interface RecoveryExecutor {
  execute(action: RecoveryActionCandidate): Promise<RecoveryExecutionResult>;
}

export const RECOVERY_EXECUTOR_NOTICE =
  "RecoveryExecutor collects Evidence only. It cannot set success, modify verifier results, or produce VERIFIED_COMPLETE.";

export function createRecoveryExecutor(
  handler: (action: RecoveryActionCandidate) => Promise<RecoveryExecutionResult> | RecoveryExecutionResult,
): RecoveryExecutor {
  return {
    async execute(action) {
      const result = await handler(action);
      return {
        action: result.action,
        addedEvidenceIds: [...result.addedEvidenceIds],
        status: result.status,
      };
    },
  };
}
