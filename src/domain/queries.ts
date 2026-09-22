import {
  isCompletionRelevantClaim,
  isOptionalRequirement,
} from "./evidence-graph.js";
import {
  evaluateEvidenceRequirement,
  requirementEvalContext,
  type RequirementEvalContext,
} from "./requirement-eval.js";
import type {
  Claim,
  ClaimEvidence,
  Evidence,
  EvidenceRequirement,
  InvestigationAttempt,
  InvestigationRun,
  InvestigationTask,
  VerificationCheck,
  VerificationResult,
} from "./types.js";

export function supportingEvidenceIds(
  claimId: string,
  links: ClaimEvidence[],
): string[] {
  return links
    .filter((link) => link.claimId === claimId && link.role === "supports")
    .map((link) => link.evidenceId);
}

export function unsupportedClaims(
  claims: Claim[],
  links: ClaimEvidence[],
  evidence: Evidence[],
): Claim[] {
  const ids = new Set(evidence.map((item) => item.id));
  return claims.filter((claim) => {
    const supports = supportingEvidenceIds(claim.id, links).filter((id) => ids.has(id));
    return supports.length === 0;
  });
}

export function missingRequirements(
  requirements: EvidenceRequirement[],
  context: RequirementEvalContext,
): EvidenceRequirement[] {
  return requirements.filter(
    (requirement) => !evaluateEvidenceRequirement(requirement, context).satisfied,
  );
}

export function evidenceCoverage(
  requirements: EvidenceRequirement[],
  context: RequirementEvalContext,
): number {
  if (requirements.length === 0) {
    return 1;
  }
  const missing = missingRequirements(requirements, context).length;
  return (requirements.length - missing) / requirements.length;
}

export function criticalChecksPassed(checks: VerificationCheck[]): boolean {
  return checks
    .filter((check) => check.severity === "critical" || check.severity === "required")
    .every((check) => check.status === "pass");
}

function requiredChecks(checks: VerificationCheck[]): VerificationCheck[] {
  return checks.filter(
    (check) => check.severity === "critical" || check.severity === "required",
  );
}

/**
 * Agent 终答不参与判定。verified_complete 只在：
 * 关键/必需检查全过、必需证据齐、关键 Claim 都有 supporting evidence。
 *
 * 缺关键证据 / 无法证明 resolution effect → insufficient_evidence
 * 已有足够信息否定完成条件 / 明确 non-resolution / 存在矛盾 → not_verified
 */
export function buildVerificationResult(input: {
  checks: VerificationCheck[];
  requirements: EvidenceRequirement[];
  claims: Claim[];
  claimEvidence: ClaimEvidence[];
  evidence: Evidence[];
  task: InvestigationTask;
  relations?: InvestigationRun["relations"];
  graph?: RequirementEvalContext["graph"];
  prescan?: RequirementEvalContext["prescan"];
  agentClaimedComplete?: boolean;
}): VerificationResult {
  const context = requirementEvalContext({
    task: input.task,
    graph: input.graph,
    evidence: input.evidence,
    relations: input.relations,
    claims: input.claims,
    claimEvidence: input.claimEvidence,
    prescan: input.prescan,
  });
  const missing = missingRequirements(input.requirements, context);
  const unsupported = unsupportedClaims(
    input.claims.filter(isCompletionRelevantClaim),
    input.claimEvidence,
    input.evidence,
  );
  const required = requiredChecks(input.checks);
  const anyFail = required.some((check) => check.status === "fail");
  const anyUnknown = required.some((check) => check.status === "unknown");
  const checksOk = criticalChecksPassed(input.checks);
  const requiredMissing = missing.filter((item) => !isOptionalRequirement(item));
  const complete =
    checksOk && requiredMissing.length === 0 && unsupported.length === 0 && input.checks.length > 0;

  let status: VerificationResult["status"];
  if (complete) {
    status = "verified_complete";
  } else if (input.checks.length === 0) {
    status = "not_verified";
  } else if (anyFail) {
    status = "not_verified";
  } else if (anyUnknown || requiredMissing.length > 0 || unsupported.length > 0) {
    status = "insufficient_evidence";
  } else {
    status = "not_verified";
  }

  return {
    status,
    checks: input.checks,
    evidenceCoverage: evidenceCoverage(input.requirements, context),
    unsupportedClaimIds: unsupported.map((claim) => claim.id),
    missingRequirementIds: missing.map((item) => item.id),
    prematureCompletion: Boolean(input.agentClaimedComplete) && !complete && !anyFail,
  };
}

export function latestAttempt(
  run: InvestigationRun,
): InvestigationAttempt | undefined {
  return run.attempts.at(-1);
}
