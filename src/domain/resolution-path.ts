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
  targetIssueEvidence,
  type EvidenceGraph,
} from "./evidence-graph.js";
import {
  commitFact,
  isCodeEvidence,
  issueFact,
  pullFact,
  type CommitFact,
  type PullFact,
} from "./evidence-facts.js";
import { corroboratedFixPullNumbers, refutedByTemporalOrder, type TemporalRefutation } from "./attribution.js";
import type {
  Evidence,
  EvidenceRelationType,
  InvestigationTask,
  ResolutionPrescanRecord,
} from "./types.js";

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

export interface ResolutionAdmissionOptions {
  prescan?: ResolutionPrescanRecord;
}

export interface RefutedResolutionCandidate {
  candidate: ResolutionCandidate;
  refutation: TemporalRefutation;
}

export interface ResolutionAdmission {
  landed: ResolutionCandidate[];
  /** Landed PRs mechanically refuted by the Phase 18-B temporal guard. */
  refuted: RefutedResolutionCandidate[];
  /**
   * Landed PRs rejected because the run has a prescan record and this PR
   * lacks the structured closing-issue corroboration it requires.
   */
  uncorroborated: ResolutionCandidate[];
  conflict: boolean;
}

/**
 * Phase 18-B admission for landed resolution paths.
 * - Temporal refutation (candidate predates the issue) always applies when
 *   both timestamps exist; it is a pure field comparison.
 * - Structured-corroboration gating applies only to runs carrying a prescan
 *   record; no-prescan runs keep the historical merged semantics.
 */
export function evaluateResolutionAdmission(
  graph: EvidenceGraph,
  task: InvestigationTask,
  options?: ResolutionAdmissionOptions,
): ResolutionAdmission {
  const candidates = resolveResolutionCandidates(graph, task);
  const pulls = candidates.filter((item) => item.path === "pr_merge").map((item) => item.evidence);
  const contradiction = mergeContradiction(graph, pulls);
  if (contradiction.conflict) {
    return { landed: [], refuted: [], uncorroborated: [], conflict: true };
  }
  const issue = targetIssueEvidence(graph, task).map(issueFact).find((item) => item);
  const prescan = options?.prescan;
  const corroborated = prescan ? corroboratedFixPullNumbers(prescan) : undefined;
  const landed: ResolutionCandidate[] = [];
  const refuted: RefutedResolutionCandidate[] = [];
  const uncorroborated: ResolutionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.path === "direct_commit") {
      if (commitLanded(candidate)) {
        landed.push(candidate);
      }
      continue;
    }
    if (!prLanded(graph, candidate)) {
      continue;
    }
    const refutation = candidate.pull ? refutedByTemporalOrder(candidate.pull, issue) : undefined;
    if (refutation) {
      refuted.push({ candidate, refutation });
      continue;
    }
    if (corroborated && !(candidate.pull && corroborated.has(candidate.pull.number))) {
      uncorroborated.push(candidate);
      continue;
    }
    landed.push(candidate);
  }
  return { landed, refuted, uncorroborated, conflict: false };
}

export function landedResolutionCandidates(
  graph: EvidenceGraph,
  task: InvestigationTask,
  options?: ResolutionAdmissionOptions,
): ResolutionCandidate[] {
  return evaluateResolutionAdmission(graph, task, options).landed;
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
