/**
 * Evidence Graph: first-class relations between Evidence (and ClaimEvidence).
 * Pure domain logic. No React / Hono / GitHub HTTP / LLM.
 */
import { randomUUID } from "node:crypto";
import { CODE_EVIDENCE_KINDS, commitFact, issueFact, pullFact } from "./evidence-facts.js";
import type {
  Claim,
  ClaimEvidence,
  ClaimEvidenceRole,
  ClaimSupportStatus,
  Evidence,
  EvidenceKind,
  EvidenceRelation,
  EvidenceRelationType,
  EvidenceRequirement,
  InvestigationRun,
  InvestigationTask,
} from "./types.js";

export const EVIDENCE_RELATION_TYPES: readonly EvidenceRelationType[] = [
  "supports",
  "contradicts",
  "derived_from",
  "references",
  "fixes",
  "hypothesis_fixes",
  "merges",
  "reviews",
  "parents",
  "mentions",
];

export const CLAIM_EVIDENCE_ROLES: readonly ClaimEvidenceRole[] = [
  "supports",
  "contradicts",
  "contextual",
];

/**
 * PR → Issue edges that identify a resolution candidate.
 * "fixes" is structured-corroboration only (Phase 18-B); "hypothesis_fixes"
 * nominates a candidate but never certifies it.
 */
export const RESOLUTION_CANDIDATE_RELATIONS: readonly EvidenceRelationType[] = [
  "fixes",
  "hypothesis_fixes",
  "references",
  "supports",
];

/** Commit/file/code → PR edges that attach code evidence to a candidate. */
export const CODE_LINK_RELATIONS: readonly EvidenceRelationType[] = [
  "derived_from",
  "parents",
  "merges",
];

export type EvidenceGraphErrorCode =
  | "invalid_evidence_id"
  | "invalid_relation_type"
  | "invalid_claim_id"
  | "invalid_claim_evidence"
  | "invalid_role"
  | "self_relation";

export class EvidenceGraphError extends Error {
  readonly code: EvidenceGraphErrorCode;

  constructor(code: EvidenceGraphErrorCode, message: string) {
    super(message);
    this.name = "EvidenceGraphError";
    this.code = code;
  }
}

export interface EvidenceGraph {
  evidence: Evidence[];
  relations: EvidenceRelation[];
  claims: Claim[];
  claimEvidence: ClaimEvidence[];
}

export interface RelationInput {
  id?: string;
  fromEvidenceId: string;
  toEvidenceId: string;
  type: EvidenceRelationType | string;
}

export interface ClaimEvidenceInput {
  claimId: string;
  evidenceId: string;
  role: ClaimEvidenceRole | string;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new EvidenceGraphError("invalid_evidence_id", `${field} is required`);
  }
  return trimmed;
}

export function isEvidenceRelationType(value: unknown): value is EvidenceRelationType {
  return typeof value === "string" && (EVIDENCE_RELATION_TYPES as readonly string[]).includes(value);
}

export function isClaimEvidenceRole(value: unknown): value is ClaimEvidenceRole {
  return typeof value === "string" && (CLAIM_EVIDENCE_ROLES as readonly string[]).includes(value);
}

export function graphFromRun(run: InvestigationRun): EvidenceGraph {
  return {
    evidence: run.evidence,
    relations: run.relations,
    claims: run.claims,
    claimEvidence: run.claimEvidence,
  };
}

export function isOptionalRequirement(requirement: EvidenceRequirement): boolean {
  if (requirement.optional === true) {
    return true;
  }
  if (requirement.optional === false) {
    return false;
  }
  return requirement.severity === "optional";
}

export function requirementKinds(requirement: EvidenceRequirement): EvidenceKind[] {
  if (requirement.acceptedKinds && requirement.acceptedKinds.length > 0) {
    return requirement.acceptedKinds;
  }
  if (requirement.condition === "resolution_code_evidence") {
    return [...CODE_EVIDENCE_KINDS];
  }
  return [requirement.kind];
}

/**
 * Create and validate an evidence→evidence edge.
 * Duplicate (from, to, type) returns the existing relation (deterministic).
 */
