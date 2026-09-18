/**
 * Evidence Gap is a projection of existing EvidenceRequirement evaluations.
 * It does not reimplement IndependentCompletionVerifier semantics.
 */
import {
  evaluateEvidenceRequirement,
  graphFromRun,
  isOptionalRequirement,
  requirementEvalContext,
  type EvidenceRequirement,
  type EvidenceRequirementCondition,
  type InvestigationRun,
  type InvestigationTask,
  type RequirementEvaluation,
  type RequirementOutcome,
  type RequirementSeverity,
} from "../domain/index.js";

export interface EvidenceGapItem {
  requirementId: string;
  condition: EvidenceRequirementCondition;
  outcome: RequirementOutcome;
  severity: RequirementSeverity;
  reason: string;
  evidenceIds: string[];
  optional: boolean;
}

export interface EvidenceGap {
  items: EvidenceGapItem[];
  missingRequirements: EvidenceGapItem[];
  satisfiedRequirements: EvidenceGapItem[];
  rejectedRequirements: EvidenceGapItem[];
}

interface ChainSpec {
  condition: EvidenceRequirementCondition;
  id: string;
  kind: EvidenceRequirement["kind"];
  severity: RequirementSeverity;
  description: string;
  acceptedKinds?: EvidenceRequirement["acceptedKinds"];
}

/**
 * Same condition order as IndependentCompletionVerifier's resolution chain.
 * IDs prefer task.requirements when the condition is already listed.
 */
const STRATEGY_CHAIN: ChainSpec[] = [
  {
    condition: "issue_identity",
    id: "issue-identity",
    kind: "issue",
    severity: "critical",
    description: "issue identity",
  },
  {
    condition: "issue_closed",
    id: "issue-state",
    kind: "issue",
    severity: "required",
    description: "issue closed",
  },
  {
    condition: "eligible_closure",
    id: "closure-semantics",
    kind: "issue",
    severity: "required",
    description: "eligible closure",
  },
  {
    condition: "resolution_candidate",
    id: "resolution-candidate",
    kind: "pull_request",
    severity: "required",
    description: "resolution candidate",
    acceptedKinds: ["pull_request", "commit"],
  },
  {
    condition: "resolution_merged",
    id: "pr-merged",
    kind: "pull_request",
    severity: "required",
    description: "resolution landed",
  },
  {
    condition: "resolution_code_evidence",
    id: "code-commit",
    kind: "commit",
    severity: "required",
    description: "resolution code evidence",
    acceptedKinds: ["commit", "file", "code"],
  },
  {
    condition: "resolution_effect",
    id: "resolution-effect",
    kind: "other",
    severity: "required",
    description: "resolution effect alignment",
  },
  {
    condition: "claim_support",
    id: "claims-supported",
    kind: "other",
    severity: "required",
    description: "claim support",
  },
];

function requirementFor(task: InvestigationTask, spec: ChainSpec): EvidenceRequirement {
  const listed = task.requirements.find((item) => item.condition === spec.condition);
  if (listed) {
    return listed;
  }
  return {
    id: spec.id,
    kind: spec.kind,
    severity: spec.severity,
    description: spec.description,
    condition: spec.condition,
    acceptedKinds: spec.acceptedKinds,
  };
}

function strategyRequirements(task: InvestigationTask): EvidenceRequirement[] {
  const seen = new Set<string>();
  const requirements: EvidenceRequirement[] = [];
  for (const spec of STRATEGY_CHAIN) {
    const requirement = requirementFor(task, spec);
    seen.add(requirement.id);
    requirements.push(requirement);
  }
  for (const requirement of task.requirements) {
    if (!seen.has(requirement.id)) {
      seen.add(requirement.id);
      requirements.push(requirement);
    }
  }
  return requirements;
}

function toItem(requirement: EvidenceRequirement, evaluation: RequirementEvaluation): EvidenceGapItem {
  return {
    requirementId: requirement.id,
    condition: evaluation.condition,
    outcome: evaluation.outcome,
    severity: requirement.severity,
    reason: evaluation.reason,
    evidenceIds: evaluation.evidenceIds,
    optional: isOptionalRequirement(requirement),
  };
}

export function computeEvidenceGap(task: InvestigationTask, run: InvestigationRun): EvidenceGap {
  const context = requirementEvalContext({
    task,
    graph: graphFromRun(run),
  });
  const items = strategyRequirements(task).map((requirement) =>
    toItem(requirement, evaluateEvidenceRequirement(requirement, context)),
  );
  return {
    items,
    missingRequirements: items.filter((item) => item.outcome === "missing"),
    satisfiedRequirements: items.filter((item) => item.outcome === "satisfied"),
    rejectedRequirements: items.filter((item) => item.outcome === "rejected"),
  };
}

export function unresolvedRequiredGaps(gap: EvidenceGap): EvidenceGapItem[] {
  return gap.items.filter((item) => !item.optional && item.outcome !== "satisfied");
}

export function missingRequiredGaps(gap: EvidenceGap): EvidenceGapItem[] {
  return gap.items.filter((item) => !item.optional && item.outcome === "missing");
}
