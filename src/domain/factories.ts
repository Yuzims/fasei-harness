import { randomUUID } from "node:crypto";
import type {
  Claim,
  ClaimEvidence,
  Evidence,
  EvidenceReference,
  EvidenceRelation,
  EvidenceRequirement,
  InvestigationAttempt,
  InvestigationRun,
  InvestigationTask,
  InvestigationTarget,
  ResolutionAnalysis,
  ResolutionOverallStatus,
  ResolutionSignal,
} from "./types.js";

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

export function createTarget(input: InvestigationTarget): InvestigationTarget {
  const owner = requireText(input.owner, "owner");
  const repository = requireText(input.repository, "repository");
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error("issueNumber must be a positive integer");
  }
  return {
    owner,
    repository,
    issueNumber: input.issueNumber,
    url:
      input.url?.trim() ||
      `https://github.com/${owner}/${repository}/issues/${input.issueNumber}`,
  };
}

export function defaultResolutionRequirements(): EvidenceRequirement[] {
  return [
    {
      id: "req-issue",
      kind: "issue",
      severity: "critical",
      description: "Target GitHub Issue observation (identity).",
      condition: "issue_identity",
    },
    {
      id: "req-pr",
      kind: "pull_request",
      severity: "required",
      description: "Resolution-candidate pull request or direct commit linked to the issue.",
      acceptedKinds: ["pull_request", "commit"],
      condition: "resolution_candidate",
    },
    {
      id: "req-commit",
      kind: "commit",
      severity: "required",
      description: "Commit or changed-file evidence on the landed resolution path.",
      acceptedKinds: ["commit", "file", "code"],
      condition: "resolution_code_evidence",
    },
  ];
}

export function createInvestigationTask(input: {
  id?: string;
  target: InvestigationTarget;
  question?: InvestigationTask["question"];
  description?: string;
  requirements?: EvidenceRequirement[];
}): InvestigationTask {
  const target = createTarget(input.target);
  return {
    id: input.id?.trim() || randomUUID(),
    target,
    question: input.question ?? "is_resolved_and_how",
    description:
      input.description?.trim() ||
      `调查 ${target.owner}/${target.repository}#${target.issueNumber} 是否已经真正解决，以及如何解决。`,
    requirements: input.requirements ?? defaultResolutionRequirements(),
  };
}

export function createEvidence(input: Omit<Evidence, "id"> & { id?: string }): Evidence {
  return {
    id: input.id?.trim() || randomUUID(),
    kind: input.kind,
    provenance: {
      ...input.provenance,
      source: requireText(input.provenance.source, "provenance.source"),
      retrievedAt: requireText(input.provenance.retrievedAt, "provenance.retrievedAt"),
      trust: input.provenance.trust ?? "external_untrusted",
    },
    summary: requireText(input.summary, "summary"),
    contentRef: input.contentRef,
    payload: input.payload,
  };
}

export function createRelation(
  input: Omit<EvidenceRelation, "id"> & { id?: string },
): EvidenceRelation {
  const fromEvidenceId = requireText(input.fromEvidenceId, "fromEvidenceId");
  const toEvidenceId = requireText(input.toEvidenceId, "toEvidenceId");
  if (fromEvidenceId === toEvidenceId) {
    throw new Error("Evidence relation cannot be a self-reference");
  }
  return {
    id: input.id?.trim() || randomUUID(),
    fromEvidenceId,
    toEvidenceId,
    type: input.type,
  };
}

export function createClaim(input: Omit<Claim, "id" | "critical"> & { id?: string; critical?: boolean }): Claim {
  return {
    id: input.id?.trim() || randomUUID(),
    text: requireText(input.text, "text"),
    polarity: input.polarity,
    critical: input.critical ?? true,
  };
}

export function bindClaimEvidence(input: ClaimEvidence): ClaimEvidence {
  return {
    claimId: requireText(input.claimId, "claimId"),
    evidenceId: requireText(input.evidenceId, "evidenceId"),
    role: input.role,
  };
}

export function createResolutionAnalysis(
  input: Omit<ResolutionAnalysis, "id" | "candidateId" | "signals" | "overall" | "provenance"> & {
    id?: string;
    candidateId?: string;
    signals?: ResolutionSignal[];
    overall?: ResolutionOverallStatus;
    provenance?: EvidenceReference[];
  },
): ResolutionAnalysis {
  const candidateEvidenceId = requireText(input.candidateEvidenceId, "candidateEvidenceId");
  return {
    id: input.id?.trim() || randomUUID(),
    candidateId: input.candidateId?.trim() || candidateEvidenceId,
    candidateEvidenceId,
    issueEvidenceId: requireText(input.issueEvidenceId, "issueEvidenceId"),
    mergeCommitSha: input.mergeCommitSha?.trim() || undefined,
    codeRelevance: requireText(input.codeRelevance, "codeRelevance"),
    behavioralAlignment: requireText(input.behavioralAlignment, "behavioralAlignment"),
    testSupport: requireText(input.testSupport, "testSupport"),
    unresolvedQuestions: [...input.unresolvedQuestions],
    supportingEvidenceIds: [...input.supportingEvidenceIds],
    claimIds: [...input.claimIds],
    signals: [...(input.signals ?? [])],
    overall: input.overall ?? "unknown",
    provenance: [...(input.provenance ?? [])],
  };
}

export function createInvestigationRun(input: {
  id?: string;
  task: InvestigationTask;
  startedAt?: string;
}): InvestigationRun {
  return {
    id: input.id?.trim() || randomUUID(),
    taskId: input.task.id,
    status: "in_progress",
    startedAt: input.startedAt ?? new Date().toISOString(),
    attempts: [],
    evidence: [],
    relations: [],
    claims: [],
    claimEvidence: [],
    resolutionAnalyses: [],
  };
}

export function appendAttempt(
  run: InvestigationRun,
  attempt: Omit<InvestigationAttempt, "attempt" | "startedAt" | "id"> & {
    id?: string;
    startedAt?: string;
  },
): InvestigationRun {
  const attemptNumber = run.attempts.length + 1;
  const next: InvestigationAttempt = {
    id: attempt.id?.trim() || `attempt-${attemptNumber}`,
    attempt: attemptNumber,
    startedAt: attempt.startedAt ?? new Date().toISOString(),
    endedAt: attempt.endedAt,
    parentAttemptId: attempt.parentAttemptId,
    recoveryPlanId: attempt.recoveryPlanId,
    failureEventId: attempt.failureEventId,
    strategy: attempt.strategy,
    status: attempt.status,
    agentConclusion: attempt.agentConclusion,
    report: attempt.report,
    evidenceIds: [...attempt.evidenceIds],
    claimIds: [...attempt.claimIds],
    verification: attempt.verification,
    failure: attempt.failure,
    recovery: attempt.recovery,
  };

  return {
    ...run,
    attempts: [...run.attempts, next],
  };
}