export function createEvidenceRelation(
  input: RelationInput,
  catalog: { evidence: Evidence[]; relations?: EvidenceRelation[] },
): EvidenceRelation {
  const fromEvidenceId = requireText(input.fromEvidenceId, "fromEvidenceId");
  const toEvidenceId = requireText(input.toEvidenceId, "toEvidenceId");
  if (fromEvidenceId === toEvidenceId) {
    throw new EvidenceGraphError(
      "self_relation",
      "Evidence relation cannot be a self-reference",
    );
  }
  if (!isEvidenceRelationType(input.type)) {
    throw new EvidenceGraphError(
      "invalid_relation_type",
      `Invalid evidence relation type: ${String(input.type)}`,
    );
  }
  const known = new Set(catalog.evidence.map((item) => item.id));
  if (!known.has(fromEvidenceId)) {
    throw new EvidenceGraphError(
      "invalid_evidence_id",
      `Unknown source evidence: ${fromEvidenceId}`,
    );
  }
  if (!known.has(toEvidenceId)) {
    throw new EvidenceGraphError(
      "invalid_evidence_id",
      `Unknown target evidence: ${toEvidenceId}`,
    );
  }
  const existing = catalog.relations?.find(
    (item) =>
      item.fromEvidenceId === fromEvidenceId &&
      item.toEvidenceId === toEvidenceId &&
      item.type === input.type,
  );
  if (existing) {
    return existing;
  }
  return {
    id: input.id?.trim() || randomUUID(),
    fromEvidenceId,
    toEvidenceId,
    type: input.type,
  };
}

/**
 * Bind a claim to existing evidence. Duplicate (claim, evidence, role) is reused.
 */
export function createClaimEvidenceBinding(
  input: ClaimEvidenceInput,
  catalog: { claims: Claim[]; evidence: Evidence[]; claimEvidence?: ClaimEvidence[] },
): ClaimEvidence {
  const claimId = requireText(input.claimId, "claimId");
  const evidenceId = requireText(input.evidenceId, "evidenceId");
  if (!isClaimEvidenceRole(input.role)) {
    throw new EvidenceGraphError("invalid_role", `Invalid claim-evidence role: ${String(input.role)}`);
  }
  if (!catalog.claims.some((item) => item.id === claimId)) {
    throw new EvidenceGraphError("invalid_claim_id", `Unknown claim: ${claimId}`);
  }
  if (!catalog.evidence.some((item) => item.id === evidenceId)) {
    throw new EvidenceGraphError(
      "invalid_claim_evidence",
      `ClaimEvidence references unknown evidence: ${evidenceId}`,
    );
  }
  const existing = catalog.claimEvidence?.find(
    (item) =>
      item.claimId === claimId && item.evidenceId === evidenceId && item.role === input.role,
  );
  if (existing) {
    return existing;
  }
  return { claimId, evidenceId, role: input.role };
}

export function relatedEvidence(
  graph: EvidenceGraph,
  evidenceId: string,
  options?: {
    direction?: "from" | "to" | "either";
    types?: readonly EvidenceRelationType[];
  },
): Evidence[] {
  const direction = options?.direction ?? "either";
  const types = options?.types ? new Set(options.types) : undefined;
  const ids = new Set<string>();
  for (const relation of graph.relations) {
    if (types && !types.has(relation.type)) {
      continue;
    }
    if ((direction === "from" || direction === "either") && relation.fromEvidenceId === evidenceId) {
      ids.add(relation.toEvidenceId);
    }
    if ((direction === "to" || direction === "either") && relation.toEvidenceId === evidenceId) {
      ids.add(relation.fromEvidenceId);
    }
  }
  return graph.evidence.filter((item) => ids.has(item.id));
}

export function hasRelation(
  graph: EvidenceGraph,
  fromEvidenceId: string,
  toEvidenceId: string,
  type?: EvidenceRelationType,
): boolean {
  return graph.relations.some(
    (item) =>
      item.fromEvidenceId === fromEvidenceId &&
      item.toEvidenceId === toEvidenceId &&
      (type === undefined || item.type === type),
  );
}

export function contradictingRelations(graph: EvidenceGraph): EvidenceRelation[] {
  return graph.relations.filter((item) => item.type === "contradicts");
}

export function targetIssueEvidence(graph: EvidenceGraph, task: InvestigationTask): Evidence[] {
  const expected = `${task.target.owner}/${task.target.repository}`;
  return graph.evidence.filter((item) => {
    const fact = issueFact(item);
    return Boolean(
      fact && fact.repository === expected && fact.number === task.target.issueNumber,
    );
  });
}

export function issueEvidenceItems(graph: EvidenceGraph): Evidence[] {
  return graph.evidence.filter((item) => item.kind === "issue");
}

/**
 * Resolution-candidate evidence: pull requests or commits with an explicit
 * graph edge to the target issue (fixes / references / supports).
 */
