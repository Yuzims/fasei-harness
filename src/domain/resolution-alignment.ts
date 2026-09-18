/**
 * Conservative descriptive alignment between an issue and a landed resolution.
 *
 * This is not semantic code review, LLM judgment, AST analysis, or proof of
 * effect. It only asks whether the resolution's own title/body/message/files
 * share the issue's observable problem terms beyond GitHub closing keywords.
 *
 * Missing alignment → insufficient_evidence (cannot prove effect).
 * It does not by itself produce not_verified / wrong_target.
 */
import { commitFact, pullFact } from "./evidence-facts.js";
import type { ResolutionCandidate } from "./resolution-path.js";
import type { Evidence } from "./types.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "bug",
  "by",
  "chore",
  "close",
  "closed",
  "closes",
  "docs",
  "feat",
  "fix",
  "fixed",
  "fixes",
  "for",
  "from",
  "in",
  "into",
  "is",
  "issue",
  "it",
  "of",
  "on",
  "or",
  "please",
  "pr",
  "pull",
  "request",
  "resolve",
  "resolved",
  "resolves",
  "the",
  "this",
  "to",
  "via",
  "when",
  "with",
]);

const IDENTIFIER = /[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function stripClosingLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https?:\/\/|#)\S+/i.test(line))
    .join("\n");
}

function stem(token: string): string {
  if (token.length < 5) {
    return token;
  }
  if (token.endsWith("ing") && token.length > 6) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ied") && token.length > 5) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("ed") && token.length > 5) {
    return token.slice(0, -2);
  }
  if (token.endsWith("es") && token.length > 5) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizeCompact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function contentTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && !STOPWORDS.has(item) && !/^\d+$/.test(item))
    .map(stem);
  return [...new Set(tokens)];
}

export function identifierTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const raw = match[0];
    if (raw.length < 6) {
      continue;
    }
    found.add(normalizeCompact(raw));
  }
  return [...found];
}

function issueTitle(issue: Evidence): string {
  const payload = isRecord(issue.payload) ? issue.payload : {};
  return stringField(payload, "title") || issue.summary;
}

function issueBody(issue: Evidence): string {
  const payload = isRecord(issue.payload) ? issue.payload : {};
  return stringField(payload, "body");
}

function resolutionText(candidates: readonly ResolutionCandidate[], extra: readonly Evidence[]): string {
  const parts: string[] = [];
  for (const candidate of candidates) {
    const payload = isRecord(candidate.evidence.payload) ? candidate.evidence.payload : {};
    if (candidate.path === "pr_merge") {
      parts.push(stringField(payload, "title") || candidate.evidence.summary);
      parts.push(stripClosingLines(stringField(payload, "body")));
      const pull = pullFact(candidate.evidence);
      if (pull) {
        parts.push(`pr ${pull.number}`);
      }
    } else {
      const commit = commitFact(candidate.evidence);
      parts.push(candidate.evidence.summary);
      parts.push(stripClosingLines(commit?.message ?? stringField(payload, "message")));
    }
  }
  for (const item of extra) {
    if (item.kind === "file") {
      const payload = isRecord(item.payload) ? item.payload : {};
      parts.push(stringField(payload, "filename") || item.summary);
    } else if (item.kind === "commit") {
      const commit = commitFact(item);
      parts.push(stripClosingLines(commit?.message ?? item.summary));
    }
  }
  return parts.join("\n");
}

export type AlignmentOutcome = "aligned" | "unknown";

export function describeResolutionAlignment(
  issue: Evidence | undefined,
  candidates: readonly ResolutionCandidate[],
  extra: readonly Evidence[] = [],
): { outcome: AlignmentOutcome; reason: string } {
  if (!issue || candidates.length === 0) {
    return {
      outcome: "unknown",
      reason: "No landed resolution candidate to compare against the issue description.",
    };
  }
  const title = issueTitle(issue);
  const titleIds = identifierTokens(title);
  const resolution = resolutionText(candidates, extra);
  const resolutionCompact = normalizeCompact(resolution);
  if (titleIds.length > 0) {
    const missing = titleIds.filter((id) => !resolutionCompact.includes(id));
    if (missing.length > 0) {
      return {
        outcome: "unknown",
        reason:
          "Landed resolution does not mention issue-title identifiers; GitHub close/merge/file evidence is not proof of resolution effect.",
      };
    }
    return {
      outcome: "aligned",
      reason: "Landed resolution mentions the issue-title identifiers. This is descriptive alignment, not semantic proof.",
    };
  }

  const titleTokens = contentTokens(title);
  const bodyTokens = contentTokens(`${title}\n${issueBody(issue)}`).slice(0, 24);
  const issueTerms = titleTokens.length > 0 ? titleTokens : bodyTokens;
  if (issueTerms.length === 0) {
    return {
      outcome: "unknown",
      reason: "Issue description has no comparable problem terms.",
    };
  }
  const resolutionTerms = contentTokens(resolution);
  const matched = issueTerms.filter((token) =>
    resolutionTerms.some((other) => token === other || token.startsWith(other) || other.startsWith(token)),
  );
  const ratio = matched.length / issueTerms.length;
  if (ratio >= 0.35) {
    return {
      outcome: "aligned",
      reason: `Landed resolution shares ${matched.length}/${issueTerms.length} issue problem terms. This is descriptive alignment, not semantic proof.`,
    };
  }
  return {
    outcome: "unknown",
    reason:
      "Landed resolution does not share enough issue problem terms; GitHub close/merge/file evidence is not proof of resolution effect.",
  };
}
