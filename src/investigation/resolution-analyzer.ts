/**
 * Phase 10.0 — Candidate Resolution Evidence Analysis.
 *
 * Produces Resolution Claims and supporting evidence signals.
 * Never decides that an issue is solved. Never produces VERIFIED_COMPLETE.
 * Structured signal status is assigned by this module, not by LLM prose.
 */
import { contentTokens, identifierTokens } from "../domain/resolution-alignment.js";
import type {
  Evidence,
  EvidenceReference,
  EvidenceTrust,
  InvestigationRun,
  ResolutionAlignmentStatus,
  ResolutionAnalysis,
  ResolutionOverallStatus,
  ResolutionSignal,
  TestEvidenceStatus,
} from "../domain/types.js";
import { fileChangeFromEvidence, isTestFilePath } from "./resolution-files.js";

const COMPLETION_CLAIM =
  /\bverified_complete\b|the (?:pr|pull request|commit|patch) fixed the issue|issue (?:is )?(?:definitely )?(?:fixed|solved)|mark (?:the issue )?verified/i;

export const RESOLUTION_ANALYZER_NOTICE =
  "Resolution Analyzer produces investigation claims only. Signals are not verification and cannot become VERIFIED_COMPLETE.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function normalizeCompact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function uniqueIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function issueText(issue: Evidence): string {
  const payload = isRecord(issue.payload) ? issue.payload : {};
  return [stringField(payload, "title") || issue.summary, stringField(payload, "body")].join("\n");
}

function candidateTitle(candidate: Evidence): string {
  const payload = isRecord(candidate.payload) ? candidate.payload : {};
  return stringField(payload, "title") || candidate.summary;
}

function pathTokens(filename: string): string[] {
  const normalized = filename.replaceAll("\\", "/");
  const spaced = normalized.replaceAll("/", " ").replaceAll(".", " ");
  const segments = normalized
    .split(/[^A-Za-z0-9]+/)
    .map((item) => item.toLowerCase())
    .filter((item) => item.length >= 4);
  return [...new Set([...segments, ...contentTokens(spaced), ...identifierTokens(spaced)])];
}

function tokensOverlap(left: string[], right: string[]): string[] {
  const rightCompact = right.map((item) => normalizeCompact(item));
  return left.filter((token) => {
    const compact = normalizeCompact(token);
    return right.some(
      (other, index) =>
        token === other ||
        token.startsWith(other) ||
        other.startsWith(token) ||
        (compact.length >= 4 &&
          rightCompact[index] !== undefined &&
          (rightCompact[index].includes(compact) || compact.includes(rightCompact[index]))),
    );
  });
}

function sanitizeExplanation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || COMPLETION_CLAIM.test(trimmed)) {
    return "Observed evidence overlap only. This is not proof that the issue is resolved.";
  }
  return trimmed;
}

function referenceOf(evidence: Evidence, role: EvidenceReference["role"]): EvidenceReference {
  return {
    evidenceId: evidence.id,
    role,
    trust: evidence.provenance.trust,
  };
}

function trustOf(run: InvestigationRun, id: string): EvidenceTrust | undefined {
  return run.evidence.find((item) => item.id === id)?.provenance.trust;
}

export function filesForCandidate(run: InvestigationRun, candidate: Evidence): Evidence[] {
  if (candidate.kind === "pull_request") {
    const pullNumber =
      candidate.contentRef?.startsWith("pr:") && !candidate.contentRef.startsWith("pr-merge:")
        ? Number(candidate.contentRef.slice(3))
        : isRecord(candidate.payload) && typeof candidate.payload.number === "number"
          ? candidate.payload.number
          : undefined;
    if (Number.isInteger(pullNumber) && (pullNumber ?? 0) > 0) {
      const prefix = `file:${pullNumber}:`;
      const resourcePrefix = `pull/${pullNumber}/`;
      return run.evidence.filter(
        (item) =>
          item.kind === "file" &&
          (item.contentRef?.startsWith(prefix) ||
            (typeof item.provenance.resource === "string" &&
              item.provenance.resource.startsWith(resourcePrefix))),
      );
    }
  }
  if (candidate.kind === "commit") {
    const sha =
      (isRecord(candidate.payload) && typeof candidate.payload.sha === "string"
        ? candidate.payload.sha
        : candidate.contentRef?.startsWith("commit:")
          ? candidate.contentRef.slice(7)
          : "") || "";
    if (sha) {
      const prefix = `file:${sha}:`;
      return run.evidence.filter(
        (item) =>
          item.kind === "file" &&
          (item.contentRef?.startsWith(prefix) ||
            run.relations.some(
              (relation) =>
                relation.type === "derived_from" &&
                relation.fromEvidenceId === item.id &&
                relation.toEvidenceId === candidate.id,
            )),
      );
    }
  }
  return [];
}