export function resolutionCandidateEvidence(
  graph: EvidenceGraph,
  task: InvestigationTask,
): Evidence[] {
  const issueIds = new Set(targetIssueEvidence(graph, task).map((item) => item.id));
  if (issueIds.size === 0) {
    return [];
  }
  const allowed = new Set<EvidenceRelationType>(RESOLUTION_CANDIDATE_RELATIONS);
  const candidateIds = new Set<string>();
  for (const relation of graph.relations) {
    if (!allowed.has(relation.type)) {
      continue;
    }
    if (issueIds.has(relation.toEvidenceId)) {
      candidateIds.add(relation.fromEvidenceId);
    }
    if (issueIds.has(relation.fromEvidenceId)) {
      candidateIds.add(relation.toEvidenceId);
    }
  }
  const expectedRepo = `${task.target.owner}/${task.target.repository}`;
  return graph.evidence.filter((item) => {
    if (!candidateIds.has(item.id) || (item.kind !== "pull_request" && item.kind !== "commit")) {
      return false;
    }
    if (item.kind === "pull_request") {
      const fact = pullFact(item);
      return !fact || fact.repository === expectedRepo || fact.repository === "";
    }
    const fact = commitFact(item);
    return !fact || fact.repository === expectedRepo || fact.repository === "";
  });
}

export function codeEvidenceFor(
  graph: EvidenceGraph,
  pullEvidenceIds: readonly string[],
): Evidence[] {
  const targets = new Set(pullEvidenceIds);
  if (targets.size === 0) {
    return [];
  }
  const allowed = new Set<EvidenceRelationType>(CODE_LINK_RELATIONS);
  const ids = new Set<string>();
  for (const relation of graph.relations) {
    if (!allowed.has(relation.type)) {
      continue;
    }
    if (targets.has(relation.toEvidenceId)) {
      ids.add(relation.fromEvidenceId);
    }
    if (targets.has(relation.fromEvidenceId)) {
      ids.add(relation.toEvidenceId);
    }
  }
  return graph.evidence.filter((item) => ids.has(item.id) && isCodeKind(item.kind));
}

function isCodeKind(kind: EvidenceKind): boolean {
  return (CODE_EVIDENCE_KINDS as readonly string[]).includes(kind);
}

export function mergeContradiction(
  graph: EvidenceGraph,
  candidates: Evidence[],
): { conflict: boolean; merged: Evidence[]; unmerged: Evidence[] } {
  const byNumber = new Map<number, { merged: Evidence[]; unmerged: Evidence[] }>();
  for (const item of candidates) {
    const fact = pullFact(item);
    if (!fact || typeof fact.merged !== "boolean") {
      continue;
    }
    const bucket = byNumber.get(fact.number) ?? { merged: [], unmerged: [] };
    if (fact.merged) {
      bucket.merged.push(item);
    } else {
      bucket.unmerged.push(item);
    }
    byNumber.set(fact.number, bucket);
  }

  let conflict = false;
  const merged: Evidence[] = [];
  const unmerged: Evidence[] = [];
  for (const bucket of byNumber.values()) {
    if (bucket.merged.length > 0 && bucket.unmerged.length > 0) {
      conflict = true;
    }
    merged.push(...bucket.merged);
    unmerged.push(...bucket.unmerged);
  }

  const candidateIds = new Set(candidates.map((item) => item.id));
  if (
    graph.relations.some(
      (item) =>
        item.type === "contradicts" &&
        candidateIds.has(item.fromEvidenceId) &&
        candidateIds.has(item.toEvidenceId),
    )
  ) {
    conflict = true;
  }

  return { conflict, merged, unmerged };
}

/**
 * Shared definition of a completion-relevant Claim: a critical Claim asserting
 * resolution (resolved/partial). Only these Claims require support checking for
 * completion. Their absence never blocks; non-critical or non-resolution Claims
 * never affect verified_complete.
 */
export function isCompletionRelevantClaim(claim: Claim): boolean {
  return claim.critical && (claim.polarity === "resolved" || claim.polarity === "partial");
}

export function claimSupportStatus(
  claimId: string,
  links: ClaimEvidence[],
  evidence: Evidence[],
): ClaimSupportStatus {
  const known = new Set(evidence.map((item) => item.id));
  const existing = links.filter((link) => link.claimId === claimId && known.has(link.evidenceId));
  const contradicted = existing.some((link) => link.role === "contradicts");
  const supported = existing.some((link) => link.role === "supports");
  if (contradicted) {
    return "contradicted";
  }
  if (supported) {
    return "supported";
  }
  return "unsupported";
}
