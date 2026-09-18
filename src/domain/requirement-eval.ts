/**
 * Canonical EvidenceRequirement evaluation.
 * Answers: does this Evidence Graph satisfy this EvidenceRequirement?
 *
 * Facts (what Evidence says) come from evidence-facts.
 * Relationships come from the Evidence Graph, not payload guessing.
 * IndependentCompletionVerifier orchestrates checks and the final verdict;
 * it must not reimplement these conditions.
 */
import {
  claimSupportStatus,
  contradictingRelations,
  isOptionalRequirement,
  issueEvidenceItems,
  mergeContradiction,
  requirementKinds,
  targetIssueEvidence,
  type EvidenceGraph,
} from "./evidence-graph.js";
import { isExplicitNonResolutionReason, issueFact } from "./evidence-facts.js";
import { describeResolutionAlignment } from "./resolution-alignment.js";
import {
  codeEvidenceForCandidates,
  landedResolutionCandidates,
  resolveResolutionCandidates,
} from "./resolution-path.js";
import type {
  Evidence,
  EvidenceRequirement,
  EvidenceRequirementCondition,
  InvestigationTask,
} from "./types.js";

export interface RequirementEvalContext {
  graph: EvidenceGraph;
  task: InvestigationTask;
}

export type RequirementOutcome = "satisfied" | "missing" | "rejected";

