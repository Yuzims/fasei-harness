import { GitHubProviderError } from "./errors.js";
import { GithubHttpClient, type GithubHttpOptions } from "./http.js";
import { asArray, asRecord } from "./normalize.js";
import type { IssueRef } from "./types.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Minimal structured facts for one candidate PR observed through GraphQL.
 * `closingIssueNumbers` is the raw `closingIssuesReferences` field set
 * (the authoritative PR-side link). Facts only: no fixes/verdict derivation.
 */
export interface ClosingReferenceFacts {
  pullNumber: number;
  /** false when the repository has no PR with this number. */
  found: boolean;
  state?: string;
  merged?: boolean;
  mergedAt?: string | null;
  createdAt?: string | null;
  baseRefName?: string | null;
  url?: string;
  closingIssueNumbers?: number[];
}

export interface ClosingReferencesQuery extends IssueRef {
  pullNumbers: number[];
}

/**
 * Deterministic, zero-LLM enumeration source for resolution references.
 * Implemented by GithubGraphQlClient for live runs; tests replay fixtures.
 * The issue-side methods are optional: capability-absent implementations
 * simply do not gain the extra enumeration channels.
 */
export interface ResolutionReferenceSource {
  getClosingReferences(ref: ClosingReferencesQuery): Promise<{
    /** Repository id GitHub resolved to after following renames (facebook/react → react/react). */
    repositoryNameWithOwner?: string;
    facts: ClosingReferenceFacts[];
  }>;
  /**
   * Issue-side authoritative linked-PR record (react#37652: REST timeline had
   * zero events; only closedByPullRequestsReferences sees the second PR).
   */
  getIssueLinkedPulls?(ref: IssueRef): Promise<IssueLinkedPullsFacts>;
  /** Reverse lookup: PRs associated with commits already seen in the timeline. */
  getPullsForCommits?(input: {
    owner: string;
    repo: string;
    oids: string[];
  }): Promise<CommitAssociatedPullsFacts[]>;
}

export interface IssueLinkedPullsFacts {
  /** Raw closedByPullRequestsReferences node numbers (GitHub's issue-header chip). */
  closedBy: number[];
  /** PR numbers surfaced by GraphQL timeline events REST does not carry (branch connections). */
  connected: number[];
  /** A bounded first:N page was filled — the enumeration may be incomplete. */
  truncated: boolean;
}

export interface CommitAssociatedPullsFacts {
  oid: string;
  pullNumbers: number[];
}

const ALIASES_PER_QUERY = 25;

function graphQlErrorCode(errors: unknown[]): GitHubProviderError["code"] {
  const codes = new Set(
    errors
      .map(asRecord)
      .map((error) => str(asRecord(error.extensions).code) || str(error.message)),
  );
  if ([...codes].some((code) => /rate.?limit|resource.?exhausted/i.test(code))) {
    return "rate_limited";
  }
  if ([...codes].some((code) => /INSUFFICIENT_TOKENS|AUTHENTICATION|BAD_CREDENTIALS/i.test(code))) {
    return "unauthorized";
  }
  if ([...codes].some((code) => code === "NOT_FOUND")) {
    return "not_found";
  }
  if ([...codes].some((code) => /undefinedField|GRAPHQL_VALIDATION/i.test(code))) {
    return "malformed_response";
  }
  return "forbidden";
}

export class GithubGraphQlClient implements ResolutionReferenceSource {
  private readonly http: GithubHttpClient;

  constructor(options: GithubHttpOptions = {}) {
    this.http = new GithubHttpClient(options);
  }

