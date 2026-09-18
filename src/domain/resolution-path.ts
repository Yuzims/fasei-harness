/**
 * Unified resolution candidates.
 *
 * A landed GitHub resolution may be a merged PR or a direct commit that
 * references the target issue. IndependentCompletionVerifier evaluates both
 * through the same EvidenceRequirement conditions.
 */
import {
  CODE_LINK_RELATIONS,
  mergeContradiction,
  resolutionCandidateEvidence,
  type EvidenceGraph,
} from "./evidence-graph.js";
import { commitFact, isCodeEvidence, pullFact, type CommitFact, type PullFact } from "./evidence-facts.js";
import type { Evidence, EvidenceRelationType, InvestigationTask } from "./types.js";

export const RESOLUTION_PATHS = ["pr_merge", "direct_commit"] as const;
export type ResolutionPathKind = (typeof RESOLUTION_PATHS)[number];

export interface ResolutionCandidate {
  evidence: Evidence;
  path: ResolutionPathKind;
  pull?: PullFact;
  commit?: CommitFact;
}

export function asResolutionCandidate(item: Evidence): ResolutionCandidate | undefined {
  if (item.kind === "pull_request") {
    return { evidence: item, path: "pr_merge", pull: pullFact(item) };
  }
  if (item.kind === "commit") {
    return { evidence: item, path: "direct_commit", commit: commitFact(item) };
  }
  return undefined;
}

export function resolveResolutionCandidates(
  graph: EvidenceGraph,
  task: InvestigationTask,
): ResolutionCandidate[] {
  return resolutionCandidateEvidence(graph, task)
    .map(asResolutionCandidate)
    .filter((item): item is ResolutionCandidate => Boolean(item));
}

function prLanded(graph: EvidenceGraph, candidate: ResolutionCandidate): boolean {
  if (candidate.path !== "pr_merge") {
    return false;
  }
  if (candidate.pull?.merged === true) {
    return true;
  }
  return graph.relations.some(
    (relation) =>
      relation.type === "merges" &&
      (relation.toEvidenceId === candidate.evidence.id ||
        relation.fromEvidenceId === candidate.evidence.id),
  );
}

function commitLanded(candidate: ResolutionCandidate): boolean {
  return candidate.path === "direct_commit" && Boolean(candidate.commit?.sha);
}

export function landedResolutionCandidates(
  graph: EvidenceGraph,
  task: InvestigationTask,
): ResolutionCandidate[] {
  const candidates = resolveResolutionCandidates(graph, task);
  const pulls = candidates.filter((item) => item.path === "pr_merge").map((item) => item.evidence);
  const contradiction = mergeContradiction(graph, pulls);
  if (contradiction.conflict) {
    return [];
  }
  return candidates.filter((item) => prLanded(graph, item) || commitLanded(item));
}

export function codeEvidenceForCandidates(
  graph: EvidenceGraph,
  candidates: readonly ResolutionCandidate[],
): Evidence[] {
  const byId = new Map<string, Evidence>();
  const targets = new Set(candidates.map((item) => item.evidence.id));
  const allowed = new Set<EvidenceRelationType>(CODE_LINK_RELATIONS);
  const linked = new Set<string>();
  for (const relation of graph.relations) {
    if (!allowed.has(relation.type)) {
      continue;
    }
    if (targets.has(relation.toEvidenceId)) {
      linked.add(relation.fromEvidenceId);
    }
    if (targets.has(relation.fromEvidenceId)) {
      linked.add(relation.toEvidenceId);
    }
  }
  for (const item of graph.evidence) {
    if (linked.has(item.id) && isCodeEvidence(item)) {
      byId.set(item.id, item);
    }
  }
  for (const candidate of candidates) {
    if (candidate.path === "direct_commit" && isCodeEvidence(candidate.evidence)) {
      byId.set(candidate.evidence.id, candidate.evidence);
    }
  }
  return [...byId.values()];
}

export function closingKeywordReferencesIssue(text: string, issueNumber: number): boolean {
  if (!text.trim() || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  const pattern = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:https?://github\\.com/[^/\\s]+/[^/\\s]+/(?:issues|pull)/|#)${issueNumber}\\b`,
    "i",
  );
  return pattern.test(text);
}
