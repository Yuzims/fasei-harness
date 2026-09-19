/**
 * Phase 8.9 — Deterministic Resolution Analysis grounding checks.
 *
 * Proves only lexical / structural overlap between Analysis text and
 * observable Evidence (filenames, counts, patch identifiers, issue refs).
 * Does not prove semantic correctness, code correctness, or resolution correctness.
 */
import type { Evidence, ResolutionAnalysis } from "../domain/index.js";
import {
  fileChangeFromEvidence,
  hasBoundedPatch,
  isTestFilePath,
} from "../investigation/resolution-analysis.js";

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_.]{2,}/g;
const EVIDENCE_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SHORT_EVIDENCE_ID = /\bev-[a-z0-9][\w-]*/gi;

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "from",
  "this",
  "that",
  "with",
  "have",
  "has",
  "was",
  "were",
  "are",
  "not",
  "but",
  "return",
  "function",
  "export",
  "const",
  "let",
  "var",
  "new",
  "true",
  "false",
  "null",
  "undefined",
  "import",
  "typeof",
  "string",
  "number",
  "boolean",
  "observed",
  "facts",
  "inference",
  "hypothesis",
  "verification",
  "evidence",
  "issue",
  "pull",
  "request",
  "commit",
  "file",
  "files",
  "patch",
  "bounded",
  "current",
  "cannot",
  "prove",
  "runtime",
  "behavior",
  "test",
  "tests",
  "expect",
  "describe",
  "modified",
  "added",
  "deleted",
]);

export interface BoundedPatchView {
  filename: string;
  patch: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface ResolutionAnalysisGroundingInput {
  analysis: ResolutionAnalysis;
  evidence: Evidence[];
  fileEvidence?: Evidence[];
  boundedPatches?: BoundedPatchView[];
}

export interface ResolutionAnalysisGrounding {
  observedFactSignals: number;
  patchSignals: number;
  testSignals: number;
  issueReferenceSignals: number;
  grounded: boolean;
}

export function analysisCorpus(analysis: ResolutionAnalysis): string {
  return [
    analysis.codeRelevance,
    analysis.behavioralAlignment,
    analysis.testSupport,
    ...analysis.unresolvedQuestions,
  ].join("\n");
}

export function tokenizeObservableText(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const token = raw.trim().toLowerCase();
    if (token.length < 3 || STOP_TOKENS.has(token) || seen.has(token)) {
      return;
    }
    seen.add(token);
    tokens.push(token);
  };
  for (const match of text.matchAll(IDENTIFIER)) {
    const value = match[0];
    add(value);
    for (const part of value.split(/[._]/)) {
      add(part);
    }
    for (const part of value.split(/(?=[A-Z])/)) {
      add(part);
    }
  }
  return tokens;
}

function containsToken(haystack: string, token: string): boolean {
  if (token.length < 3) {
    return false;
  }
  const lower = haystack.toLowerCase();
  if (token.includes(".") || token.includes("_") || /[A-Z]/.test(token)) {
    return lower.includes(token.toLowerCase());
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

function countMatchingTokens(corpus: string, tokens: Iterable<string>): number {
  let count = 0;
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key) || STOP_TOKENS.has(key)) {
      continue;
    }
    seen.add(key);
    if (containsToken(corpus, token)) {
      count += 1;
    }
  }
  return count;
}

function fileViews(input: ResolutionAnalysisGroundingInput): Array<{
  filename: string;
  additions: number;
  deletions: number;
  status: string;
  patch?: string;
  testFile: boolean;
}> {
  const files = input.fileEvidence ?? input.evidence.filter((item) => item.kind === "file");
  const fromEvidence = files
    .map((item) => fileChangeFromEvidence(item))
    .filter((item): item is NonNullable<ReturnType<typeof fileChangeFromEvidence>> => Boolean(item))
    .map((item) => ({
      filename: item.filename,
      additions: item.additions,
      deletions: item.deletions,
      status: item.status,
      patch: item.patch,
      testFile: isTestFilePath(item.filename),
    }));
  const extra = (input.boundedPatches ?? []).map((item) => ({
    filename: item.filename,
    additions: item.additions ?? 0,
    deletions: item.deletions ?? 0,
    status: item.status ?? "modified",
    patch: item.patch,
    testFile: isTestFilePath(item.filename),
  }));
  const seen = new Set<string>();
  const merged: typeof fromEvidence = [];
  for (const item of [...fromEvidence, ...extra]) {
    const key = `${item.filename}::${item.patch ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function patchIdentifierTokens(patch: string): string[] {
  const tokens: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      tokens.push(...tokenizeObservableText(line.slice(1)));
    }
  }
  return tokens;
}

function issueReferenceTokens(evidence: Evidence[]): string[] {
  const tokens: string[] = [];
  for (const item of evidence.filter((entry) => entry.kind === "issue")) {
    tokens.push(...tokenizeObservableText(item.summary));
    const payload = item.payload;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (typeof record.title === "string") {
        tokens.push(...tokenizeObservableText(record.title));
      }
      if (typeof record.number === "number") {
        tokens.push(`#${record.number}`, String(record.number));
      }
    }
  }
  return tokens;
}

