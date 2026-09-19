/**
 * Deterministic bound for repository-wide commit discovery.
 *
 * This is a discovery window, not a claim about repository history.
 * truncated=true means more commits were not observed — not that no
 * relevant commit exists.
 */

export const MAX_REPOSITORY_COMMIT_DISCOVERY = 30;

export const REPOSITORY_COMMIT_DISCOVERY_TRUNCATED_NOTICE =
  "Repository commit discovery stopped at the configured window. This does not mean no relevant commit exists.";

export interface BoundedCommitDiscovery<T> {
  items: T[];
  truncated: boolean;
}

export type ListedCommits<T> = T[] & { truncated?: boolean };

export function boundRepositoryCommitDiscovery<T>(
  items: readonly T[],
  limit = MAX_REPOSITORY_COMMIT_DISCOVERY,
): BoundedCommitDiscovery<T> {
  const cap = Math.max(0, limit);
  if (items.length > cap) {
    return { items: items.slice(0, cap), truncated: true };
  }
  return { items: [...items], truncated: false };
}

export function attachCommitDiscoveryTruncation<T>(
  items: T[],
  truncated: boolean,
): ListedCommits<T> {
  const result = items as ListedCommits<T>;
  result.truncated = truncated;
  return result;
}

export function commitDiscoveryTruncated(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    const flagged = (value as ListedCommits<unknown>).truncated;
    return typeof flagged === "boolean" ? flagged : undefined;
  }
  if (value && typeof value === "object") {
    const flagged = (value as { truncated?: unknown }).truncated;
    return typeof flagged === "boolean" ? flagged : undefined;
  }
  return undefined;
}

export function unwrapCommitList(output: unknown): {
  commits: unknown[];
  truncated?: boolean;
} {
  if (Array.isArray(output)) {
    return { commits: output, truncated: commitDiscoveryTruncated(output) };
  }
  if (output && typeof output === "object") {
    const record = output as { commits?: unknown; truncated?: unknown };
    if (Array.isArray(record.commits)) {
      return {
        commits: record.commits,
        truncated: typeof record.truncated === "boolean" ? record.truncated : undefined,
      };
    }
  }
  return { commits: [] };
}
