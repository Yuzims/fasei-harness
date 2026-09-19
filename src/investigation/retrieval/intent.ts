import type { EvidenceGap } from "../evidence-gap.js";

export type RetrievalIntent =
  | "find_resolution_pr"
  | "find_resolution_commit"
  | "find_code_change"
  | "find_supporting_evidence"
  | "find_contradicting_evidence";

export interface RetrievalIntentContext {
  hasPullCandidates?: boolean;
  timelineObserved?: boolean;
}

function isMissing(gap: EvidenceGap, condition: string): boolean {
  return gap.items.some(
    (item) => item.condition === condition && item.outcome === "missing" && item.optional !== true,
  );
}

/**
 * Maps an Evidence Gap onto retrieval intents.
 * This does not change Evidence-Gap Strategy decisions; it only names
 * what the retrieval layer can look for.
 */
export function retrievalIntentsForGap(
  gap: EvidenceGap,
  context: RetrievalIntentContext = {},
): RetrievalIntent[] {
  const intents: RetrievalIntent[] = [];
  if (!isMissing(gap, "resolution_candidate")) {
    return intents;
  }
  intents.push("find_resolution_pr");
  if (context.hasPullCandidates === false || context.timelineObserved === true) {
    if (context.hasPullCandidates !== true) {
      intents.push("find_resolution_commit");
    }
  }
  return intents;
}
