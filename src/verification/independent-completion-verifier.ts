/**
 * Independent Completion Verifier for GitHub issue investigations.
 *
 * Product path. Agent conclusions / final answers are recorded but never used as truth.
 * Tool-call success is not completion. GitHub issue/comment bodies are untrusted
 * data and are never treated as Harness instructions.
 *
 * IndependentCompletionVerifier is the main completion verifier.
 * WorkspaceCompletionVerifier is legacy (synthetic file/count demos only).
 *
 * Verification reads the Evidence Graph (EvidenceRelation + ClaimEvidence +
 * EvidenceRequirement). Payload is used only for factual fields (identity,
 * issue state, merged). Relationships are not reconstructed from payloads.
 */
import {
  buildVerificationResult,
  claimSupportStatus,
  codeEvidenceFor,
  contradictingRelations,
  graphFromRun,
  isOptionalRequirement,
  issueEvidenceItems,
  issueFact,
  mergeContradiction,
  pullFact,
  requirementSatisfied,
  resolutionCandidateEvidence,
  targetIssueEvidence,
  type Claim,
  type Evidence,
  type EvidenceGraph,
  type EvidenceRequirement,
  type InvestigationRun,
  type InvestigationTask,
  type RequirementSeverity,
  type VerificationCheck,
  type VerificationResult,
} from "../domain/index.js";
import type { TraceCollector } from "../trace/trace-collector.js";

export interface IndependentVerifyInput {
  task: InvestigationTask;
  run: InvestigationRun;
  /** Agent prose is ignored for the verdict. */
  agentFinalAnswer?: string;
  agentConclusion?: string;
  /** Metadata only. Never used as the completion verdict. */
  agentClaimedComplete?: boolean;
}

function targetRepository(task: InvestigationTask): string {
  return `${task.target.owner}/${task.target.repository}`;
}

