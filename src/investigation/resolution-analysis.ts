/**
 * Agent-side Resolution Analysis from bounded PR patches.
 * Produces investigation hypotheses only. Never a completion verdict.
 */
import { createResolutionAnalysis, type Evidence, type InvestigationRun, type ResolutionAnalysis } from "../domain/index.js";

export const INSUFFICIENT_CODE_CHANGE_CONTEXT = "insufficient code-change context";

export const TEST_SUPPORT_NOT_OBSERVED =
  "Current observed PR file evidence does not include an obvious test-file change (not observed / unknown). Absence from this snapshot is not evidence that tests are missing.";

const TEST_FILE_PATTERN = /(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)spec\/|\.spec\.|\.test\./i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTestFilePath(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename.replaceAll("\\", "/"));
}

export function fileChangeFromEvidence(evidence: Evidence): {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patchTruncated?: boolean;
} | undefined {
  if (evidence.kind !== "file" || !isRecord(evidence.payload)) {
    return undefined;
  }
  const filename = typeof evidence.payload.filename === "string" ? evidence.payload.filename : "";
  if (!filename) {
    return undefined;
  }
  return {
    filename,
    status: typeof evidence.payload.status === "string" ? evidence.payload.status : "modified",
    additions: typeof evidence.payload.additions === "number" ? evidence.payload.additions : 0,
    deletions: typeof evidence.payload.deletions === "number" ? evidence.payload.deletions : 0,
    patch: typeof evidence.payload.patch === "string" && evidence.payload.patch.length > 0
      ? evidence.payload.patch
      : undefined,
    patchTruncated: evidence.payload.patchTruncated === true,
  };
}

export function hasBoundedPatch(evidence: Evidence): boolean {
  return Boolean(fileChangeFromEvidence(evidence)?.patch);
}

function knownEvidenceIds(run: InvestigationRun): Set<string> {
  return new Set(run.evidence.map((item) => item.id));
}

function knownClaimIds(run: InvestigationRun): Set<string> {
  return new Set(run.claims.map((item) => item.id));
}

export function existingEvidenceIds(run: InvestigationRun, ids: string[]): {
  known: string[];
  missing: string[];
} {
  const known = knownEvidenceIds(run);
  const seen = new Set<string>();
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (known.has(id)) {
      present.push(id);
    } else {
      missing.push(id);
    }
  }
  return { known: present, missing };
}

export function existingClaimIds(run: InvestigationRun, ids: string[]): string[] {
  const known = knownClaimIds(run);
  return [...new Set(ids.filter((id) => known.has(id)))];
}

function issueEvidence(run: InvestigationRun): Evidence | undefined {
  return run.evidence.find((item) => item.kind === "issue");
}

function pullCandidates(run: InvestigationRun): Evidence[] {
  return run.evidence.filter(
    (item) => item.kind === "pull_request" && item.contentRef?.startsWith("pr:") && !item.contentRef.startsWith("pr-merge:"),
  );
}

function mergeFactForPull(run: InvestigationRun, pullNumber: number): Evidence | undefined {
  return run.evidence.find((item) => item.contentRef === `pr-merge:${pullNumber}`);
}

function pullNumberOf(evidence: Evidence): number | undefined {
  if (evidence.contentRef?.startsWith("pr:") && !evidence.contentRef.startsWith("pr-merge:")) {
    const value = Number(evidence.contentRef.slice(3));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (isRecord(evidence.payload) && typeof evidence.payload.number === "number") {
    return evidence.payload.number;
  }
  return undefined;
}

function filesForPull(run: InvestigationRun, pullNumber: number): Evidence[] {
  const prefix = `file:${pullNumber}:`;
  const resourcePrefix = `pull/${pullNumber}/`;
  return run.evidence.filter(
    (item) =>
      item.kind === "file" &&
      (item.contentRef?.startsWith(prefix) ||
        (typeof item.provenance.resource === "string" && item.provenance.resource.startsWith(resourcePrefix))),
  );
}

function mergeCommitSha(run: InvestigationRun, candidate: Evidence): string | undefined {
  const fromCandidate =
    isRecord(candidate.payload) && typeof candidate.payload.mergeCommitSha === "string"
      ? candidate.payload.mergeCommitSha.trim()
      : "";
  if (fromCandidate) {
    return fromCandidate;
  }
  const pullNumber = pullNumberOf(candidate);
  if (!pullNumber) {
    return undefined;
  }
  const merge = mergeFactForPull(run, pullNumber);
  if (merge && isRecord(merge.payload) && typeof merge.payload.mergeCommitSha === "string") {
    const sha = merge.payload.mergeCommitSha.trim();
    return sha || undefined;
  }
  return undefined;
}

function observedAddedLines(patch: string, limit = 4): string[] {
  const lines: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    const text = line.slice(1).trim();
    if (!text) {
      continue;
    }
    lines.push(text.length > 160 ? `${text.slice(0, 160)}...` : text);
    if (lines.length >= limit) {
      break;
    }
  }
  return lines;
}