function metadataTokens(files: ReturnType<typeof fileViews>): string[] {
  const tokens: string[] = [];
  for (const file of files) {
    tokens.push(...tokenizeObservableText(file.filename));
    const base = file.filename.split("/").pop();
    if (base) {
      tokens.push(...tokenizeObservableText(base));
    }
    if (file.additions > 0) {
      tokens.push(`+${file.additions}`, String(file.additions));
    }
    if (file.deletions > 0) {
      tokens.push(`-${file.deletions}`, String(file.deletions));
    }
    tokens.push(file.status);
  }
  return tokens;
}

/**
 * Deterministic lexical / structural grounding. Not semantic correctness.
 */
export function evaluateResolutionAnalysisGrounding(
  input: ResolutionAnalysisGroundingInput,
): ResolutionAnalysisGrounding {
  const corpus = analysisCorpus(input.analysis);
  const files = fileViews(input);
  const patches = files.filter((item) => typeof item.patch === "string" && item.patch.length > 0);
  const testFiles = files.filter((item) => item.testFile);
  const knownIds = new Set(input.evidence.map((item) => item.id));

  const observedFactSignals = countMatchingTokens(corpus, metadataTokens(files));
  const patchSignals = countMatchingTokens(
    corpus,
    patches.flatMap((item) => patchIdentifierTokens(item.patch ?? "")),
  );
  const testPathSignals = countMatchingTokens(
    corpus,
    testFiles.flatMap((item) => tokenizeObservableText(item.filename)),
  );
  const testLanguage =
    /test-file change|test file|tests?\/|__tests__|\.spec\.|\.test\.|test evidence not|not observed|unknown/i.test(
      corpus,
    )
      ? 1
      : 0;
  const testSignals = testPathSignals + testLanguage;
  const issueReferenceSignals = countMatchingTokens(corpus, issueReferenceTokens(input.evidence));

  const supportKnown =
    input.analysis.supportingEvidenceIds.length > 0 &&
    input.analysis.supportingEvidenceIds.every((id) => knownIds.has(id));
  const grounded = supportKnown && (observedFactSignals > 0 || patchSignals > 0 || issueReferenceSignals > 0);

  return {
    observedFactSignals,
    patchSignals,
    testSignals,
    issueReferenceSignals,
    grounded,
  };
}

export function evidenceIdsCitedInQuestions(
  questions: string[],
  evidence: Evidence[],
): string[] {
  const known = new Set(evidence.map((item) => item.id));
  const cited = new Set<string>();
  for (const question of questions) {
    const matches = [
      ...(question.match(EVIDENCE_ID) ?? []),
      ...(question.match(SHORT_EVIDENCE_ID) ?? []),
    ];
    for (const id of matches) {
      if (known.has(id)) {
        cited.add(id);
      }
    }
    for (const item of evidence) {
      if (question.includes(item.id)) {
        cited.add(item.id);
      }
    }
  }
  return [...cited];
}

export function analysisCitesFabricatedEvidence(
  analysis: ResolutionAnalysis,
  evidence: Evidence[],
): string[] {
  const known = new Set(evidence.map((item) => item.id));
  return analysis.supportingEvidenceIds.filter((id) => !known.has(id));
}

export function analysisCitesUnknownClaims(
  analysis: ResolutionAnalysis,
  claimIds: string[],
): string[] {
  const known = new Set(claimIds);
  return analysis.claimIds.filter((id) => !known.has(id));
}

export function collectBoundedPatches(evidence: Evidence[]): BoundedPatchView[] {
  const patches: BoundedPatchView[] = [];
  for (const item of evidence) {
    if (!hasBoundedPatch(item)) {
      continue;
    }
    const change = fileChangeFromEvidence(item);
    if (!change?.patch) {
      continue;
    }
    patches.push({
      filename: change.filename,
      patch: change.patch,
      additions: change.additions,
      deletions: change.deletions,
      status: change.status,
    });
  }
  return patches;
}

export function analysisMentionsTestChange(corpus: string, testFilenames: string[]): boolean {
  if (testFilenames.some((name) => corpus.toLowerCase().includes(name.toLowerCase()))) {
    return true;
  }
  return /test-file change|test file change|test evidence not|not observed \/ unknown|not observed|unknown/i.test(
    corpus,
  );
}

export function analysisAssertsMissingTests(corpus: string): boolean {
  return /没有测试|\bhas no tests\b|\bno tests\b|\btests are missing\b|\bmissing tests\b/i.test(corpus);
}
