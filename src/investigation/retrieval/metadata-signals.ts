/**
 * Metadata ranking signals for already-discovered retrieval candidates.
 *
 * These are ranking signals only. They are not evidence, not resolution proof,
 * and never a hard filter. Missing metadata yields 0, not deletion.
 *
 * Does not read ground truth, verifier results, or task outcome.
 */
import { extractSemanticReferences } from "../../github/semantic-references.js";
import type { InvestigationSnapshot } from "../../github/types.js";
import type { RetrievalCandidate, RetrievalRelevanceSignals } from "./candidate.js";
import { lexicalOverlapScore, tokenize, type IssueRetrievalContext } from "./ranking.js";

export const MAX_ISSUE_REFERENCE_STRENGTH = 20;
export const MAX_PATH_OVERLAP_POINTS = 15;
export const MAX_MESSAGE_TITLE_ALIGNMENT = 15;
export const MAX_RESOLUTION_KEYWORD_POINTS = 10;
export const MAX_MERGE_STATE_POINTS = 8;
export const MAX_STRUCTURAL_CHANGE_POINTS = 8;

const ORDINARY_REFERENCE_POINTS = 8;

const PATH_NOISE = new Set([
  "src",
  "lib",
  "bin",
  "pkg",
  "app",
  "test",
  "tests",
  "spec",
  "specs",
  "dist",
  "build",
  "node",
  "modules",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "md",
  "yml",
  "yaml",
  "css",
  "html",
]);

const RESOLUTION_KEYWORD =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|address(?:es)?)\b/i;

export interface CandidateChangedFile {
  filename: string;
  additions?: number;
  deletions?: number;
}

export interface CandidateMetadata {
  title?: string;
  body?: string;
  message?: string;
  state?: "open" | "closed";
  merged?: boolean;
  changedFiles?: readonly CandidateChangedFile[];
}

export type CandidateMetadataCatalog = Record<string, CandidateMetadata>;

export function candidateMetadataKey(
  sourceType: RetrievalCandidate["sourceType"],
  sourceId: string,
): string {
  return `${sourceType}:${sourceId}`;
}

export function lookupCandidateMetadata(
  catalog: CandidateMetadataCatalog,
  sourceType: RetrievalCandidate["sourceType"],
  sourceId: string,
): CandidateMetadata | undefined {
  const direct = catalog[candidateMetadataKey(sourceType, sourceId)];
  if (direct) {
    return direct;
  }
  if (sourceType !== "commit") {
    return undefined;
  }
  const needle = sourceId.toLowerCase();
  const keys = Object.keys(catalog).sort();
  for (const key of keys) {
    const prefix = "commit:";
    if (!key.toLowerCase().startsWith(prefix)) {
      continue;
    }
    const sha = key.slice(prefix.length).toLowerCase();
    if (sha === needle) {
      return catalog[key];
    }
    if (needle.length >= 7 && sha.startsWith(needle)) {
      return catalog[key];
    }
  }
  return undefined;
}

export function candidateMetadataFromSnapshot(
  snapshot: InvestigationSnapshot,
): CandidateMetadataCatalog {
  const catalog: CandidateMetadataCatalog = {};
  for (const [id, pull] of Object.entries(snapshot.pullRequests)) {
    const files = snapshot.files[id] ?? [];
    catalog[candidateMetadataKey("pull_request", id)] = {
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      changedFiles: files.map((file) => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      })),
    };
  }
  for (const [sha, commit] of Object.entries(snapshot.commitIndex)) {
    catalog[candidateMetadataKey("commit", sha)] = {
      message: commit.message,
    };
  }
  for (const commit of snapshot.commits.repo ?? []) {
    const key = candidateMetadataKey("commit", commit.sha);
    if (!catalog[key]) {
      catalog[key] = { message: commit.message };
    }
  }
  return catalog;
}

export function candidateTextFromMetadata(metadata: CandidateMetadata | undefined): string {
  if (!metadata) {
    return "";
  }
  return `${metadata.title ?? ""} ${metadata.body ?? ""} ${metadata.message ?? ""}`.trim();
}

export function calculateIssueReferenceStrength(
  text: string,
  issueNumber: number,
): number {
  if (!text.trim() || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return 0;
  }
  const refs = extractSemanticReferences(text).filter((item) => item.issueNumber === issueNumber);
  if (refs.some((item) => item.kind === "closing_keyword")) {
    return MAX_ISSUE_REFERENCE_STRENGTH;
  }
  if (refs.some((item) => item.kind === "ordinary_reference")) {
    return ORDINARY_REFERENCE_POINTS;
  }
  return 0;
}

function pathTokens(filename: string): string[] {
  const camel = filename.replace(/([a-z])([A-Z])/g, "$1 $2");
  return tokenize(camel).filter((token) => token.length >= 3 && !PATH_NOISE.has(token));
}