function check(
  input: Omit<VerificationCheck, "evidenceIds"> & { evidenceIds?: string[] },
): VerificationCheck {
  return {
    ...input,
    evidenceIds: input.evidenceIds ?? [],
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function codeChangeRequired(requirements: EvidenceRequirement[]): boolean {
  return requirements.some(
    (item) =>
      !isOptionalRequirement(item) &&
      (item.condition === "resolution_code_evidence" ||
        item.kind === "commit" ||
        item.kind === "file" ||
        item.kind === "code" ||
        (item.acceptedKinds ?? []).some((kind) => kind === "commit" || kind === "file" || kind === "code")),
  );
}

function codeChangeSeverity(requirements: EvidenceRequirement[]): RequirementSeverity | "info" {
  if (
    requirements.some(
      (item) =>
        !isOptionalRequirement(item) &&
        item.severity === "critical" &&
        (item.kind === "commit" || item.condition === "resolution_code_evidence"),
    )
  ) {
    return "critical";
  }
  return codeChangeRequired(requirements) ? "required" : "optional";
}

function checkIssueIdentity(task: InvestigationTask, graph: EvidenceGraph): VerificationCheck {
  const issues = issueEvidenceItems(graph);
  const expected = targetRepository(task);
  if (issues.length === 0) {
    return check({
      id: "issue-identity",
      name: "issue identity",
      type: "identity",
      status: "unknown",
      severity: "critical",
      message: "No issue evidence; cannot confirm owner/repository/number.",
    });
  }

  const matches = targetIssueEvidence(graph, task);
  if (matches.length === 0) {
    const actual = issues.map(issueFact).find((item) => item);
    return check({
      id: "issue-identity",
      name: "issue identity",
      type: "identity",
      status: "fail",
      severity: "critical",
      message: `Evidence points at ${actual?.repository}#${actual?.number}, not ${expected}#${task.target.issueNumber}.`,
      evidenceIds: issues.map((item) => item.id),
      expected: { repository: expected, issueNumber: task.target.issueNumber },
      actual: { repository: actual?.repository, issueNumber: actual?.number },
    });
  }

  return check({
    id: "issue-identity",
    name: "issue identity",
    type: "identity",
    status: "pass",
    severity: "critical",
    message: `Issue identity matches ${expected}#${task.target.issueNumber}.`,
    evidenceIds: matches.map((item) => item.id),
    expected: { repository: expected, issueNumber: task.target.issueNumber },
    actual: { repository: expected, issueNumber: task.target.issueNumber },
  });
}

function checkIssueClosed(task: InvestigationTask, graph: EvidenceGraph): VerificationCheck {
  const matches = targetIssueEvidence(graph, task);
  if (matches.length === 0) {
    return check({
      id: "issue-state",
      name: "issue closed",
      type: "issue_state",
      status: "unknown",
      severity: "required",
      message: "No target issue evidence; cannot read issue state.",
    });
  }

  const facts = matches.map(issueFact).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const closed = facts.filter((item) => item.state === "closed");
  if (closed.length === 0) {
    return check({
      id: "issue-state",
      name: "issue closed",
      type: "issue_state",
      status: "fail",
      severity: "required",
      message: `Target issue is ${facts[0]?.state ?? "unknown"}; an open issue is not resolved.`,
      evidenceIds: matches.map((item) => item.id),
      expected: "closed",
      actual: facts[0]?.state,
    });
  }

  return check({
    id: "issue-state",
    name: "issue closed",
    type: "issue_state",
    status: "pass",
    severity: "required",
    message: "Issue is closed. Closed is not equivalent to resolved.",
    evidenceIds: uniqueIds(closed.map((item) => item.evidenceId)),
    expected: "closed",
    actual: "closed",
  });
}

function checkResolutionCandidate(
  task: InvestigationTask,
  graph: EvidenceGraph,
): VerificationCheck {
  const pulls = graph.evidence.filter((item) => item.kind === "pull_request");
  const candidates = resolutionCandidateEvidence(graph, task);
  if (candidates.length > 0) {
    const numbers = [
      ...new Set(
        candidates
          .map(pullFact)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => item.number),
      ),
    ];
    return check({
      id: "resolution-candidate",
      name: "resolution candidate",
      type: "pr_existence",
      status: "pass",
      severity: "required",
      message: `Resolution candidate PR(s): ${numbers.map((n) => `#${n}`).join(", ") || "linked"}.`,
      evidenceIds: uniqueIds(candidates.map((item) => item.id)),
      actual: numbers,
    });
  }
  if (pulls.length > 0) {
    return check({
      id: "resolution-candidate",
      name: "resolution candidate",
      type: "pr_existence",
      status: "fail",
      severity: "required",
      message:
        "Pull request evidence exists but is not linked to the target issue in the Evidence Graph.",
      evidenceIds: uniqueIds(pulls.map((item) => item.id)),
    });
  }
  return check({
    id: "resolution-candidate",
    name: "resolution candidate",
    type: "pr_existence",
    status: "unknown",
    severity: "required",
    message: "No pull request evidence linked to the target issue.",
  });
}

function checkResolutionMerged(
  task: InvestigationTask,
  graph: EvidenceGraph,
): VerificationCheck {
  const candidates = resolutionCandidateEvidence(graph, task);
  if (candidates.length === 0) {
    return check({
      id: "pr-merged",
      name: "resolution merged",
      type: "pr_merge",
      status: "unknown",
      severity: "required",
      message: "No resolution-candidate PR to inspect for merged=true.",
    });
  }

  const contradiction = mergeContradiction(graph, candidates);
  if (contradiction.conflict) {
    return check({
      id: "pr-merged",
      name: "resolution merged",
      type: "pr_merge",
      status: "fail",
      severity: "required",
      message: "Contradictory merge evidence for the same resolution-candidate PR.",
      evidenceIds: uniqueIds([
        ...contradiction.merged.map((item) => item.id),
        ...contradiction.unmerged.map((item) => item.id),
      ]),
      expected: true,
      actual: "contradicted",
    });
  }

  const mergedViaRelation = candidates.filter((item) =>
    graph.relations.some(
      (relation) =>
        relation.type === "merges" &&
        (relation.toEvidenceId === item.id || relation.fromEvidenceId === item.id),
    ),
  );
  const merged = [
    ...new Map(
      [...contradiction.merged, ...mergedViaRelation].map((item) => [item.id, item]),
    ).values(),
  ];

  if (merged.length > 0) {
    const numbers = [
      ...new Set(
        merged
          .map(pullFact)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => item.number),
      ),
    ];
    return check({
      id: "pr-merged",
      name: "resolution merged",
      type: "pr_merge",
      status: "pass",
      severity: "required",
      message: `Candidate PR merged=true: ${numbers.map((n) => `#${n}`).join(", ") || "linked"}.`,
      evidenceIds: uniqueIds(merged.map((item) => item.id)),
      expected: true,
      actual: true,
    });
  }

  if (contradiction.unmerged.length > 0) {
    return check({
      id: "pr-merged",
      name: "resolution merged",
      type: "pr_merge",
      status: "fail",
      severity: "required",
      message: "Candidate PR exists but merged=false (open or closed-unmerged is not completion).",
      evidenceIds: uniqueIds(contradiction.unmerged.map((item) => item.id)),
      expected: true,
      actual: false,
    });
  }

  return check({
    id: "pr-merged",
    name: "resolution merged",
    type: "pr_merge",
    status: "unknown",
    severity: "required",
    message: "Candidate PR evidence does not include a merged fact or merges relation.",
    evidenceIds: uniqueIds(candidates.map((item) => item.id)),
  });
}