function issueLabel(issue: Evidence): string {
  if (isRecord(issue.payload) && typeof issue.payload.title === "string" && issue.payload.title.trim()) {
    return issue.payload.title.trim();
  }
  return issue.summary;
}

function observedFileFacts(files: Evidence[]): {
  facts: string[];
  patched: Evidence[];
  unpatched: Evidence[];
  testFiles: Evidence[];
} {
  const facts: string[] = [];
  const patched: Evidence[] = [];
  const unpatched: Evidence[] = [];
  const testFiles: Evidence[] = [];
  for (const file of files) {
    const change = fileChangeFromEvidence(file);
    if (!change) {
      continue;
    }
    if (isTestFilePath(change.filename)) {
      testFiles.push(file);
    }
    if (change.patch) {
      patched.push(file);
      const added = observedAddedLines(change.patch);
      facts.push(
        `${change.filename} ${change.status} +${change.additions}/-${change.deletions}; bounded patch observed` +
          (change.patchTruncated ? " (truncated)" : "") +
          (added.length > 0 ? `; added lines include ${added.map((line) => `\`${line}\``).join("; ")}` : ""),
      );
    } else {
      unpatched.push(file);
      facts.push(
        `${change.filename} ${change.status} +${change.additions}/-${change.deletions}; no bounded patch on this file evidence`,
      );
    }
  }
  return { facts, patched, unpatched, testFiles };
}

function relatedClaimIds(run: InvestigationRun, supportingEvidenceIds: string[]): string[] {
  const support = new Set(supportingEvidenceIds);
  return existingClaimIds(
    run,
    run.claimEvidence.filter((link) => support.has(link.evidenceId)).map((link) => link.claimId),
  );
}

export function buildResolutionAnalysisForCandidate(
  run: InvestigationRun,
  input: {
    candidate: Evidence;
    issue: Evidence;
    authored?: Partial<Pick<ResolutionAnalysis, "codeRelevance" | "behavioralAlignment" | "testSupport" | "unresolvedQuestions" | "claimIds" | "mergeCommitSha">>;
  },
): ResolutionAnalysis {
  const pullNumber = pullNumberOf(input.candidate);
  const files = pullNumber ? filesForPull(run, pullNumber) : run.evidence.filter((item) => item.kind === "file");
  const observed = observedFileFacts(files);
  const supporting = existingEvidenceIds(run, [
    input.candidate.id,
    input.issue.id,
    ...files.map((item) => item.id),
    ...(pullNumber ? [mergeFactForPull(run, pullNumber)?.id].filter((id): id is string => Boolean(id)) : []),
  ]).known;
  const questions = [...(input.authored?.unresolvedQuestions ?? [])];
  const hasPatch = observed.patched.length > 0;

  if (!hasPatch) {
    questions.push("Current file evidence has no bounded patch; code-change context is insufficient.");
    questions.push("The current snapshot may lack necessary file diffs.");
  } else {
    questions.push("The observed diff cannot prove runtime behavior.");
    questions.push("No test execution results were observed.");
    if (observed.unpatched.length > 0) {
      questions.push("Some changed files have metadata only and no bounded patch.");
    }
  }

  const uniqueQuestions = [...new Set(questions.filter((item) => item.trim()))];
  const testSupport = input.authored?.testSupport
    ? input.authored.testSupport
    : observed.testFiles.length > 0
      ? `Observed facts: test-file change observed in ${observed.testFiles
          .map((item) => {
            const name = fileChangeFromEvidence(item)?.filename ?? item.summary;
            return `${name} (evidence ${item.id})`;
          })
          .join(", ")}. Inference: this is file-change evidence, not a test execution result.`
      : TEST_SUPPORT_NOT_OBSERVED;

  const codeRelevance = input.authored?.codeRelevance
    ? input.authored.codeRelevance
    : hasPatch
      ? `Observed facts: ${observed.facts.join(" | ")}. Inference: these observed code changes may relate to the issue evidence. This is a hypothesis, not verification.`
      : INSUFFICIENT_CODE_CHANGE_CONTEXT;

  const behavioralAlignment = input.authored?.behavioralAlignment
    ? input.authored.behavioralAlignment
    : hasPatch
      ? `Observed facts: issue evidence summary is "${issueLabel(input.issue)}"; patched files are ${observed.patched
          .map((item) => fileChangeFromEvidence(item)?.filename ?? item.id)
          .join(", ")}. Inference: the observed diff may correspond to the described problem. Runtime behavior remains unproven.`
      : INSUFFICIENT_CODE_CHANGE_CONTEXT;

  return createResolutionAnalysis({
    candidateEvidenceId: input.candidate.id,
    issueEvidenceId: input.issue.id,
    mergeCommitSha: input.authored?.mergeCommitSha ?? mergeCommitSha(run, input.candidate),
    codeRelevance,
    behavioralAlignment,
    testSupport,
    unresolvedQuestions: uniqueQuestions,
    supportingEvidenceIds: supporting,
    claimIds: existingClaimIds(run, [
      ...(input.authored?.claimIds ?? []),
      ...relatedClaimIds(run, supporting),
    ]),
  });
}

export function buildResolutionAnalyses(
  run: InvestigationRun,
  options?: { preserveCandidateIds?: Iterable<string> },
): ResolutionAnalysis[] {
  const issue = issueEvidence(run);
  const candidates = pullCandidates(run);
  if (!issue || candidates.length === 0) {
    return [];
  }
  const preserve = new Set(options?.preserveCandidateIds ?? []);
  const previous = new Map((run.resolutionAnalyses ?? []).map((item) => [item.candidateEvidenceId, item]));
  return candidates.map((candidate) => {
    if (preserve.has(candidate.id) && previous.has(candidate.id)) {
      const kept = previous.get(candidate.id);
      if (kept) {
        return {
          ...kept,
          supportingEvidenceIds: existingEvidenceIds(run, kept.supportingEvidenceIds).known,
          claimIds: existingClaimIds(run, [...kept.claimIds, ...relatedClaimIds(run, kept.supportingEvidenceIds)]),
        };
      }
    }
    return buildResolutionAnalysisForCandidate(run, { candidate, issue });
  });
}

export function attachClaimsToResolutionAnalyses(run: InvestigationRun): void {
  for (const analysis of run.resolutionAnalyses ?? []) {
    analysis.supportingEvidenceIds = existingEvidenceIds(run, analysis.supportingEvidenceIds).known;
    analysis.claimIds = existingClaimIds(run, [
      ...analysis.claimIds,
      ...relatedClaimIds(run, analysis.supportingEvidenceIds),
    ]);
  }
}

export function recordAuthoredResolutionAnalysis(
  run: InvestigationRun,
  draft: {
    candidateEvidenceId: string;
    issueEvidenceId: string;
    mergeCommitSha?: string;
    codeRelevance: string;
    behavioralAlignment: string;
    testSupport: string;
    unresolvedQuestions?: string[];
    supportingEvidenceIds?: string[];
    claimIds?: string[];
  },
): { analysis?: ResolutionAnalysis; unresolvedQuestions: string[] } {
  const questions = [...(draft.unresolvedQuestions ?? [])];
  const candidate = run.evidence.find((item) => item.id === draft.candidateEvidenceId);
  const issueItem = run.evidence.find((item) => item.id === draft.issueEvidenceId);

  if (!candidate) {
    questions.push(`No Evidence in this InvestigationRun matches candidateEvidenceId.`);
  }
  if (!issueItem) {
    questions.push(`No Evidence in this InvestigationRun matches issueEvidenceId.`);
  }
  const support = existingEvidenceIds(run, draft.supportingEvidenceIds ?? []);
  for (const id of support.missing) {
    questions.push(`supportingEvidenceIds omitted unknown id ${id}; GitHub URLs cannot replace Evidence IDs.`);
  }
  const claims = existingClaimIds(run, draft.claimIds ?? []);
  if ((draft.claimIds ?? []).some((id) => !claims.includes(id))) {
    questions.push("claimIds omitted IDs that are not in the current InvestigationRun.");
  }

  if (!candidate || !issueItem) {
    return { unresolvedQuestions: [...new Set(questions)] };
  }

  const analysis = createResolutionAnalysis({
    candidateEvidenceId: candidate.id,
    issueEvidenceId: issueItem.id,
    mergeCommitSha: draft.mergeCommitSha?.trim() || mergeCommitSha(run, candidate),
    codeRelevance: draft.codeRelevance.trim() || INSUFFICIENT_CODE_CHANGE_CONTEXT,
    behavioralAlignment: draft.behavioralAlignment.trim() || INSUFFICIENT_CODE_CHANGE_CONTEXT,
    testSupport: draft.testSupport.trim() || TEST_SUPPORT_NOT_OBSERVED,
    unresolvedQuestions: [...new Set(questions)],
    supportingEvidenceIds: support.known.length > 0
      ? support.known
      : existingEvidenceIds(run, [candidate.id, issueItem.id]).known,
    claimIds: claims,
  });
  return { analysis, unresolvedQuestions: analysis.unresolvedQuestions };
}

export function upsertResolutionAnalysis(run: InvestigationRun, analysis: ResolutionAnalysis): ResolutionAnalysis {
  const list = run.resolutionAnalyses ?? (run.resolutionAnalyses = []);
  const index = list.findIndex((item) => item.candidateEvidenceId === analysis.candidateEvidenceId);
  if (index >= 0) {
    list[index] = analysis;
  } else {
    list.push(analysis);
  }
  return analysis;
}