  async getClosingReferences(ref: ClosingReferencesQuery): Promise<{
    repositoryNameWithOwner?: string;
    facts: ClosingReferenceFacts[];
  }> {
    const pullNumbers = [...new Set(ref.pullNumbers)].filter(
      (number) => Number.isInteger(number) && number > 0,
    );
    if (!ref.owner.trim() || !ref.repo.trim()) {
      throw new GitHubProviderError({
        code: "invalid_argument",
        operation: "getClosingReferences",
        message: "owner/repo must be a GitHub repository id",
        retryable: false,
      });
    }
    const facts: ClosingReferenceFacts[] = [];
    let repositoryNameWithOwner: string | undefined;

    for (let offset = 0; offset < pullNumbers.length; offset += ALIASES_PER_QUERY) {
      const chunk = pullNumbers.slice(offset, offset + ALIASES_PER_QUERY);
      const variables: Record<string, unknown> = {
        owner: ref.owner.trim(),
        repo: ref.repo.trim(),
      };
      chunk.forEach((number, index) => {
        variables[`pr${index}`] = number;
      });
      const body = await this.http.postJson("getClosingReferences", "/graphql", {
        query: CLOSING_REFERENCES_QUERY_TEMPLATE(chunk.length),
        variables,
      });
      const parsed = asRecord(body);
      const errors = asArray(parsed.errors);
      const data = asRecord(parsed.data);
      if (errors.length > 0 && Object.keys(data).length === 0) {
        throw new GitHubProviderError({
          code: graphQlErrorCode(errors),
          operation: "getClosingReferences",
          message: `GraphQL errors: ${errors.map((error) => str(asRecord(error).message)).join("; ").slice(0, 240)}`,
        });
      }
      const repository = asRecord(data.repository);
      if (str(repository.nameWithOwner)) {
        repositoryNameWithOwner = str(repository.nameWithOwner);
      }
      chunk.forEach((number, index) => {
        facts.push(normalizeClosingReferenceFacts(number, repository[`pr${index}`]));
      });
    }

    return { repositoryNameWithOwner, facts };
  }

  async getIssueLinkedPulls(ref: IssueRef): Promise<IssueLinkedPullsFacts> {
    const data = await this.postGraphQl("getIssueLinkedPulls", ISSUE_LINKED_PULLS_QUERY, {
      owner: ref.owner.trim(),
      name: ref.repo.trim(),
      number: ref.issueNumber,
    });
    const issue = asRecord(asRecord(data.repository).issue);
    const closedBy = nodeNumbers(asRecord(issue.closedByPullRequestsReferences));
    const timelineNodes = asArray(asRecord(issue.timelineItems).nodes);
    const connected = timelineNodes
      .map(asRecord)
      .filter((node) => node.__typename === "ConnectedEvent" || node.__typename === "CrossReferencedEvent")
      .map((node) => asRecord(node.source ?? node.subject))
      .filter((ref) => ref.__typename === "PullRequest")
      .map((ref) => Number(ref.number))
      .filter((number) => Number.isInteger(number) && number > 0);
    return {
      closedBy,
      connected: [...new Set(connected)],
      truncated: closedBy.length >= 50 || timelineNodes.length >= 100,
    };
  }

  async getPullsForCommits(input: {
    owner: string;
    repo: string;
    oids: string[];
  }): Promise<CommitAssociatedPullsFacts[]> {
    const oids = [...new Set(input.oids.map((oid) => oid.trim()).filter(Boolean))];
    if (!input.owner.trim() || !input.repo.trim()) {
      throw new GitHubProviderError({
        code: "invalid_argument",
        operation: "getPullsForCommits",
        message: "owner/repo must be a GitHub repository id",
        retryable: false,
      });
    }
    const results: CommitAssociatedPullsFacts[] = [];
    for (let offset = 0; offset < oids.length; offset += ALIASES_PER_QUERY) {
      const chunk = oids.slice(offset, offset + ALIASES_PER_QUERY);
      const variables: Record<string, unknown> = { owner: input.owner.trim(), name: input.repo.trim() };
      chunk.forEach((oid, index) => {
        variables[`oid${index}`] = oid;
      });
      const data = await this.postGraphQl(
        "getPullsForCommits",
        COMMIT_PULLS_QUERY_TEMPLATE(chunk.length),
        variables,
      );
      const repository = asRecord(data.repository);
      chunk.forEach((oid, index) => {
        results.push({ oid, pullNumbers: nodeNumbers(asRecord(asRecord(repository[`c${index}`]).associatedPullRequests)) });
      });
    }
    return results;
  }