function checkResolutionCodeEvidence(
  requirements: EvidenceRequirement[],
  graph: EvidenceGraph,
  task: InvestigationTask,
): VerificationCheck {
  const candidates = resolutionCandidateEvidence(graph, task);
  const found = codeEvidenceFor(
    graph,
    candidates.map((item) => item.id),
  );
  const severity = codeChangeSeverity(requirements);
  if (found.length > 0) {
    return check({
      id: "code-commit",
      name: "resolution code evidence",
      type: "commit_existence",
      status: "pass",
      severity,
      message: `Found ${found.length} commit/file/code evidence item(s) linked to the resolution PR. A merged PR record is not code evidence.`,
      evidenceIds: found.map((item) => item.id),
    });
  }
  if (severity === "optional") {
    return check({
      id: "code-commit",
      name: "resolution code evidence",
      type: "commit_existence",
      status: "pass",
      severity: "optional",
      message: "Commit/file evidence is optional for this task and was not required to complete.",
    });
  }
  return check({
    id: "code-commit",
    name: "resolution code evidence",
    type: "commit_existence",
    status: "unknown",
    severity,
    message:
      "Required commit/file/code evidence is missing from the Evidence Graph. A pull request record is not enough.",
  });
}

function checkClaimSupport(graph: EvidenceGraph): VerificationCheck {
  const { claims, claimEvidence, evidence } = graph;
  const knownClaimIds = new Set(claims.map((claim) => claim.id));
  const orphanLinks = claimEvidence.filter((link) => !knownClaimIds.has(link.claimId));
  if (orphanLinks.length > 0) {
    return check({
      id: "claims-supported",
      name: "claim support",
      type: "claim_coverage",
      status: "fail",
      severity: "required",
      message: "ClaimEvidence refers to a claim that is not part of this investigation.",
    });
  }

  const critical = claims.filter((claim) => claim.critical);
  if (critical.length === 0) {
    return check({
      id: "claims-supported",
      name: "claim support",
      type: "claim_coverage",
      status: "pass",
      severity: "required",
      message: "No critical claims recorded; completion is judged from independent evidence checks.",
    });
  }

  const statuses = critical.map((claim) => ({
    claim,
    status: claimSupportStatus(claim.id, claimEvidence, evidence),
  }));
  const contradicted = statuses
    .filter(
      (item) =>
        item.status === "contradicted" &&
        (item.claim.polarity === "resolved" || item.claim.polarity === "partial"),
    )
    .map((item) => item.claim);
  const unsupported = statuses
    .filter(
      (item) =>
        item.status === "unsupported" &&
        (item.claim.polarity === "resolved" || item.claim.polarity === "partial"),
    )
    .map((item) => item.claim);

  const graphContradictions = contradictingRelations(graph);
  const contradictedByGraph: Claim[] = [];
  if (graphContradictions.length > 0) {
    for (const claim of critical) {
      const linked = new Set(
        claimEvidence.filter((link) => link.claimId === claim.id).map((link) => link.evidenceId),
      );
      const hitsClaim = graphContradictions.some(
        (relation) => linked.has(relation.fromEvidenceId) || linked.has(relation.toEvidenceId),
      );
      if (hitsClaim && claim.polarity === "resolved") {
        contradictedByGraph.push(claim);
      }
    }
  }

  const allContradicted = [...new Map([...contradicted, ...contradictedByGraph].map((item) => [item.id, item])).values()];
  if (allContradicted.length > 0) {
    return check({
      id: "claims-supported",
      name: "claim support",
      type: "claim_coverage",
      status: "fail",
      severity: "required",
      message: "Critical claim is contradicted by ClaimEvidence or an Evidence Graph contradicts edge.",
      evidenceIds: uniqueIds(
        claimEvidence
          .filter((link) => allContradicted.some((claim) => claim.id === link.claimId))
          .map((link) => link.evidenceId),
      ),
      actual: allContradicted.map((claim) => claim.id),
    });
  }

  if (unsupported.length > 0) {
    return check({
      id: "claims-supported",
      name: "claim support",
      type: "claim_coverage",
      status: "unknown",
      severity: "required",
      message: "Critical claim is missing supporting ClaimEvidence in this investigation.",
      actual: unsupported.map((claim) => claim.id),
    });
  }

  return check({
    id: "claims-supported",
    name: "claim support",
    type: "claim_coverage",
    status: "pass",
    severity: "required",
    message: "Critical claims have explicit ClaimEvidence support without contradiction.",
    evidenceIds: uniqueIds(claimEvidence.map((link) => link.evidenceId)),
  });
}