function patchedFiles(files: Evidence[], exposePatch: boolean): Evidence[] {
  if (!exposePatch) {
    return [];
  }
  return files.filter((item) => Boolean(fileChangeFromEvidence(item)?.patch));
}

function patchText(files: Evidence[]): string {
  const lines: string[] = [];
  for (const file of files) {
    const change = fileChangeFromEvidence(file);
    if (!change?.patch) {
      continue;
    }
    for (const line of change.patch.split("\n")) {
      if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
        lines.push(line.slice(1));
      }
    }
  }
  return lines.join("\n");
}

function fileScopeAlignment(input: {
  issue: Evidence;
  candidate: Evidence;
  files: Evidence[];
}): ResolutionSignal {
  const evidenceIds = uniqueIds([input.issue.id, input.candidate.id, ...input.files.map((item) => item.id)]);
  if (input.files.length === 0) {
    return {
      type: "file_scope_alignment",
      status: "unknown",
      evidenceIds,
      explanation: sanitizeExplanation(
        "No file-change evidence is available, so file-scope alignment cannot be assessed.",
      ),
    };
  }

  const issueTerms = contentTokens(issueText(input.issue));
  const issueIds = identifierTokens(issueText(input.issue));
  const filenames = input.files
    .map((item) => fileChangeFromEvidence(item)?.filename ?? "")
    .filter(Boolean);
  const fileTerms = filenames.flatMap(pathTokens);
  const strong = [
    ...tokensOverlap(issueIds, fileTerms),
    ...issueTerms.filter((token) => filenames.some((name) => pathTokens(name).includes(token))),
  ];
  const weak = tokensOverlap(issueTerms, fileTerms).filter((token) => !strong.includes(token));
  const matched = [...new Set([...strong, ...weak])];

  let status: ResolutionAlignmentStatus = "unknown";
  if (strong.length > 0 || matched.length >= 2) {
    status = "supported";
  } else if (matched.length === 1) {
    status = "partial";
  }

  return {
    type: "file_scope_alignment",
    status,
    evidenceIds,
    explanation: sanitizeExplanation(
      status === "supported"
        ? `Changed files appear related to ${matched.slice(0, 4).join(", ")} in the issue description.`
        : status === "partial"
          ? `Changed files share limited tokens (${matched.join(", ")}) with the issue description.`
          : "Changed files do not share observable issue-domain tokens.",
    ),
  };
}

