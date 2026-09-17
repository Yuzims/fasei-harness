/**
 * Product applyRecovery. Executes a RecoveryPlan against investigation state.
 * Planner never calls this. The investigation loop does.
 *
 * This is the Investigation Recovery path, not workspace Harness.applyRecovery.
 */
import type { FailureEvent, RecoveryPlan } from "../domain/index.js";
import type { RetrievalStrategy } from "./state.js";
import { resourceKeyForTool, type InvestigationState } from "./state.js";

function isRetrievalStrategy(value: string | undefined): value is RetrievalStrategy {
  return (
    value === "default" ||
    value === "timeline" ||
    value === "comments" ||
    value === "linked_pr" ||
    value === "broaden"
  );
}

function discardEvidence(state: InvestigationState, id: string): void {
  const existing = state.run.evidence.find((item) => item.id === id);
  state.run.evidence = state.run.evidence.filter((item) => item.id !== id);
  state.run.claimEvidence = state.run.claimEvidence.filter((link) => link.evidenceId !== id);
  state.run.relations = state.run.relations.filter(
    (relation) => relation.fromEvidenceId !== id && relation.toEvidenceId !== id,
  );
  state.invalidEvidenceIds.add(id);
  if (existing?.contentRef) {
    state.investigatedResources.delete(existing.contentRef);
    state.refetchResources.add(existing.contentRef);
  }
  if (existing?.provenance.resource) {
    const key = existing.contentRef;
    if (key) {
      state.refetchResources.add(key);
    }
  }
}

function resetEvidenceGraph(state: InvestigationState): void {
  for (const item of state.run.evidence) {
    if (item.contentRef) {
      state.refetchResources.add(item.contentRef);
    }
  }
  state.run.evidence.length = 0;
  state.run.relations.length = 0;
  state.run.claims.length = 0;
  state.run.claimEvidence.length = 0;
  state.investigatedResources.clear();
  state.candidatePrs.clear();
  state.mergedPrs.clear();
  state.unmergedPrs.clear();
  state.filesByPr.clear();
  state.claimsRecorded = false;
  state.issueState = undefined;
  state.conclusion = "";
  state.polarity = "unknown";
  state.unresolvedQuestions.length = 0;
}

export function applyRecoveryPlan(
  state: InvestigationState,
  plan: RecoveryPlan,
  failure: FailureEvent,
): void {
  state.recoveryCount += 1;
  state.lastFailure = failure;
  state.lastRecovery = plan;

  if (plan.retrievalStrategy && isRetrievalStrategy(plan.retrievalStrategy)) {
    state.retrievalStrategy = plan.retrievalStrategy;
  }

  if (plan.action === "retry_with_backoff") {
    state.toolRetryCount += 1;
    if (failure.tool) {
      const last = [...state.toolHistory].reverse().find((item) => item.tool === failure.tool);
      const key = last ? resourceKeyForTool(last.tool, last.arguments) : undefined;
      if (key) {
        state.refetchResources.add(key);
        state.investigatedResources.delete(key);
      }
    }
  }

  if (plan.action === "continue_investigation" || plan.action === "gather_missing_evidence") {
    state.claimsRecorded = false;
  }

  if (plan.action === "replan") {
    state.claimsRecorded = false;
    state.retrievalStrategy = isRetrievalStrategy(plan.retrievalStrategy)
      ? plan.retrievalStrategy
      : "broaden";
  }

  if (plan.action === "revalidate_evidence") {
    for (const id of plan.discardEvidenceIds ?? failure.evidenceIds) {
      discardEvidence(state, id);
    }
    for (const item of state.run.evidence) {
      if (item.provenance.source === "github" && item.provenance.trust !== "external_untrusted") {
        item.provenance.trust = "external_untrusted";
      }
    }
  }

  if (plan.action === "recheck_target" && plan.resetEvidence) {
    resetEvidenceGraph(state);
  }
}

export async function waitBackoff(plan: RecoveryPlan, executeBackoff: boolean): Promise<void> {
  const ms = executeBackoff ? (plan.backoffMs ?? 0) : 0;
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
