/**
 * Phase 10.1-shaped Resolution Chain builder.
 *
 * Derives a structured Resolution Explanation from Evidence Graph +
 * Resolution Analyzer signals. Does not decide that an issue is solved.
 */
import type {
  Evidence,
  EvidenceGraph,
  InvestigationRun,
  ResolutionAnalysis,
  ResolutionChain,
  ResolutionChainNodeStatus,
} from "../domain/index.js";
import { graphFromRun } from "../domain/index.js";
import { INSUFFICIENT_CODE_CHANGE_CONTEXT } from "./resolution-analysis.js";
import { filesForCandidate } from "./resolution-analyzer.js";
import { fileChangeFromEvidence, hasBoundedPatch, isTestFilePath } from "./resolution-files.js";

function uniqueIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function knownIds(graph: EvidenceGraph, ids: string[]): string[] {
  const known = new Set(graph.evidence.map((item) => item.id));
  return uniqueIds(ids.filter((id) => known.has(id)));
}

function nodeStatus(evidenceIds: string[]): ResolutionChainNodeStatus {
  return evidenceIds.length > 0 ? "observed" : "unknown";
}

function asRun(graph: EvidenceGraph): InvestigationRun {
  return {
    evidence: graph.evidence,
    relations: graph.relations,
  } as InvestigationRun;
}

function issueOf(graph: EvidenceGraph, analysis?: ResolutionAnalysis): Evidence | undefined {
  if (analysis) {
    return graph.evidence.find((item) => item.id === analysis.issueEvidenceId);
  }
  return graph.evidence.find((item) => item.kind === "issue");
}

function candidateOf(graph: EvidenceGraph, analysis?: ResolutionAnalysis): Evidence | undefined {
  if (analysis) {
    return graph.evidence.find((item) => item.id === analysis.candidateEvidenceId);
  }
  return graph.evidence.find(
    (item) =>
      (item.kind === "pull_request" && item.contentRef?.startsWith("pr:") && !item.contentRef.startsWith("pr-merge:")) ||
      item.kind === "commit",
  );
}

function patchedFiles(files: Evidence[]): Evidence[] {
  return files.filter((item) => hasBoundedPatch(item));
}

function testArtifactFiles(files: Evidence[]): Evidence[] {
  return files.filter((item) => {
    const filename = fileChangeFromEvidence(item)?.filename;
    return filename ? isTestFilePath(filename) : false;
  });
}

function behaviorHypothesisPresent(analysis: ResolutionAnalysis | undefined): boolean {
  const text = analysis?.behavioralAlignment?.trim() ?? "";
  if (!text) {
    return false;
  }
  if (text === INSUFFICIENT_CODE_CHANGE_CONTEXT) {
    return false;
  }
  return !/insufficient code-change context/i.test(text);
}

/**
 * Build one Resolution Chain for a candidate. Presence nodes use observed/unknown
 * only. Missing patch is never encoded as unsupported or absent.
 */
export function buildResolutionChain(input: {
  graph: EvidenceGraph;
  analysis?: ResolutionAnalysis;
  issue?: Evidence;
  candidate?: Evidence;
}): ResolutionChain {
  const issue = input.issue ?? issueOf(input.graph, input.analysis);
  const candidate = input.candidate ?? candidateOf(input.graph, input.analysis);
  const files = candidate ? filesForCandidate(asRun(input.graph), candidate) : [];
  const patched = patchedFiles(files);
  const tests = testArtifactFiles(files);
  const issueIds = knownIds(input.graph, uniqueIds([issue?.id, input.analysis?.issueEvidenceId]));
  const candidateIds = knownIds(
    input.graph,
    uniqueIds([candidate?.id, input.analysis?.candidateEvidenceId, input.analysis?.candidateId]),
  );
  const fileIds = knownIds(input.graph, files.map((item) => item.id));
  const patchIds = knownIds(input.graph, patched.map((item) => item.id));
  const testIds = knownIds(input.graph, tests.map((item) => item.id));
  const fileScope = input.analysis?.signals.find((item) => item.type === "file_scope_alignment");
  const alignmentIds = knownIds(
    input.graph,
    uniqueIds([...(fileScope?.evidenceIds ?? []), ...issueIds, ...candidateIds, ...fileIds]),
  );

  return {
    candidateId: candidate?.id ?? input.analysis?.candidateId ?? input.analysis?.candidateEvidenceId ?? "",
    issue: { status: nodeStatus(issueIds), evidenceIds: issueIds },
    candidate: { status: nodeStatus(candidateIds), evidenceIds: candidateIds },
    affected_area: { status: nodeStatus(fileIds), evidenceIds: fileIds },
    code_change: { status: nodeStatus(patchIds), evidenceIds: patchIds },
    validation:
      fileIds.length === 0
        ? { status: "unknown", evidenceIds: knownIds(input.graph, uniqueIds([...issueIds, ...candidateIds])) }
        : tests.length > 0
          ? { status: "present", evidenceIds: testIds }
          : { status: "absent", evidenceIds: knownIds(input.graph, uniqueIds([...issueIds, ...candidateIds, ...fileIds])) },
    alignment: {
      status: fileScope?.status === "supported" || fileScope?.status === "partial" ? fileScope.status : "unknown",
      evidenceIds: alignmentIds,
    },
    behaviorHypothesis: {
      present: behaviorHypothesisPresent(input.analysis),
      evidenceIds: knownIds(input.graph, uniqueIds([...(input.analysis?.supportingEvidenceIds ?? []), ...issueIds, ...candidateIds])),
    },
    overall: input.analysis?.overall ?? "unknown",
  };
}

export function buildResolutionChains(run: InvestigationRun, graph: EvidenceGraph = graphFromRun(run)): ResolutionChain[] {
  const analyses = run.resolutionAnalyses ?? [];
  if (analyses.length > 0) {
    return analyses.map((analysis) => buildResolutionChain({ graph, analysis }));
  }
  const issue = issueOf(graph);
  if (!issue) {
    return [];
  }
  const candidate = candidateOf(graph);
  return [buildResolutionChain({ graph, issue, candidate })];
}
