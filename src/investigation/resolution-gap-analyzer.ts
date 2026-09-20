/**
 * Phase 10.2 — Resolution Gap Analyzer.
 *
 * Failure Localization + Recovery Signal only.
 * Not a verifier. Does not decide that an issue is solved or that a PR is valid.
 * Gap type is assigned by deterministic rules, never by LLM prose.
 */
import type {
  EvidenceGraph,
  InvestigationRun,
  ResolutionChain,
  ResolutionGap,
  ResolutionGapRecommendedAction,
  ResolutionGapSeverity,
  ResolutionGapType,
} from "../domain/index.js";
import { graphFromRun } from "../domain/index.js";
import { buildResolutionChains } from "./resolution-chain.js";

export const RESOLUTION_GAP_ANALYZER_NOTICE =
  "Resolution Gap Analyzer localizes missing resolution evidence. It is not verification and cannot become VERIFIED_COMPLETE.";

const ABSENT_CLAIM =
  /\bno code change happened\b|\bno tests exist\b|\bno tests?\b exist|\bcode_change unsupported\b|\bverified_complete\b/i;

const RECOMMENDED_ACTIONS: Record<ResolutionGapType, ResolutionGapRecommendedAction[]> = {
  missing_candidate: ["search_resolution_candidates"],
  missing_file_evidence: ["inspect_changed_files"],
  missing_patch_evidence: ["fetch_commit_patch", "inspect_changed_files"],
  missing_validation_evidence: ["search_regression_tests"],
  insufficient_resolution_context: ["inspect_changed_files", "fetch_commit_patch"],
  weak_issue_change_alignment: ["inspect_issue_change_alignment", "inspect_changed_files"],
};

function uniqueIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function knownIds(graph: EvidenceGraph, ids: string[]): string[] {
  const known = new Set(graph.evidence.map((item) => item.id));
  return uniqueIds(ids.filter((id) => known.has(id)));
}

function sanitizeExplanation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || ABSENT_CLAIM.test(trimmed)) {
    return "Observed evidence is insufficient for further resolution analysis. Unknown is not absence.";
  }
  return trimmed;
}

function cite(graph: EvidenceGraph, chain: ResolutionChain, extra: string[] = []): string[] {
  return knownIds(graph, uniqueIds([
    ...chain.issue.evidenceIds,
    ...chain.candidate.evidenceIds,
    ...chain.affected_area.evidenceIds,
    ...chain.code_change.evidenceIds,
    ...chain.validation.evidenceIds,
    ...extra,
  ]));
}

function gap(input: {
  graph: EvidenceGraph;
  chain: ResolutionChain;
  type: ResolutionGapType;
  severity: ResolutionGapSeverity;
  missingEvidenceTypes: string[];
  explanation: string;
  extraEvidenceIds?: string[];
}): ResolutionGap | undefined {
  const evidenceIds = cite(input.graph, input.chain, input.extraEvidenceIds);
  if (evidenceIds.length === 0) {
    return undefined;
  }
  return {
    candidateId: input.chain.candidateId,
    type: input.type,
    severity: input.severity,
    missingEvidenceTypes: [...input.missingEvidenceTypes],
    evidenceIds,
    explanation: sanitizeExplanation(input.explanation),
    recommendedActions: [...RECOMMENDED_ACTIONS[input.type]],
  };
}

/**
 * Rule 1 severity: blocking when the candidate-issue relationship cannot be
 * analyzed further; warning when file-scope explanation already exists.
 */
function missingPatchSeverity(chain: ResolutionChain): ResolutionGapSeverity {
  if (chain.overall === "supported" || chain.overall === "partial" || chain.alignment.status === "supported") {
    return "warning";
  }
  return "blocking";
}

function push(gaps: ResolutionGap[], item: ResolutionGap | undefined): void {
  if (item) {
    gaps.push(item);
  }
}

/**
 * Deterministic Resolution Gap detection.
 * Reads Resolution Chain statuses and Evidence Graph nodes. Ignores Evidence.trust.
 */
export function analyzeResolutionGaps(
  resolutionChain: ResolutionChain,
  evidenceGraph: EvidenceGraph,
): ResolutionGap[] {
  const chain = resolutionChain;
  const graph = evidenceGraph;
  const gaps: ResolutionGap[] = [];
  const issueObserved = chain.issue.status === "observed";
  const candidateObserved = chain.candidate.status === "observed";
  const filesObserved = chain.affected_area.status === "observed";
  const patchObserved = chain.code_change.status === "observed";

  if (issueObserved && !candidateObserved) {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "missing_candidate",
        severity: "blocking",
        missingEvidenceTypes: ["candidate"],
        explanation: "Issue evidence exists, but no resolution candidate evidence was observed.",
      }),
    );
    return gaps;
  }

  // Rule 4 — issue + candidate, no file, no patch.
  if (issueObserved && candidateObserved && !filesObserved && !patchObserved) {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "insufficient_resolution_context",
        severity: "blocking",
        missingEvidenceTypes: ["file", "patch"],
        explanation:
          "Issue and candidate evidence exist, but file and patch evidence were not observed, so resolution context is insufficient.",
      }),
    );
    return gaps;
  }

  // Rule 1 — missing patch. unknown != absent; never claim "no code change happened".
  if (candidateObserved && chain.code_change.status === "unknown") {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "missing_patch_evidence",
        severity: missingPatchSeverity(chain),
        missingEvidenceTypes: ["patch"],
        extraEvidenceIds: chain.affected_area.evidenceIds,
        explanation:
          "Code change evidence is unavailable, so the relationship between the candidate and the reported issue cannot be further analyzed.",
      }),
    );
  }

  // Rule 3 — missing file evidence.
  if (candidateObserved && chain.affected_area.status === "unknown") {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "missing_file_evidence",
        severity: "blocking",
        missingEvidenceTypes: ["file"],
        explanation: "File-change evidence was not observed, so the affected area cannot be assessed.",
      }),
    );
  }

  // Rule 2 — missing validation. unknown != "no tests exist".
  if (candidateObserved && chain.validation.status === "unknown") {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "missing_validation_evidence",
        severity: "warning",
        missingEvidenceTypes: ["test"],
        explanation: "Validation evidence was not observed.",
      }),
    );
  }

  // Rule 5 — weak issue/change alignment without a behavior hypothesis.
  if (
    candidateObserved &&
    filesObserved &&
    chain.alignment.status === "partial" &&
    !chain.behaviorHypothesis.present
  ) {
    push(
      gaps,
      gap({
        graph,
        chain,
        type: "weak_issue_change_alignment",
        severity: "warning",
        missingEvidenceTypes: ["behavior_hypothesis"],
        extraEvidenceIds: chain.alignment.evidenceIds,
        explanation:
          "Issue and change evidence share only a weak relationship, and no behavior hypothesis is available.",
      }),
    );
  }

  return gaps;
}

export function analyzeResolutionGapsForRun(run: InvestigationRun, graph: EvidenceGraph = graphFromRun(run)): ResolutionGap[] {
  return buildResolutionChains(run, graph).flatMap((chain) => analyzeResolutionGaps(chain, graph));
}
