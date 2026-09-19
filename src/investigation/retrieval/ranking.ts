import { closingKeywordReferencesIssue } from "../../domain/index.js";
import type { RetrievalCandidate, RetrievalRelevanceSignals } from "./candidate.js";

/**
 * Ranking score controls investigation order only.
 * It is not a probability of resolution correctness.
 */
export const ISSUE_REFERENCE_POINTS = 100;
export const STRUCTURAL_POINTS = 40;
export const MAX_TEMPORAL_POINTS = 10;

const STOP_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "be",
  "this",
  "that",
  "with",
  "from",
  "into",
  "over",
  "under",
  "after",
  "before",
  "pr",
  "issue",
  "commit",
]);

export interface IssueRetrievalContext {
  issueNumber: number;
  issueTitle?: string;
  issueBody?: string;
  issueCreatedAt?: string;
  structurallyReferencedIds?: string[];
}

export interface RankableRecord {
  text: string;
  createdAt?: string;
  sourceId: string;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));
}

export function lexicalOverlapScore(left: string, right: string): number {
  const query = new Set(tokenize(left));
  if (query.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of tokenize(right)) {
    if (query.has(token)) {
      overlap += 1;
      query.delete(token);
    }
  }
  return overlap;
}

export function mentionsIssueNumber(text: string, issueNumber: number): boolean {
  if (!text.trim() || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  const pattern = new RegExp(
    `(?:#|/(?:issues|pull)/)${issueNumber}\\b`,
  );
  return pattern.test(text);
}

/**
 * Temporal proximity is a ranking signal only.
 * A candidate created before the issue is never rejected for that reason.
 */
export function temporalProximityScore(
  candidateCreatedAt: string | undefined,
  issueCreatedAt: string | undefined,
): number {
  if (!candidateCreatedAt || !issueCreatedAt) {
    return 0;
  }
  const candidateMs = Date.parse(candidateCreatedAt);
  const issueMs = Date.parse(issueCreatedAt);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(issueMs)) {
    return 0;
  }
  const deltaDays = Math.abs(candidateMs - issueMs) / 86_400_000;
  return Math.max(0, MAX_TEMPORAL_POINTS - Math.floor(deltaDays / 7));
}

export function computeRelevanceSignals(
  record: RankableRecord,
  context: IssueRetrievalContext,
): RetrievalRelevanceSignals {
  const issueText = `${context.issueTitle ?? ""} ${context.issueBody ?? ""}`;
  const issueReference =
    closingKeywordReferencesIssue(record.text, context.issueNumber) ||
    mentionsIssueNumber(record.text, context.issueNumber);
  const structural = context.structurallyReferencedIds?.some(
    (id) => id.toLowerCase() === record.sourceId.toLowerCase(),
  );
  const lexical = lexicalOverlapScore(issueText, record.text);
  const temporal = temporalProximityScore(record.createdAt, context.issueCreatedAt);
  return {
    ...(issueReference ? { issueReference: true } : {}),
    ...(lexical > 0 ? { lexicalScore: lexical } : {}),
    ...(temporal > 0 ? { temporalScore: temporal } : {}),
    ...(structural ? { structuralScore: STRUCTURAL_POINTS } : {}),
  };
}

/**
 * Existing evidence-driven score. Unchanged when metadata signals are absent.
 */
export function existingRankingScore(candidate: RetrievalCandidate): number {
  const signals = candidate.relevanceSignals;
  return (
    (signals.issueReference ? ISSUE_REFERENCE_POINTS : 0) +
    (signals.structuralScore ?? 0) +
    (signals.lexicalScore ?? 0) +
    (signals.temporalScore ?? 0)
  );
}

function metadataRankingScore(signals: RetrievalRelevanceSignals): number {
  return (
    (signals.issueReferenceStrength ?? 0) +
    (signals.pathOverlapScore ?? 0) +
    (signals.messageOrTitleAlignment ?? 0) +
    (signals.resolutionKeywordSignal ?? 0) +
    (signals.mergeStateSignal ?? 0) +
    (signals.structuralChangeSignal ?? 0)
  );
}

/**
 * Ranking score controls investigation order only.
 * It is not a probability of resolution correctness.
 * metadataScore is 0 unless metadata enrichment populated those signals.
 */
export function rankingScore(candidate: RetrievalCandidate): number {
  return existingRankingScore(candidate) + metadataRankingScore(candidate.relevanceSignals);
}

export function rankingReason(candidate: RetrievalCandidate): string {
  const signals = candidate.relevanceSignals;
  const parts: string[] = [];
  if (signals.issueReference) {
    parts.push("issue_reference");
  }
  if ((signals.structuralScore ?? 0) > 0) {
    parts.push("structural");
  }
  if ((signals.lexicalScore ?? 0) > 0) {
    parts.push("lexical");
  }
  if ((signals.temporalScore ?? 0) > 0) {
    parts.push("temporal");
  }
  if ((signals.issueReferenceStrength ?? 0) > 0) {
    parts.push("issue_reference_strength");
  }
  if ((signals.pathOverlapScore ?? 0) > 0) {
    parts.push("path_overlap");
  }
  if ((signals.messageOrTitleAlignment ?? 0) > 0) {
    parts.push("title_alignment");
  }
  if ((signals.resolutionKeywordSignal ?? 0) > 0) {
    parts.push("resolution_keyword");
  }
  if ((signals.mergeStateSignal ?? 0) > 0) {
    parts.push("merge_state");
  }
  if ((signals.structuralChangeSignal ?? 0) > 0) {
    parts.push("structural_change");
  }
  return parts.length > 0 ? parts.join("+") : "default_order";
}

export function rankCandidates(candidates: readonly RetrievalCandidate[]): RetrievalCandidate[] {
  return [...candidates].sort((left, right) => {
    const scoreDelta = rankingScore(right) - rankingScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    if (left.sourceType !== right.sourceType) {
      return left.sourceType.localeCompare(right.sourceType);
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
}
