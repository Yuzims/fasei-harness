/**
 * Independent Completion Verifier for GitHub issue investigations.
 *
 * Product path. Agent conclusions / final answers are recorded but never used as truth.
 * Tool-call success is not completion. GitHub issue/comment bodies are untrusted
 * data and are never treated as Harness instructions.
 *
 * IndependentCompletionVerifier orchestrates VerificationCheck[] / VerificationResult.
 * Whether an EvidenceRequirement is satisfied comes from evaluateEvidenceRequirement.
 *
 * IndependentCompletionVerifier is the main completion verifier.
 * WorkspaceCompletionVerifier is legacy (synthetic file/count demos only).
 */
import {
  buildVerificationResult,
  evaluateEvidenceRequirement,
  graphFromRun,
  isCompletionRelevantClaim,
  isOptionalRequirement,
  isOptionalRequirementAbsent,
  requirementEvalContext,
  type CheckType,
  type EvidenceRequirement,
  type EvidenceRequirementCondition,
  type InvestigationRun,
  type InvestigationTask,
  type RequirementEvalContext,
  type RequirementEvaluation,
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

interface ChainCheckSpec {
  condition: EvidenceRequirementCondition;
  id: string;
  name: string;
  type: CheckType;
  kind: EvidenceRequirement["kind"];
  fallbackSeverity: RequirementSeverity;
}

const RESOLUTION_CHAIN: ChainCheckSpec[] = [
  {
    condition: "issue_identity",
    id: "issue-identity",
    name: "issue identity",
    type: "identity",
    kind: "issue",
    fallbackSeverity: "critical",
  },
  {
    condition: "issue_closed",
    id: "issue-state",
    name: "issue closed",
    type: "issue_state",
    kind: "issue",
    fallbackSeverity: "required",
  },
  {
    condition: "eligible_closure",
    id: "closure-semantics",
    name: "eligible closure",
    type: "closure_semantics",
    kind: "issue",
    fallbackSeverity: "required",
  },
  {
    condition: "resolution_candidate",
    id: "resolution-candidate",
    name: "resolution candidate",
    type: "pr_existence",
    kind: "pull_request",
    fallbackSeverity: "required",
  },
  {
    condition: "resolution_merged",
    id: "pr-merged",
    name: "resolution landed",
    type: "pr_merge",
    kind: "pull_request",
    fallbackSeverity: "required",
  },
  {
    condition: "resolution_code_evidence",
    id: "code-commit",
    name: "resolution code evidence",
    type: "commit_existence",
    kind: "commit",
    fallbackSeverity: "required",
  },
  {
    condition: "resolution_effect",
    id: "resolution-effect",
    name: "resolution effect alignment",
    type: "resolution_effect",
    kind: "other",
    fallbackSeverity: "required",
  },
  {
    condition: "claim_support",
    id: "claims-supported",
    name: "claim support",
    type: "claim_coverage",
    kind: "other",
    fallbackSeverity: "required",
  },
];

function check(
  input: Omit<VerificationCheck, "evidenceIds"> & { evidenceIds?: string[] },
): VerificationCheck {
  return {
    ...input,
    evidenceIds: input.evidenceIds ?? [],
  };
}

function requirementFor(
  task: InvestigationTask,
  spec: ChainCheckSpec,
): EvidenceRequirement {
  const listed = task.requirements.find((item) => item.condition === spec.condition);
  if (listed) {
    return listed;
  }
  return {
    id: spec.id,
    kind: spec.kind,
    severity: spec.fallbackSeverity,
    description: spec.name,
    condition: spec.condition,
    acceptedKinds: spec.condition === "resolution_code_evidence" ? ["commit", "file", "code"] : spec.condition === "resolution_candidate" ? ["pull_request", "commit"] : undefined,
  };
}

function checkStatus(evaluation: RequirementEvaluation): VerificationCheck["status"] {
  if (evaluation.satisfied) {
    return "pass";
  }
  return evaluation.outcome === "rejected" ? "fail" : "unknown";
}

function checkFromEvaluation(
  spec: ChainCheckSpec,
  requirement: EvidenceRequirement,
  evaluation: RequirementEvaluation,
): VerificationCheck {
  if (isOptionalRequirementAbsent(requirement, evaluation)) {
    return check({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      status: "pass",
      severity: "optional",
      message: `${spec.name} is optional for this task and was not required to complete.`,
      evidenceIds: evaluation.evidenceIds,
      expected: evaluation.expected,
      actual: evaluation.actual,
    });
  }
  return check({
    id: spec.id,
    name: spec.name,
    type: spec.type,
    status: checkStatus(evaluation),
    severity: requirement.severity,
    message: evaluation.reason,
    evidenceIds: evaluation.evidenceIds,
    expected: evaluation.expected,
    actual: evaluation.actual,
  });
}

function checkEvidenceRequirements(
  requirements: EvidenceRequirement[],
  context: RequirementEvalContext,
): VerificationCheck {
  const evaluations = requirements.map((item) => ({
    requirement: item,
    evaluation: evaluateEvidenceRequirement(item, context),
  }));
  const missingRequired = evaluations.filter(
    (item) => !isOptionalRequirement(item.requirement) && !item.evaluation.satisfied,
  );
  const optionalMissing = evaluations.filter(
    (item) => isOptionalRequirement(item.requirement) && !item.evaluation.satisfied,
  );

  if (missingRequired.length > 0) {
    return check({
      id: "evidence-requirements",
      name: "evidence requirements",
      type: "evidence_existence",
      status: "unknown",
      severity: "required",
      message: `Required evidence missing: ${missingRequired.map((item) => item.requirement.id).join(", ")}. Optional gaps do not block.`,
      actual: missingRequired.map((item) => item.requirement.id),
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
        ? `Required evidence present. Optional missing (${optionalMissing.map((item) => item.requirement.id).join(", ")}) does not block completion.`
        : "Required evidence requirements are satisfied.",
    evidenceIds: context.graph.evidence.map((item) => item.id),
  });
}

export class IndependentCompletionVerifier {
  verify(input: IndependentVerifyInput, trace?: TraceCollector): VerificationResult {
    const { task, run } = input;
    const graph = graphFromRun(run);
    const context = requirementEvalContext({ task, graph, prescan: run.resolutionPrescan });
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
      ...RESOLUTION_CHAIN.map((spec) => {
        const requirement = requirementFor(task, spec);
        return checkFromEvaluation(
          spec,
          requirement,
          evaluateEvidenceRequirement(requirement, context),
        );
      }),
      checkEvidenceRequirements(task.requirements, context),
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
      claims: run.claims.filter(isCompletionRelevantClaim),
      claimEvidence: run.claimEvidence,
      evidence: run.evidence,
      task,
      graph,
      prescan: run.resolutionPrescan,
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
          ? "All required independent checks passed, including a landed resolution path and descriptive alignment."
          : result.status === "insufficient_evidence"
            ? "Evidence is not enough to prove completion and not enough to reject it."
            : "Evidence is sufficient to reject completion (failed condition, explicit non-resolution, or contradiction).",
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
