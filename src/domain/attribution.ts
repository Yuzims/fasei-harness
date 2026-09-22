/**
 * Phase 18-B resolution attribution rules — pure field comparisons.
 *
 * No text/NLP/LLM judgment. Certified attribution requires structured
 * corroboration (the 18-A prescan GraphQL closingIssuesReferences fact); a
 * candidate that landed before its issue existed is mechanically refuted.
 */
import type { IssueFact, PullFact } from "./evidence-facts.js";
import type { ResolutionPrescanRecord } from "./types.js";

function parseIso(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

export type TemporalRefutationBasis = "mergedAt" | "createdAt";

export interface TemporalRefutation {
  basis: TemporalRefutationBasis;
  candidateTime: string;
  issueCreatedAt: string;
  reason: string;
}

/**
 * Merged (or created, when mergedAt is absent) strictly before the target
 * issue existed → the change cannot be its resolution. Inert whenever either
 * timestamp is missing or unparseable; equal instants are not refuted.
 */
export function refutedByTemporalOrder(
  pull: PullFact,
  issue: IssueFact | undefined,
): TemporalRefutation | undefined {
  const issueCreatedAt = issue?.createdAt;
  const issueTime = parseIso(issueCreatedAt);
  if (!issueCreatedAt || issueTime === undefined) {
    return undefined;
  }
  const basis: TemporalRefutationBasis = pull.mergedAt ? "mergedAt" : "createdAt";
  const candidateTime = basis === "mergedAt" ? pull.mergedAt : pull.createdAt;
  const candidateMs = parseIso(candidateTime);
  if (!candidateTime || candidateMs === undefined) {
    return undefined;
  }
  if (candidateMs >= issueTime) {
    return undefined;
  }
  return {
    basis,
    candidateTime,
    issueCreatedAt,
    reason: `PR #${pull.number} ${basis} ${candidateTime} predates issue createdAt ${issueCreatedAt}; a change that landed before the issue existed cannot be its resolution.`,
  };
}

/** PR numbers with an authoritative GraphQL closingIssuesReferences link. */
export function corroboratedFixPullNumbers(
  prescan: ResolutionPrescanRecord | undefined,
): Set<number> {
  const numbers = new Set<number>();
  if (!prescan) {
    return numbers;
  }
  for (const candidate of prescan.candidates) {
    if (candidate.structuredClosingReference === true) {
      numbers.add(candidate.pullNumber);
    }
  }
  return numbers;
}
