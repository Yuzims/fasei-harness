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
  codeEvidenceFor,
  contradictingRelations,
  isOptionalRequirement,
  issueEvidenceItems,
  mergeContradiction,
  requirementKinds,
  resolutionCandidateEvidence,
  targetIssueEvidence,
  type EvidenceGraph,
} from "./evidence-graph.js";
import { issueFact, pullFact } from "./evidence-facts.js";
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

function evalResolutionCandidate(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const pulls = context.graph.evidence.filter((item) => item.kind === "pull_request");
  const candidates = resolutionCandidateEvidence(context.graph, context.task);
  if (candidates.length > 0) {
    const numbers = [
      ...new Set(
        candidates
          .map(pullFact)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => item.number),
      ),
    ];
    return result(requirement, "resolution_candidate", {
      outcome: "satisfied",
      reason: `Resolution candidate PR(s): ${numbers.map((n) => `#${n}`).join(", ") || "linked"}.`,
      evidenceIds: candidates.map((item) => item.id),
      actual: numbers,
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
    reason: "No pull request evidence linked to the target issue.",
    evidenceIds: [],
  });
}

function mergedCandidateEvidence(
  graph: EvidenceGraph,
  task: InvestigationTask,
): { candidates: Evidence[]; merged: Evidence[]; unmerged: Evidence[]; conflict: boolean } {
  const candidates = resolutionCandidateEvidence(graph, task);
  const contradiction = mergeContradiction(graph, candidates);
  const mergedViaRelation = candidates.filter((item) =>
    graph.relations.some(
      (relation) =>
        relation.type === "merges" &&
        (relation.toEvidenceId === item.id || relation.fromEvidenceId === item.id),
    ),
  );
  const merged = [
    ...new Map([...contradiction.merged, ...mergedViaRelation].map((item) => [item.id, item])).values(),
  ];
  return {
    candidates,
    merged,
    unmerged: contradiction.unmerged,
    conflict: contradiction.conflict,
  };
}

function evalResolutionMerged(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const { candidates, merged, unmerged, conflict } = mergedCandidateEvidence(
    context.graph,
    context.task,
  );
  if (candidates.length === 0) {
    return result(requirement, "resolution_merged", {
      outcome: "missing",
      reason: "No resolution-candidate PR to inspect for merged=true.",
      evidenceIds: [],
      expected: true,
    });
  }
  if (conflict) {
    return result(requirement, "resolution_merged", {
      outcome: "rejected",
      reason: "Contradictory merge evidence for the same resolution-candidate PR.",
      evidenceIds: [...merged, ...unmerged].map((item) => item.id),
      expected: true,
      actual: "contradicted",
    });
  }
  if (merged.length > 0) {
    const numbers = [
      ...new Set(
        merged
          .map(pullFact)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => item.number),
      ),
    ];
    return result(requirement, "resolution_merged", {
      outcome: "satisfied",
      reason: `Candidate PR merged=true: ${numbers.map((n) => `#${n}`).join(", ") || "linked"}.`,
      evidenceIds: merged.map((item) => item.id),
      expected: true,
      actual: true,
    });
  }
  if (unmerged.length > 0) {
    return result(requirement, "resolution_merged", {
      outcome: "rejected",
      reason: "Candidate PR exists but merged=false (open or closed-unmerged is not completion).",
      evidenceIds: unmerged.map((item) => item.id),
      expected: true,
      actual: false,
    });
  }
  return result(requirement, "resolution_merged", {
    outcome: "missing",
    reason: "Candidate PR evidence does not include a merged fact or merges relation.",
    evidenceIds: candidates.map((item) => item.id),
    expected: true,
  });
}

function evalResolutionCodeEvidence(
  requirement: EvidenceRequirement,
  context: RequirementEvalContext,
): RequirementEvaluation {
  const candidates = resolutionCandidateEvidence(context.graph, context.task);
  const found = codeEvidenceFor(
    context.graph,
    candidates.map((item) => item.id),
  );
  if (found.length > 0) {
    return result(requirement, "resolution_code_evidence", {
      outcome: "satisfied",
      reason: `Found ${found.length} commit/file/code evidence item(s) linked to the resolution PR. A merged PR record is not code evidence.`,
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
  resolution_candidate: evalResolutionCandidate,
  resolution_merged: evalResolutionMerged,
  resolution_code_evidence: evalResolutionCodeEvidence,
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