export function calculatePathOverlapScore(
  issueText: string,
  files: readonly CandidateChangedFile[] | undefined,
): number {
  if (!issueText.trim() || !files || files.length === 0) {
    return 0;
  }
  const query = new Set(tokenize(issueText).filter((token) => token.length >= 3 && !PATH_NOISE.has(token)));
  if (query.size === 0) {
    return 0;
  }
  const matched = new Set<string>();
  for (const file of files) {
    for (const token of pathTokens(file.filename)) {
      if (query.has(token)) {
        matched.add(token);
      }
    }
  }
  return Math.min(MAX_PATH_OVERLAP_POINTS, matched.size);
}

export function calculateMessageOrTitleAlignment(
  issueText: string,
  candidateText: string,
): number {
  if (!issueText.trim() || !candidateText.trim()) {
    return 0;
  }
  return Math.min(MAX_MESSAGE_TITLE_ALIGNMENT, lexicalOverlapScore(issueText, candidateText));
}

export function calculateResolutionKeywordSignal(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return RESOLUTION_KEYWORD.test(text) ? MAX_RESOLUTION_KEYWORD_POINTS : 0;
}

export function calculateMergeStateSignal(
  merged: boolean | undefined,
  _state?: CandidateMetadata["state"],
): number {
  return merged === true ? MAX_MERGE_STATE_POINTS : 0;
}

export function calculateStructuralChangeSignal(
  files: readonly CandidateChangedFile[] | undefined,
): number {
  if (!files || files.length === 0) {
    return 0;
  }
  const churn = files.reduce(
    (sum, file) => sum + Math.max(0, file.additions ?? 0) + Math.max(0, file.deletions ?? 0),
    0,
  );
  let score = 4;
  if (files.length >= 2) {
    score += 2;
  }
  if (churn >= 10) {
    score += 2;
  }
  return Math.min(MAX_STRUCTURAL_CHANGE_POINTS, score);
}

export function extractMetadataSignals(
  metadata: CandidateMetadata | undefined,
  context: Pick<IssueRetrievalContext, "issueNumber" | "issueTitle" | "issueBody">,
): RetrievalRelevanceSignals {
  const text = candidateTextFromMetadata(metadata);
  const issueText = `${context.issueTitle ?? ""} ${context.issueBody ?? ""}`;
  const issueReferenceStrength = calculateIssueReferenceStrength(text, context.issueNumber);
  const pathOverlapScore = calculatePathOverlapScore(issueText, metadata?.changedFiles);
  const messageOrTitleAlignment = calculateMessageOrTitleAlignment(
    issueText,
    `${metadata?.title ?? ""} ${metadata?.message ?? ""}`.trim() || text,
  );
  const resolutionKeywordSignal = calculateResolutionKeywordSignal(
    `${metadata?.title ?? ""} ${metadata?.message ?? ""} ${metadata?.body ?? ""}`,
  );
  const mergeStateSignal = calculateMergeStateSignal(metadata?.merged, metadata?.state);
  const structuralChangeSignal = calculateStructuralChangeSignal(metadata?.changedFiles);
  return {
    ...(issueReferenceStrength > 0 ? { issueReferenceStrength } : {}),
    ...(pathOverlapScore > 0 ? { pathOverlapScore } : {}),
    ...(messageOrTitleAlignment > 0 ? { messageOrTitleAlignment } : {}),
    ...(resolutionKeywordSignal > 0 ? { resolutionKeywordSignal } : {}),
    ...(mergeStateSignal > 0 ? { mergeStateSignal } : {}),
    ...(structuralChangeSignal > 0 ? { structuralChangeSignal } : {}),
  };
}

export function metadataScore(signals: RetrievalRelevanceSignals): number {
  return (
    (signals.issueReferenceStrength ?? 0) +
    (signals.pathOverlapScore ?? 0) +
    (signals.messageOrTitleAlignment ?? 0) +
    (signals.resolutionKeywordSignal ?? 0) +
    (signals.mergeStateSignal ?? 0) +
    (signals.structuralChangeSignal ?? 0)
  );
}

export function enrichCandidateWithMetadata(
  candidate: RetrievalCandidate,
  metadata: CandidateMetadata | undefined,
  context: Pick<IssueRetrievalContext, "issueNumber" | "issueTitle" | "issueBody">,
): RetrievalCandidate {
  const metadataSignals = extractMetadataSignals(metadata, context);
  return {
    ...candidate,
    relevanceSignals: {
      ...candidate.relevanceSignals,
      ...metadataSignals,
    },
  };
}

export function enrichCandidatesWithMetadata(
  candidates: readonly RetrievalCandidate[],
  catalog: CandidateMetadataCatalog,
  context: Pick<IssueRetrievalContext, "issueNumber" | "issueTitle" | "issueBody">,
): RetrievalCandidate[] {
  return candidates.map((candidate) =>
    enrichCandidateWithMetadata(
      candidate,
      lookupCandidateMetadata(catalog, candidate.sourceType, candidate.sourceId),
      context,
    ),
  );
}
