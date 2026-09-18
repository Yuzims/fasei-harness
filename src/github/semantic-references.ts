/**
 * LLM-context semantic extraction for GitHub issue/PR text.
 *
 * Reuses the GitHub auto-close family already encoded by
 * `closingKeywordReferencesIssue` / `textClosesIssue` (close/fix/resolve).
 * Compact context also records `address(es)` as positive linkage.
 *
 * This does not create EvidenceRelation edges, does not mutate Evidence
 * payloads, and is not a verifier signal. Graph types remain:
 *   closing_keyword     ≈ textual clue for a later "fixes" relation
 *   ordinary_reference  ≈ "references" / "mentions"
 *   negative_resolution ≈ textual non-resolution clue (not eligible_closure)
 *
 * Domain `not_planned` is GitHub issue state_reason. Body text such as
 * "not planned" is preserved here for Agent reasoning only.
 */

import { extractMentionedNumbers } from "./normalize.js";

export const SEMANTIC_REFERENCE_KINDS = [
  "closing_keyword",
  "negative_resolution",
  "ordinary_reference",
] as const;

export type SemanticReferenceKind = (typeof SEMANTIC_REFERENCE_KINDS)[number];

export interface SemanticReference {
  kind: SemanticReferenceKind;
  issueNumber?: number;
  keyword?: string;
}

interface Span {
  start: number;
  end: number;
}

const CLOSING_VERB = "(close[sd]?|fix(?:e[sd])?|resolve[sd]?|address(?:es)?)";
const ISSUE_TARGET = "(?:https?://github\\.com/[^/\\s]+/[^/\\s]+/(?:issues|pull)/|#)";

const NEGATIVE_NUMBERED =
  /\b(does not (?:actually )?(?:resolve|fix(?:e[sd])?|close[sd]?|address(?:es)?)|do not (?:resolve|fix|close|address)|duplicate of)\s+#(\d+)\b/gi;

const NEGATIVE_BARE =
  /\b(does not (?:actually )?(?:resolve|fix|close)|not planned|won't fix|will not fix|wont fix)\b/gi;

const CLOSING = new RegExp(`${CLOSING_VERB}\\s+${ISSUE_TARGET}(\\d+)\\b`, "gi");

const ORDINARY_PHRASE = /\b(related(?:\s+to)?|see|discuss(?:es|ed|ing)?)\s+#(\d+)\b/gi;

const HASH_NUMBER = /#(\d+)\b/g;

function overlaps(span: Span, occupied: readonly Span[]): boolean {
  return occupied.some((item) => span.start < item.end && item.start < span.end);
}

function collect(
  pattern: RegExp,
  text: string,
  occupied: Span[],
  toRef: (match: RegExpExecArray) => SemanticReference | undefined,
): SemanticReference[] {
  const found: SemanticReference[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (!overlaps({ start, end }, occupied)) {
      const ref = toRef(match);
      if (ref) {
        found.push(ref);
        occupied.push({ start, end });
      }
    }
    match = pattern.exec(text);
  }
  return found;
}

function positiveKeyword(verb: string): string {
  const value = verb.toLowerCase();
  if (value.startsWith("close")) {
    return "closes";
  }
  if (value.startsWith("fix")) {
    return "fixes";
  }
  if (value.startsWith("resolve")) {
    return "resolves";
  }
  if (value.startsWith("address")) {
    return "addresses";
  }
  return value;
}

function negativeKeyword(phrase: string): string {
  const value = phrase.toLowerCase();
  if (value.includes("duplicate")) {
    return "duplicate_of";
  }
  if (value.includes("not planned")) {
    return "not_planned";
  }
  if (value.includes("won't fix") || value.includes("will not fix") || value.includes("wont fix")) {
    return "wont_fix";
  }
  return "does_not_resolve";
}

function ordinaryKeyword(phrase: string): string {
  const value = phrase.toLowerCase();
  if (value.startsWith("related")) {
    return "related_to";
  }
  if (value.startsWith("see")) {
    return "see";
  }
  if (value.startsWith("discuss")) {
    return "discusses";
  }
  return value;
}

function issueNumberFrom(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function uniqueKey(ref: SemanticReference): string {
  return `${ref.kind}:${ref.keyword ?? ""}:${ref.issueNumber ?? ""}`;
}

/**
 * Classify GitHub-style issue references in free text.
 * Negative phrases are applied first so "Does not resolve #42" is never a closing keyword.
 */
export function extractSemanticReferences(text: string): SemanticReference[] {
  if (!text.trim()) {
    return [];
  }
  const occupied: Span[] = [];
  const refs: SemanticReference[] = [];

  refs.push(
    ...collect(NEGATIVE_NUMBERED, text, occupied, (match) => {
      const issueNumber = issueNumberFrom(match[2]);
      if (!issueNumber) {
        return undefined;
      }
      return {
        kind: "negative_resolution",
        issueNumber,
        keyword: negativeKeyword(match[1] ?? ""),
      };
    }),
  );

  refs.push(
    ...collect(NEGATIVE_BARE, text, occupied, (match) => ({
      kind: "negative_resolution",
      keyword: negativeKeyword(match[1] ?? match[0]),
    })),
  );

  refs.push(
    ...collect(CLOSING, text, occupied, (match) => {
      const issueNumber = issueNumberFrom(match[2]);
      if (!issueNumber) {
        return undefined;
      }
      return {
        kind: "closing_keyword",
        issueNumber,
        keyword: positiveKeyword(match[1] ?? ""),
      };
    }),
  );

  refs.push(
    ...collect(ORDINARY_PHRASE, text, occupied, (match) => {
      const issueNumber = issueNumberFrom(match[2]);
      if (!issueNumber) {
        return undefined;
      }
      return {
        kind: "ordinary_reference",
        issueNumber,
        keyword: ordinaryKeyword(match[1] ?? ""),
      };
    }),
  );

  HASH_NUMBER.lastIndex = 0;
  let hash = HASH_NUMBER.exec(text);
  while (hash) {
    const start = hash.index;
    const end = start + hash[0].length;
    const issueNumber = issueNumberFrom(hash[1]);
    if (issueNumber && !overlaps({ start, end }, occupied)) {
      refs.push({
        kind: "ordinary_reference",
        issueNumber,
        keyword: "mention",
      });
      occupied.push({ start, end });
    }
    hash = HASH_NUMBER.exec(text);
  }

  const seen = new Set<string>();
  const deduped: SemanticReference[] = [];
  for (const ref of refs) {
    const key = uniqueKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

export function mentionedIssueNumbers(text: string, exclude?: number): number[] {
  return extractMentionedNumbers(text).filter((value) => (exclude ? value !== exclude : true));
}