function patchIntentAlignment(input: {
  issue: Evidence;
  candidate: Evidence;
  files: Evidence[];
  exposePatch: boolean;
}): ResolutionSignal {
  const patched = patchedFiles(input.files, input.exposePatch);
  const evidenceIds = uniqueIds([
    input.issue.id,
    input.candidate.id,
    ...input.files.map((item) => item.id),
    ...patched.map((item) => item.id),
  ]);
  if (patched.length === 0) {
    return {
      type: "patch_intent_alignment",
      status: "unknown",
      evidenceIds,
      explanation: sanitizeExplanation(
        input.exposePatch
          ? "No bounded patch is available; patch intent cannot be assessed."
          : "Bounded patch was not exposed to analysis context; patch intent cannot be assessed.",
      ),
    };
  }

  const issueBody = issueText(input.issue);
  const issueTerms = contentTokens(issueBody);
  const issueIds = identifierTokens(issueBody);
  const patch = patchText(patched);
  const patchTerms = [...contentTokens(patch), ...identifierTokens(patch)];
  const titleTerms = contentTokens(candidateTitle(input.candidate));
  const patchMatches = [...tokensOverlap(issueIds, patchTerms), ...tokensOverlap(issueTerms, patchTerms)];
  const uniquePatch = [...new Set(patchMatches)];
  const titleOnly = tokensOverlap(issueTerms, titleTerms).filter((token) => !uniquePatch.includes(token));

  let status: ResolutionAlignmentStatus = "unknown";
  if (uniquePatch.length >= 2 || tokensOverlap(issueIds, patchTerms).length > 0) {
    status = "supported";
  } else if (uniquePatch.length === 1 || titleOnly.length > 0) {
    status = "partial";
  }

  return {
    type: "patch_intent_alignment",
    status,
    evidenceIds,
    explanation: sanitizeExplanation(
      status === "supported"
        ? "Bounded patch text shares issue-domain tokens. This is lexical overlap, not proof of a fix."
        : status === "partial"
          ? titleOnly.length > 0 && uniquePatch.length === 0
            ? "PR or commit title shares issue-domain tokens. Title text is not resolution proof."
            : "Bounded patch text shares limited issue-domain tokens. This is not proof of a fix."
          : "Bounded patch text does not share observable issue-domain tokens.",
    ),
  };
}

function testEvidenceSignal(input: {
  issue: Evidence;
  candidate: Evidence;
  files: Evidence[];
}): ResolutionSignal {
  const evidenceIds = uniqueIds([input.issue.id, input.candidate.id, ...input.files.map((item) => item.id)]);
  if (input.files.length === 0) {
    return {
      type: "test_evidence",
      status: "unknown",
      evidenceIds,
      explanation: sanitizeExplanation("No file-change evidence is available, so test-file presence is unknown."),
    };
  }

  const testFiles = input.files.filter((item) => {
    const filename = fileChangeFromEvidence(item)?.filename;
    return filename ? isTestFilePath(filename) : false;
  });
  const status: TestEvidenceStatus = testFiles.length > 0 ? "present" : "absent";
  return {
    type: "test_evidence",
    status,
    evidenceIds: uniqueIds([
      ...evidenceIds,
      ...testFiles.map((item) => item.id),
    ]),
    explanation: sanitizeExplanation(
      status === "present"
        ? `A test-file path was observed (${testFiles
            .map((item) => fileChangeFromEvidence(item)?.filename ?? item.id)
            .join(", ")}). This is path evidence, not a test execution result.`
        : "No test-file path was observed in the current file evidence. Absence is not evidence that verification did not occur.",
    ),
  };
}

function overallOf(signals: ResolutionSignal[]): ResolutionOverallStatus {
  const file = signals.find((item) => item.type === "file_scope_alignment")?.status;
  const patch = signals.find((item) => item.type === "patch_intent_alignment")?.status;
  const test = signals.find((item) => item.type === "test_evidence")?.status;
  if (file === "supported" && patch === "supported") {
    return "supported";
  }
  if (
    file === "supported" ||
    file === "partial" ||
    patch === "supported" ||
    patch === "partial" ||
    test === "present"
  ) {
    return "partial";
  }
  return "unknown";
}

