/**
 * Phase 18-B unlinked-fix hint source: commits on a target branch that
 * touched a given file since the issue was created. Pure GitHub structured
 * queries (path + sha + server-side committer-date `since` filter); no text
 * analysis. Results feed `unlinkedFixScan` hypotheses only — never the
 * Evidence graph and never a verifier check.
 */
import { encodeRepo, GithubHttpClient } from "./http.js";

export interface UnlinkedFixCommitQuery {
  owner: string;
  repo: string;
  /** Branch/ref to walk; undefined means the repository default branch. */
  ref?: string;
  path: string;
  /** ISO committer-date lower bound (issue createdAt). */
  since?: string;
}

export interface UnlinkedFixCommitResult {
  /** Commit SHAs, newest first as GitHub returns them. */
  shas: string[];
  /** true = the per-file budget was reached; the window is not exhausted. */
  truncated: boolean;
}

export interface UnlinkedFixCommitSource {
  listCommitsTouchingFile(query: UnlinkedFixCommitQuery): Promise<UnlinkedFixCommitResult>;
}

const PER_FILE_BUDGET = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class GithubCommitHintSource implements UnlinkedFixCommitSource {
  private readonly http: GithubHttpClient;

  constructor(http?: GithubHttpClient) {
    this.http = http ?? new GithubHttpClient();
  }

  async listCommitsTouchingFile(query: UnlinkedFixCommitQuery): Promise<UnlinkedFixCommitResult> {
    const params = new URLSearchParams({ per_page: String(PER_FILE_BUDGET) });
    if (query.ref) {
      params.set("sha", query.ref);
    }
    params.set("path", query.path);
    if (query.since) {
      params.set("since", query.since);
    }
    const path = `/repos/${encodeRepo(query.owner, query.repo)}/commits?${params.toString()}`;
    const { items, truncated } = await this.http.getJsonPagesBounded(
      "listCommitsTouchingFile",
      path,
      PER_FILE_BUDGET,
    );
    const shas = items
      .filter(isRecord)
      .map((item) => (typeof item.sha === "string" ? item.sha : undefined))
      .filter((sha): sha is string => Boolean(sha));
    return { shas, truncated };
  }
}