export interface RequirementEvaluation {
  requirementId: string;
  condition: EvidenceRequirementCondition;
  satisfied: boolean;
  outcome: RequirementOutcome;
  reason: string;
  evidenceIds: string[];
  expected?: unknown;
  actual?: unknown;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function targetRepository(task: InvestigationTask): string {
  return `${task.target.owner}/${task.target.repository}`;
}

function result(
  requirement: EvidenceRequirement,
  condition: EvidenceRequirementCondition,
  partial: Omit<RequirementEvaluation, "requirementId" | "condition" | "satisfied"> & {
    satisfied?: boolean;
  },
): RequirementEvaluation {
  const outcome = partial.outcome;
  return {
    requirementId: requirement.id,
    condition,
    satisfied: partial.satisfied ?? outcome === "satisfied",
    outcome,
    reason: partial.reason,
    evidenceIds: uniqueIds(partial.evidenceIds),
    expected: partial.expected,
    actual: partial.actual,
  };
}

function evalHasKind(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const kinds = new Set(requirementKinds(requirement));
  const found = context.graph.evidence.filter((item) => kinds.has(item.kind));
  if (found.length > 0) {
    return result(requirement, "has_kind", {
      outcome: "satisfied",
      reason: `Found ${found.length} evidence item(s) of accepted kind(s).`,
      evidenceIds: found.map((item) => item.id),
    });
  }
  return result(requirement, "has_kind", {
    outcome: "missing",
    reason: `No evidence of kind(s) ${[...kinds].join(", ")}.`,
    evidenceIds: [],
  });
}

function evalIssueIdentity(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const { graph, task } = context;
  const expected = targetRepository(task);
  const issues = issueEvidenceItems(graph);
  if (issues.length === 0) {
    return result(requirement, "issue_identity", {
      outcome: "missing",
      reason: "No issue evidence; cannot confirm owner/repository/number.",
      evidenceIds: [],
      expected: { repository: expected, issueNumber: task.target.issueNumber },
    });
  }
  const matches = targetIssueEvidence(graph, task);
  if (matches.length === 0) {
    const actual = issues.map(issueFact).find((item) => item);
    return result(requirement, "issue_identity", {
      outcome: "rejected",
      reason: `Evidence points at ${actual?.repository}#${actual?.number}, not ${expected}#${task.target.issueNumber}.`,
      evidenceIds: issues.map((item) => item.id),
      expected: { repository: expected, issueNumber: task.target.issueNumber },
      actual: { repository: actual?.repository, issueNumber: actual?.number },
    });
  }
  return result(requirement, "issue_identity", {
    outcome: "satisfied",
    reason: `Issue identity matches ${expected}#${task.target.issueNumber}.`,
    evidenceIds: matches.map((item) => item.id),
    expected: { repository: expected, issueNumber: task.target.issueNumber },
    actual: { repository: expected, issueNumber: task.target.issueNumber },
  });
}

function evalIssueClosed(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const matches = targetIssueEvidence(context.graph, context.task);
  if (matches.length === 0) {
    return result(requirement, "issue_closed", {
      outcome: "missing",
      reason: "No target issue evidence; cannot read issue state.",
      evidenceIds: [],
      expected: "closed",
    });
  }
  const facts = matches.map(issueFact).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const closed = facts.filter((item) => item.state === "closed");
  if (closed.length === 0) {
    return result(requirement, "issue_closed", {
      outcome: "rejected",
      reason: `Target issue is ${facts[0]?.state ?? "unknown"}; an open issue is not resolved.`,
      evidenceIds: matches.map((item) => item.id),
      expected: "closed",
      actual: facts[0]?.state,
    });
  }
  return result(requirement, "issue_closed", {
    outcome: "satisfied",
    reason: "Issue is closed. Closed is not equivalent to resolved.",
    evidenceIds: closed.map((item) => item.evidenceId),
    expected: "closed",
    actual: "closed",
  });
}

function evalEligibleClosure(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const matches = targetIssueEvidence(context.graph, context.task);
  if (matches.length === 0) {
    return result(requirement, "eligible_closure", {
      outcome: "missing",
      reason: "No target issue evidence; cannot read closure semantics.",
      evidenceIds: [],
    });
  }
  const facts = matches.map(issueFact).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const rejected = facts.filter((item) => isExplicitNonResolutionReason(item.stateReason));
  if (rejected.length > 0) {
    const reason = rejected[0]?.stateReason ?? "not_planned";
    return result(requirement, "eligible_closure", {
      outcome: "rejected",
      reason: `Issue closed as ${reason} is explicit non-resolution; it cannot be verified_complete.`,
      evidenceIds: matches.map((item) => item.id),
      expected: "completed resolution",
      actual: reason,
    });
  }
  return result(requirement, "eligible_closure", {
    outcome: "satisfied",
    reason: "Closure is not an explicit non-resolution (not_planned). Closed still is not resolved.",
    evidenceIds: matches.map((item) => item.id),
    actual: facts[0]?.stateReason ?? facts[0]?.state,
  });
}

function evalResolutionCandidate(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const pulls = context.graph.evidence.filter((item) => item.kind === "pull_request");
  const candidates = resolveResolutionCandidates(context.graph, context.task);
  if (candidates.length > 0) {
    const labels = candidates.map((item) =>
      item.path === "pr_merge"
        ? `PR #${item.pull?.number ?? "?"}`
        : `commit ${item.commit?.sha?.slice(0, 12) ?? item.evidence.id.slice(0, 8)}`,
    );
    return result(requirement, "resolution_candidate", {
      outcome: "satisfied",
      reason: `Resolution candidate(s): ${labels.join(", ")}.`,
      evidenceIds: candidates.map((item) => item.evidence.id),
      actual: labels,
    });
  }
  if (pulls.length > 0) {
    return result(requirement, "resolution_candidate", {
      outcome: "rejected",
      reason:
        "Pull request evidence exists but is not linked to the target issue in the Evidence Graph.",
      evidenceIds: pulls.map((item) => item.id),
    });
  }
  return result(requirement, "resolution_candidate", {
    outcome: "missing",
    reason: "No pull request or direct-commit evidence linked to the target issue.",
    evidenceIds: [],
  });
}

function evalResolutionMerged(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const candidates = resolveResolutionCandidates(context.graph, context.task);
  const pulls = candidates.filter((item) => item.path === "pr_merge").map((item) => item.evidence);
  const contradiction = mergeContradiction(context.graph, pulls);
  if (contradiction.conflict) {
    return result(requirement, "resolution_merged", {
      outcome: "rejected",
      reason: "Contradictory merge evidence for the same resolution-candidate PR.",
      evidenceIds: [...contradiction.merged, ...contradiction.unmerged].map((item) => item.id),
      expected: true,
      actual: "contradicted",
    });
  }
  const landed = landedResolutionCandidates(context.graph, context.task);
  if (landed.length > 0) {
    const labels = landed.map((item) =>
      item.path === "pr_merge"
        ? `merged PR #${item.pull?.number ?? "?"}`
        : `direct commit ${item.commit?.sha?.slice(0, 12) ?? ""}`.trim(),
    );
    return result(requirement, "resolution_merged", {
      outcome: "satisfied",
      reason: `Resolution path landed: ${labels.join(", ")}.`,
      evidenceIds: landed.map((item) => item.evidence.id),
      expected: true,
      actual: labels,
    });
  }
  if (candidates.length === 0) {
    return result(requirement, "resolution_merged", {
      outcome: "missing",
      reason: "No resolution-candidate PR or direct commit to inspect for a landed path.",
      evidenceIds: [],
      expected: true,
    });
  }
  if (contradiction.unmerged.length > 0) {
    return result(requirement, "resolution_merged", {
      outcome: "rejected",
      reason: "Candidate PR exists but merged=false (open or closed-unmerged is not completion).",
      evidenceIds: contradiction.unmerged.map((item) => item.id),
      expected: true,
      actual: false,
    });
  }
  return result(requirement, "resolution_merged", {
    outcome: "missing",
    reason: "Candidate evidence does not include a merged PR fact or a landed direct commit.",
    evidenceIds: candidates.map((item) => item.evidence.id),
    expected: true,
  });
}

function evalResolutionCodeEvidence(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const landed = landedResolutionCandidates(context.graph, context.task);
  const candidates = landed.length > 0 ? landed : resolveResolutionCandidates(context.graph, context.task);
  const found = codeEvidenceForCandidates(context.graph, candidates);
  if (found.length > 0) {
    return result(requirement, "resolution_code_evidence", {
      outcome: "satisfied",
      reason: `Found ${found.length} commit/file/code evidence item(s) linked to the landed resolution. A merged PR record is not code evidence.`,
      evidenceIds: found.map((item) => item.id),
    });
  }
  return result(requirement, "resolution_code_evidence", {
    outcome: "missing",
    reason:
      "Required commit/file/code evidence is missing from the Evidence Graph. A pull request record is not enough.",
    evidenceIds: [],
  });
}

function evalResolutionEffect(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const landed = landedResolutionCandidates(context.graph, context.task);
  if (landed.length === 0) {
    return result(requirement, "resolution_effect", {
      outcome: "missing",
      reason:
        "No landed resolution path, so resolution effect cannot be established. Close-link evidence is not effect proof.",
      evidenceIds: [],
    });
  }
  const issues = targetIssueEvidence(context.graph, context.task);
  const code = codeEvidenceForCandidates(context.graph, landed);
  const alignment = describeResolutionAlignment(issues[0], landed, code);
  if (alignment.outcome === "aligned") {
    return result(requirement, "resolution_effect", {
      outcome: "satisfied",
      reason: alignment.reason,
      evidenceIds: [...landed.map((item) => item.evidence.id), ...code.map((item) => item.id)],
    });
  }
  return result(requirement, "resolution_effect", {
    outcome: "missing",
    reason: alignment.reason,
    evidenceIds: landed.map((item) => item.evidence.id),
  });
}

function evalClaimSupport(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const { claims, claimEvidence, evidence } = context.graph;
  const knownClaimIds = new Set(claims.map((claim) => claim.id));
  const orphanLinks = claimEvidence.filter((link) => !knownClaimIds.has(link.claimId));
  if (orphanLinks.length > 0) {
    return result(requirement, "claim_support", {
      outcome: "rejected",
      reason: "ClaimEvidence refers to a claim that is not part of this investigation.",
      evidenceIds: orphanLinks.map((link) => link.evidenceId),
    });
  }

  const critical = claims.filter((claim) => claim.critical);
  if (critical.length === 0) {
    return result(requirement, "claim_support", {
      outcome: "satisfied",
      reason: "No critical claims recorded; completion is judged from independent evidence checks.",
      evidenceIds: [],
    });
  }

  const statuses = critical.map((claim) => ({
    claim,
    status: claimSupportStatus(claim.id, claimEvidence, evidence),
  }));
  const contradicted = statuses.filter(
    (item) =>
      item.status === "contradicted" &&
      (item.claim.polarity === "resolved" || item.claim.polarity === "partial"),
  );
  const unsupported = statuses.filter(
    (item) =>
      item.status === "unsupported" &&
      (item.claim.polarity === "resolved" || item.claim.polarity === "partial"),
  );

  const graphContradictions = contradictingRelations(context.graph);
  const contradictedByGraph = critical.filter((claim) => {
    if (claim.polarity !== "resolved" && claim.polarity !== "partial") {
      return false;
    }
    const linked = new Set(
      claimEvidence.filter((link) => link.claimId === claim.id).map((link) => link.evidenceId),
    );
    return graphContradictions.some(
      (relation) => linked.has(relation.fromEvidenceId) || linked.has(relation.toEvidenceId),
    );
  });

  const allContradicted = [
    ...new Map(
      [...contradicted.map((item) => item.claim), ...contradictedByGraph].map((item) => [item.id, item]),
    ).values(),
  ];
  if (allContradicted.length > 0) {
    return result(requirement, "claim_support", {
      outcome: "rejected",
      reason: "Critical claim is contradicted by ClaimEvidence or an Evidence Graph contradicts edge.",
      evidenceIds: claimEvidence
        .filter((link) => allContradicted.some((claim) => claim.id === link.claimId))
        .map((link) => link.evidenceId),
      actual: allContradicted.map((claim) => claim.id),
    });
  }

  if (unsupported.length > 0) {
    return result(requirement, "claim_support", {
      outcome: "missing",
      reason: "Critical claim is missing supporting ClaimEvidence in this investigation.",
      evidenceIds: [],
      actual: unsupported.map((item) => item.claim.id),
    });
  }

  return result(requirement, "claim_support", {
    outcome: "satisfied",
    reason: "Critical claims have explicit ClaimEvidence support without contradiction.",
    evidenceIds: claimEvidence.map((link) => link.evidenceId),
  });
}

const EVALUATORS: Record<
  EvidenceRequirementCondition,
  (requirement: EvidenceRequirement, context: RequirementEvalContext) => RequirementEvaluation
> = {
  has_kind: evalHasKind,
  issue_identity: evalIssueIdentity,
  issue_closed: evalIssueClosed,
  eligible_closure: evalEligibleClosure,
  resolution_candidate: evalResolutionCandidate,
  resolution_merged: evalResolutionMerged,
  resolution_code_evidence: evalResolutionCodeEvidence,
  resolution_effect: evalResolutionEffect,
  claim_support: evalClaimSupport,
};

export function requirementEvalContext(input: {
  task: InvestigationTask;
  graph?: EvidenceGraph;
  evidence?: Evidence[];
  relations?: EvidenceGraph["relations"];
  claims?: EvidenceGraph["claims"];
  claimEvidence?: EvidenceGraph["claimEvidence"];
}): RequirementEvalContext {
  return {
    task: input.task,
    graph: input.graph ?? {
      evidence: input.evidence ?? [],
      relations: input.relations ?? [],
      claims: input.claims ?? [],
      claimEvidence: input.claimEvidence ?? [],
    },
  };
}

/**
 * Single semantic definition of whether an EvidenceRequirement is satisfied.
 * Optional vs required is not evaluated here; the verifier applies that to the verdict.
 * `satisfiedBy` is metadata only and cannot bypass `condition`.
 */
export function evaluateEvidenceRequirement(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const condition = requirement.condition ?? "has_kind";
  return EVALUATORS[condition](requirement, context);
}

export function requirementSatisfied(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): boolean {
  return evaluateEvidenceRequirement(requirement, context).satisfied;
}

export function isOptionalRequirementAbsent(
  requirement: EvidenceRequirement,
  evaluation: RequirementEvaluation,
): boolean {
  return isOptionalRequirement(requirement) && !evaluation.satisfied && evaluation.outcome === "missing";
}