function provenanceOf(
  issue: Evidence,
  candidate: Evidence,
  files: Evidence[],
  patched: Evidence[],
): EvidenceReference[] {
  const seen = new Set<string>();
  const refs: EvidenceReference[] = [];
  const push = (ref: EvidenceReference) => {
    const key = `${ref.role}:${ref.evidenceId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push(ref);
  };
  push(referenceOf(issue, "issue"));
  push(referenceOf(candidate, "candidate"));
  for (const file of files) {
    push(referenceOf(file, "file_change"));
  }
  for (const file of patched) {
    push(referenceOf(file, "patch"));
  }
  return refs;
}

export function analyzeResolutionSignals(input: {
  run: InvestigationRun;
  candidate: Evidence;
  issue: Evidence;
  exposePatch?: boolean;
}): {
  signals: ResolutionSignal[];
  overall: ResolutionOverallStatus;
  provenance: EvidenceReference[];
} {
  const exposePatch = input.exposePatch !== false;
  const files = filesForCandidate(input.run, input.candidate);
  const patched = patchedFiles(files, exposePatch);
  const signals = [
    fileScopeAlignment({ issue: input.issue, candidate: input.candidate, files }),
    patchIntentAlignment({
      issue: input.issue,
      candidate: input.candidate,
      files,
      exposePatch,
    }),
    testEvidenceSignal({ issue: input.issue, candidate: input.candidate, files }),
  ];
  return {
    signals,
    overall: overallOf(signals),
    provenance: provenanceOf(input.issue, input.candidate, files, patched),
  };
}

export function attachResolutionSignals(
  run: InvestigationRun,
  analysis: ResolutionAnalysis,
  options?: { exposePatch?: boolean },
): ResolutionAnalysis {
  const candidate = run.evidence.find((item) => item.id === analysis.candidateEvidenceId);
  const issue = run.evidence.find((item) => item.id === analysis.issueEvidenceId);
  if (!candidate || !issue) {
    return {
      ...analysis,
      candidateId: analysis.candidateId || analysis.candidateEvidenceId,
      signals: analysis.signals?.length
        ? analysis.signals
        : [
            {
              type: "file_scope_alignment",
              status: "unknown",
              evidenceIds: uniqueIds([analysis.candidateEvidenceId, analysis.issueEvidenceId]),
              explanation: sanitizeExplanation("Candidate or issue evidence is missing from the current run."),
            },
            {
              type: "patch_intent_alignment",
              status: "unknown",
              evidenceIds: uniqueIds([analysis.candidateEvidenceId, analysis.issueEvidenceId]),
              explanation: sanitizeExplanation("Candidate or issue evidence is missing from the current run."),
            },
            {
              type: "test_evidence",
              status: "unknown",
              evidenceIds: uniqueIds([analysis.candidateEvidenceId, analysis.issueEvidenceId]),
              explanation: sanitizeExplanation("Candidate or issue evidence is missing from the current run."),
            },
          ],
      overall: "unknown",
      provenance: [
        ...(analysis.issueEvidenceId
          ? [{ evidenceId: analysis.issueEvidenceId, role: "issue" as const, trust: trustOf(run, analysis.issueEvidenceId) }]
          : []),
        ...(analysis.candidateEvidenceId
          ? [
              {
                evidenceId: analysis.candidateEvidenceId,
                role: "candidate" as const,
                trust: trustOf(run, analysis.candidateEvidenceId),
              },
            ]
          : []),
      ],
    };
  }
  const analyzed = analyzeResolutionSignals({
    run,
    candidate,
    issue,
    exposePatch: options?.exposePatch,
  });
  return {
    ...analysis,
    candidateId: analysis.candidateId || candidate.id,
    signals: analyzed.signals,
    overall: analyzed.overall,
    provenance: analyzed.provenance,
  };
}

/**
 * Resolution Analyzer. Investigation-claim producer only.
 * IndependentCompletionVerifier remains the only completion authority.
 */
export class ResolutionAnalyzer {
  analyze(
    run: InvestigationRun,
    options?: { exposePatch?: boolean },
  ): ResolutionAnalysis[] {
    return (run.resolutionAnalyses ?? []).map((analysis) =>
      attachResolutionSignals(run, analysis, options),
    );
  }

  analyzeCandidate(
    run: InvestigationRun,
    candidate: Evidence,
    issue: Evidence,
    options?: { exposePatch?: boolean },
  ): {
    signals: ResolutionSignal[];
    overall: ResolutionOverallStatus;
    provenance: EvidenceReference[];
  } {
    return analyzeResolutionSignals({ run, candidate, issue, exposePatch: options?.exposePatch });
  }
}
