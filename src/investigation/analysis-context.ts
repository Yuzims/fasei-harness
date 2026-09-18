import type { AgentResult } from "../core/types.js";
import type {
  FailureEvent,
  InvestigationTask,
  RecoveryBounds,
  RecoveryPlan,
  VerificationResult,
} from "../domain/index.js";
import type { InvestigationState } from "./state.js";

export interface AnalysisContext {
  task: InvestigationTask;
  state: InvestigationState;
  verification: VerificationResult;
  agentResult?: AgentResult;
  attempt: number;
  previousFingerprints: string[];
  previousRecoveries: RecoveryPlan[];
  bounds: RecoveryBounds;
  /** Structured LLM runtime budget / timeout failure, if the AgentLoop was aborted. */
  runtimeFailure?: FailureEvent;
}

export function agentClaimedResolved(ctx: AnalysisContext): boolean {
  const resolvedClaim = ctx.state.run.claims.some(
    (claim) => claim.critical && claim.polarity === "resolved",
  );
  if (resolvedClaim) {
    return true;
  }
  const output = String(ctx.agentResult?.output ?? "");
  return (
    ctx.agentResult?.status === "completed" &&
    /\bresolved\b/i.test(output) &&
    !/not (?:verified|resolved)|insufficient/i.test(output)
  );
}

export function primaryFailure(events: FailureEvent[]): FailureEvent | undefined {
  return events[0];
}