function checkEvidenceRequirements(
  requirements: EvidenceRequirement[],
  evidence: Evidence[],
): VerificationCheck {
  const missingRequired = requirements.filter(
    (item) => !isOptionalRequirement(item) && !requirementSatisfied(item, evidence),
  );
  const optionalMissing = requirements.filter(
    (item) => isOptionalRequirement(item) && !requirementSatisfied(item, evidence),
  );

  if (missingRequired.length > 0) {
    return check({
      id: "evidence-requirements",
      name: "evidence requirements",
      type: "evidence_existence",
      status: "unknown",
      severity: "required",
      message: `Required evidence missing: ${missingRequired.map((item) => item.id).join(", ")}. Optional gaps do not block.`,
      actual: missingRequired.map((item) => item.id),
    });
  }

  return check({
    id: "evidence-requirements",
    name: "evidence requirements",
    type: "evidence_existence",
    status: "pass",
    severity: "required",
    message:
      optionalMissing.length > 0
        ? `Required evidence present. Optional missing (${optionalMissing.map((item) => item.id).join(", ")}) does not block completion.`
        : "Required evidence requirements are satisfied.",
    evidenceIds: evidence.map((item) => item.id),
  });
}

export class IndependentCompletionVerifier {
  verify(input: IndependentVerifyInput, trace?: TraceCollector): VerificationResult {
    const { task, run } = input;
    const graph = graphFromRun(run);
    const step = Math.max(0, ...run.attempts.map((item) => item.attempt), 0);

    trace?.record(run.id, step, "verification_started", {
      taskId: task.id,
      target: task.target,
      evidenceCount: run.evidence.length,
      relationCount: run.relations.length,
      claimCount: run.claims.length,
      agentFinalAnswerIgnored: true,
      agentConclusionIgnored: true,
    });

    const checks: VerificationCheck[] = [
      checkIssueIdentity(task, graph),
      checkIssueClosed(task, graph),
      checkResolutionCandidate(task, graph),
      checkResolutionMerged(task, graph),
      checkResolutionCodeEvidence(task.requirements, graph, task),
      checkClaimSupport(graph),
      checkEvidenceRequirements(task.requirements, run.evidence),
    ];

    for (const item of checks) {
      trace?.record(run.id, step, "verification_check", {
        id: item.id,
        name: item.name,
        type: item.type,
        status: item.status,
        severity: item.severity,
        message: item.message,
        evidenceIds: item.evidenceIds,
        expected: item.expected,
        actual: item.actual,
      });
    }

    const result = buildVerificationResult({
      checks,
      requirements: task.requirements,
      claims: run.claims.filter(
        (claim) => claim.critical && (claim.polarity === "resolved" || claim.polarity === "partial"),
      ),
      claimEvidence: run.claimEvidence,
      evidence: run.evidence,
      agentClaimedComplete: input.agentClaimedComplete === true,
    });

    trace?.record(run.id, step, "verification_completed", {
      status: result.status,
      evidenceCoverage: result.evidenceCoverage,
      unsupportedClaimIds: result.unsupportedClaimIds,
      missingRequirementIds: result.missingRequirementIds,
      prematureCompletion: result.prematureCompletion,
      failedChecks: result.checks
        .filter((item) => item.status === "fail")
        .map((item) => item.id),
      unknownChecks: result.checks
        .filter((item) => item.status === "unknown")
        .map((item) => item.id),
      why:
        result.status === "verified_complete"
          ? "All required independent checks passed."
          : result.status === "insufficient_evidence"
            ? "Key evidence is missing; the harness cannot prove completion."
            : "Evidence is sufficient to reject completion (failed condition or contradiction).",
    });

    return result;
  }
}

export function verifyInvestigationCompletion(
  input: IndependentVerifyInput,
  trace?: TraceCollector,
): VerificationResult {
  return new IndependentCompletionVerifier().verify(input, trace);
}
