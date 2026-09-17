/**
 * Independent Completion Verifier for GitHub issue investigations.
 *
 * Product path. Agent conclusions / final answers are recorded but never used as truth.
 * Tool-call success is not completion. GitHub issue/comment bodies are untrusted
 * data and are never treated as Harness instructions.
 *
 * IndependentCompletionVerifier is the main completion verifier.
 * WorkspaceCompletionVerifier is legacy (synthetic file/count demos only).
 */
import {
  buildVerificationResult,
  type Claim,
  type ClaimEvidence,
  type Evidence,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

interface IssueFacts {
  evidenceId: string;
  repository: string;
  number: number;
  state?: "open" | "closed";
}

interface PullFacts {
  evidenceId: string;
  repository: string;
  number: number;
  merged?: boolean;
  state?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readIssueFacts(item: Evidence): IssueFacts | undefined {
  if (item.kind !== "issue") {
    return undefined;
  }
  const payload = isRecord(item.payload) ? item.payload : {};
  const repository =
    stringField(payload, "repository") ?? item.provenance.repository ?? "";
  const number = numberField(payload, "number");
  const state = payload.state === "closed" || payload.state === "open" ? payload.state : undefined;
  if (!number || number <= 0) {
    return undefined;
  }
  return { evidenceId: item.id, repository, number, state };
}

function readPullFacts(item: Evidence): PullFacts | undefined {
  if (item.kind !== "pull_request") {
    return undefined;
  }
  const payload = isRecord(item.payload) ? item.payload : {};
  const number = numberField(payload, "number");
  if (!number || number <= 0) {
    return undefined;
  }
  return {
    evidenceId: item.id,
    repository: stringField(payload, "repository") ?? item.provenance.repository ?? "",
    number,
    merged: typeof payload.merged === "boolean" ? payload.merged : undefined,
    state: stringField(payload, "state"),
  };
}

function timelinePullNumbers(evidence: Evidence[]): number[] {
  const found = new Set<number>();
  for (const item of evidence.filter((entry) => entry.kind === "timeline")) {
    for (const event of asArray(item.payload)) {
      if (!isRecord(event)) {
        continue;
      }
      const pullNumber = numberField(event, "pullRequestNumber");
      if (pullNumber && pullNumber > 0) {
        found.add(pullNumber);
      }
    }
  }
  return [...found];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function hasCodeChangeEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.filter(
    (item) => item.kind === "commit" || item.kind === "file" || item.kind === "code",
  );
}

function codeChangeRequired(requirements: EvidenceRequirement[]): boolean {
  return requirements.some(
    (item) =>
      (item.kind === "commit" || item.kind === "file" || item.kind === "code") &&
      item.severity !== "optional",
  );
}

function codeChangeSeverity(requirements: EvidenceRequirement[]): RequirementSeverity | "info" {
  if (requirements.some((item) => item.kind === "commit" && item.severity === "critical")) {
    return "critical";
  }
  return codeChangeRequired(requirements) ? "required" : "optional";
}

function evidenceById(evidence: Evidence[]): Map<string, Evidence> {
  return new Map(evidence.map((item) => [item.id, item]));
}

function checkIssueIdentity(task: InvestigationTask, evidence: Evidence[]): VerificationCheck {
  const issues = evidence.map(readIssueFacts).filter((item): item is IssueFacts => Boolean(item));
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

  const matches = issues.filter(
    (item) => item.repository === expected && item.number === task.target.issueNumber,
  );
  if (matches.length === 0) {
    const actual = issues[0];
    return check({
      id: "issue-identity",
      name: "issue identity",
      type: "identity",
      status: "fail",
      severity: "critical",
      message: `Evidence points at ${actual?.repository}#${actual?.number}, not ${expected}#${task.target.issueNumber}.`,
      evidenceIds: issues.map((item) => item.evidenceId),
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
    evidenceIds: matches.map((item) => item.evidenceId),
    expected: { repository: expected, issueNumber: task.target.issueNumber },
    actual: { repository: matches[0]?.repository, issueNumber: matches[0]?.number },
  });
}

function checkIssueState(task: InvestigationTask, evidence: Evidence[]): VerificationCheck {
  const expected = targetRepository(task);
  const issues = evidence
    .map(readIssueFacts)
    .filter((item): item is IssueFacts => Boolean(item))
    .filter((item) => item.repository === expected && item.number === task.target.issueNumber);
  if (issues.length === 0) {
    return check({
      id: "issue-state",
      name: "issue state",
      type: "issue_state",
      status: "unknown",
      severity: "required",
      message: "No target issue evidence; cannot read issue state.",
    });
  }

  const closed = issues.filter((item) => item.state === "closed");
  if (closed.length === 0) {
    return check({
      id: "issue-state",
      name: "issue state",
      type: "issue_state",
      status: "fail",
      severity: "required",
      message: `Target issue is ${issues[0]?.state ?? "unknown"}; an open issue is not resolved.`,
      evidenceIds: issues.map((item) => item.evidenceId),
      expected: "closed",
      actual: issues[0]?.state,
    });
  }

  return check({
    id: "issue-state",
    name: "issue state",
    type: "issue_state",
    status: "pass",
    severity: "required",
    message: "Issue is closed. Closed is not equivalent to resolved.",
    evidenceIds: closed.map((item) => item.evidenceId),
    expected: "closed",
    actual: "closed",
  });
}

function resolutionCandidates(task: InvestigationTask, run: InvestigationRun): PullFacts[] {
  const expected = targetRepository(task);
  const pulls = run.evidence
    .map(readPullFacts)
    .filter((item): item is PullFacts => Boolean(item))
    .filter((item) => item.repository === expected || item.repository === "");
  const linkedNumbers = new Set(timelinePullNumbers(run.evidence));
  for (const relation of run.relations) {
    if (relation.type !== "fixes" && relation.type !== "references") {
      continue;
    }
    const from = run.evidence.find((item) => item.id === relation.fromEvidenceId);
    const to = run.evidence.find((item) => item.id === relation.toEvidenceId);
    const pull = from ? readPullFacts(from) : undefined;
    const issue = to ? readIssueFacts(to) : undefined;
    if (pull && issue && issue.number === task.target.issueNumber) {
      linkedNumbers.add(pull.number);
    }
  }

  if (linkedNumbers.size === 0) {
    return [];
  }
  return pulls.filter((item) => linkedNumbers.has(item.number));
}

function checkResolutionCandidate(
  task: InvestigationTask,
  run: InvestigationRun,
): VerificationCheck {
  const pulls = run.evidence
    .map(readPullFacts)
    .filter((item): item is PullFacts => Boolean(item));
  const candidates = resolutionCandidates(task, run);
  if (candidates.length > 0) {
    return check({
      id: "resolution-candidate",
      name: "resolution candidate",
      type: "pr_existence",
      status: "pass",
      severity: "required",
      message: `Resolution candidate PR(s): ${[...new Set(candidates.map((item) => `#${item.number}`))].join(", ")}.`,
      evidenceIds: uniqueIds(candidates.map((item) => item.evidenceId)),
      actual: candidates.map((item) => item.number),
    });
  }
  if (pulls.length > 0) {
    return check({
      id: "resolution-candidate",
      name: "resolution candidate",
      type: "pr_existence",
      status: "fail",
      severity: "required",
      message: "Pull request evidence exists but is not linked to the target issue via timeline/relations.",
      evidenceIds: uniqueIds(pulls.map((item) => item.evidenceId)),
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

function checkPullRequestMerged(
  task: InvestigationTask,
  run: InvestigationRun,
): VerificationCheck {
  const candidates = resolutionCandidates(task, run);
  if (candidates.length === 0) {
    return check({
      id: "pr-merged",
      name: "pull request merged",
      type: "pr_merge",
      status: "unknown",
      severity: "required",
      message: "No resolution-candidate PR to inspect for merged=true.",
    });
  }

  const known = candidates.filter((item) => typeof item.merged === "boolean");
  const merged = known.filter((item) => item.merged === true);
  if (merged.length > 0) {
    return check({
      id: "pr-merged",
      name: "pull request merged",
      type: "pr_merge",
      status: "pass",
      severity: "required",
      message: `Candidate PR merged=true: ${[...new Set(merged.map((item) => `#${item.number}`))].join(", ")}.`,
      evidenceIds: uniqueIds(merged.map((item) => item.evidenceId)),
      expected: true,
      actual: true,
    });
  }
  if (known.length > 0) {
    return check({
      id: "pr-merged",
      name: "pull request merged",
      type: "pr_merge",
      status: "fail",
      severity: "required",
      message: `Candidate PR exists but merged=false (open or closed-unmerged is not completion).`,
      evidenceIds: uniqueIds(known.map((item) => item.evidenceId)),
      expected: true,
      actual: false,
    });
  }
  return check({
    id: "pr-merged",
    name: "pull request merged",
    type: "pr_merge",
    status: "unknown",
    severity: "required",
    message: "Candidate PR evidence does not include a merged field.",
    evidenceIds: uniqueIds(candidates.map((item) => item.evidenceId)),
  });
}

function checkCodeOrCommit(
  requirements: EvidenceRequirement[],
  evidence: Evidence[],
): VerificationCheck {
  const found = hasCodeChangeEvidence(evidence);
  const severity = codeChangeSeverity(requirements);
  if (found.length > 0) {
    return check({
      id: "code-commit",
      name: "code or commit evidence",
      type: "commit_existence",
      status: "pass",
      severity,
      message: `Found ${found.length} commit/file/code evidence item(s). PR existence alone is not code evidence.`,
      evidenceIds: found.map((item) => item.id),
    });
  }
  if (severity === "optional") {
    return check({
      id: "code-commit",
      name: "code or commit evidence",
      type: "commit_existence",
      status: "pass",
      severity: "optional",
      message: "Commit/file evidence is optional for this task and was not required to complete.",
    });
  }
  return check({
    id: "code-commit",
    name: "code or commit evidence",
    type: "commit_existence",
    status: "unknown",
    severity,
    message: "Required commit/file/code evidence is missing. A pull request record is not enough.",
  });
}

function checkClaims(
  run: InvestigationRun,
  candidates: PullFacts[],
): VerificationCheck {
  const claims = run.claims;
  const links = run.claimEvidence;
  const byId = evidenceById(run.evidence);
  const knownClaimIds = new Set(claims.map((claim) => claim.id));
  const orphanLinks = links.filter((link) => !knownClaimIds.has(link.claimId));
  if (orphanLinks.length > 0) {
    return check({
      id: "claims-supported",
      name: "claims supported",
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
      name: "claims supported",
      type: "claim_coverage",
      status: "pass",
      severity: "required",
      message: "No critical claims recorded; completion is judged from independent evidence checks.",
    });
  }

  const mergedNumbers = new Set(
    candidates.filter((item) => item.merged === true).map((item) => item.number),
  );
  const unmergedNumbers = new Set(
    candidates.filter((item) => item.merged === false).map((item) => item.number),
  );

  const contradicted: Claim[] = [];
  const unsupportedResolved: Claim[] = [];
  const missingEvidence: Claim[] = [];

  for (const claim of critical) {
    const claimLinks = links.filter((link) => link.claimId === claim.id);
    const existing = claimLinks.filter((link) => byId.has(link.evidenceId));
    if (existing.length === 0) {
      missingEvidence.push(claim);
      continue;
    }
    const supports = existing.filter((link) => link.role === "supports");
    const contradicts = existing.filter((link) => link.role === "contradicts");
    if (claim.polarity === "resolved") {
      if (contradicts.length > 0) {
        contradicted.push(claim);
        continue;
      }
      if (supports.length === 0) {
        unsupportedResolved.push(claim);
        continue;
      }
      const supportedPulls = supports
        .map((link) => byId.get(link.evidenceId))
        .filter((item): item is Evidence => Boolean(item))
        .map(readPullFacts)
        .filter((item): item is PullFacts => Boolean(item));
      if (
        supportedPulls.some((item) => item.merged === false) &&
        !supportedPulls.some((item) => item.merged === true)
      ) {
        contradicted.push(claim);
      }
    }
  }

  if (contradicted.length > 0) {
    return check({
      id: "claims-supported",
      name: "claims supported",
      type: "claim_coverage",
      status: "fail",
      severity: "required",
      message: "Critical claim is contradicted by evidence (polarity/role/merged state).",
      evidenceIds: uniqueIds(
        links
          .filter((link) => contradicted.some((claim) => claim.id === link.claimId))
          .map((link) => link.evidenceId),
      ),
      actual: contradicted.map((claim) => claim.id),
    });
  }

  if (mergedNumbers.size > 0) {
    const unresolvedCritical = critical.filter((claim) => claim.polarity === "unresolved");
    if (unresolvedCritical.length > 0 && unmergedNumbers.size === 0) {
      return check({
        id: "claims-supported",
        name: "claims supported",
        type: "claim_coverage",
        status: "fail",
        severity: "required",
        message: "Critical unresolved claim contradicts merged resolution-candidate evidence.",
        evidenceIds: uniqueIds(
          links
            .filter((link) => unresolvedCritical.some((claim) => claim.id === link.claimId))
            .map((link) => link.evidenceId),
        ),
      });
    }
  }

  if (unsupportedResolved.length > 0 || missingEvidence.length > 0) {
    return check({
      id: "claims-supported",
      name: "claims supported",
      type: "claim_coverage",
      status: "unknown",
      severity: "required",
      message: "Critical claim is missing supporting evidence in this investigation.",
      actual: [...unsupportedResolved, ...missingEvidence].map((claim) => claim.id),
    });
  }

  return check({
    id: "claims-supported",
    name: "claims supported",
    type: "claim_coverage",
    status: "pass",
    severity: "required",
    message: "Critical claims have existing evidence with polarity/role consistent with observations.",
    evidenceIds: uniqueIds(links.map((link) => link.evidenceId)),
  });
}

function checkEvidenceRequirements(
  requirements: EvidenceRequirement[],
  evidence: Evidence[],
): VerificationCheck {
  const missingRequired = requirements.filter((item) => {
    if (item.severity === "optional") {
      return false;
    }
    if (item.satisfiedBy && item.satisfiedBy.length > 0) {
      const have = new Set(evidence.map((entry) => entry.id));
      return !item.satisfiedBy.some((id) => have.has(id));
    }
    if (item.kind === "commit" || item.kind === "file" || item.kind === "code") {
      return hasCodeChangeEvidence(evidence).length === 0;
    }
    return !evidence.some((entry) => entry.kind === item.kind);
  });
  const optionalMissing = requirements.filter(
    (item) => item.severity === "optional" && !evidence.some((entry) => entry.kind === item.kind),
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
    const step = Math.max(0, ...run.attempts.map((item) => item.attempt), 0);

    trace?.record(run.id, step, "verification_started", {
      taskId: task.id,
      target: task.target,
      evidenceCount: run.evidence.length,
      claimCount: run.claims.length,
      agentFinalAnswerIgnored: true,
      agentConclusionIgnored: true,
    });

    const candidates = resolutionCandidates(task, run);
    const checks: VerificationCheck[] = [
      checkIssueIdentity(task, run.evidence),
      checkIssueState(task, run.evidence),
      checkResolutionCandidate(task, run),
      checkPullRequestMerged(task, run),
      checkCodeOrCommit(task.requirements, run.evidence),
      checkClaims(run, candidates),
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