  private async postGraphQl(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = await this.http.postJson(operation, "/graphql", { query, variables });
    const parsed = asRecord(body);
    const errors = asArray(parsed.errors);
    const data = asRecord(parsed.data);
    if (errors.length > 0 && Object.keys(data).length === 0) {
      throw new GitHubProviderError({
        code: graphQlErrorCode(errors),
        operation,
        message: `GraphQL errors: ${errors.map((error) => str(asRecord(error).message)).join("; ").slice(0, 240)}`,
      });
    }
    return data;
  }
}

function nodeNumbers(connection: Record<string, unknown>): number[] {
  return asArray(connection.nodes)
    .map(asRecord)
    .map((node) => Number(node.number))
    .filter((number) => Number.isInteger(number) && number > 0);
}

const ISSUE_LINKED_PULLS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      closedByPullRequestsReferences(first:50){ nodes { number } }
      timelineItems(first:100){ nodes { __typename
        ... on CrossReferencedEvent { source { __typename ... on PullRequest { number } } }
        ... on ConnectedEvent { subject { __typename ... on PullRequest { number } } }
      } }
    }
  }
}`;

export function COMMIT_PULLS_QUERY_TEMPLATE(aliasCount: number): string {
  const variables = ["$owner: String!", "$name: String!"];
  const selections: string[] = [];
  for (let index = 0; index < aliasCount; index++) {
    variables.push(`$oid${index}: GitObjectID!`);
    selections.push(
      `    c${index}: object(oid: $oid${index}) { ... on Commit { associatedPullRequests(first: 10) { nodes { number } } } }`,
    );
  }
  return [
    `query(${variables.join(", ")}) {`,
    "  repository(owner: $owner,name: $name) {",
    ...selections,
    "  }",
    "}",
  ].join("\n");
}

export function CLOSING_REFERENCES_QUERY_TEMPLATE(aliasCount: number): string {
  const fields = `number state merged mergedAt createdAt baseRefName url
      closingIssuesReferences(first: 50) { nodes { number } }`;
  const variables = ["$owner: String!", "$repo: String!"];
  for (let index = 0; index < aliasCount; index++) {
    variables.push(`$pr${index}: Int!`);
  }
  const lines = [`query(${variables.join(", ")}) {`, "  repository(owner: $owner, name: $repo) {", "    nameWithOwner"];
  for (let index = 0; index < aliasCount; index++) {
    lines.push(
      `    pr${index}: pullRequest(number: $pr${index}) {\n${fields}\n    }`,
    );
  }
  lines.push("  }", "}");
  return lines.join("\n");
}

function normalizeClosingReferenceFacts(
  pullNumber: number,
  raw: unknown,
): ClosingReferenceFacts {
  if (raw == null) {
    return { pullNumber, found: false };
  }
  const item = asRecord(raw);
  const closingIssueNumbers = asArray(asRecord(item.closingIssuesReferences).nodes)
    .map(asRecord)
    .map((node) => Number(node.number))
    .filter((number) => Number.isInteger(number) && number > 0);
  return {
    pullNumber,
    found: true,
    state: str(item.state) || undefined,
    merged: typeof item.merged === "boolean" ? item.merged : undefined,
    mergedAt: item.mergedAt == null ? null : str(item.mergedAt),
    createdAt: item.createdAt == null ? null : str(item.createdAt),
    baseRefName: item.baseRefName == null ? null : str(item.baseRefName),
    url: str(item.url) || undefined,
    closingIssueNumbers,
  };
}
