/**
 * Phase 18-A: GithubGraphQlClient offline tests. fetchImpl is always injected;
 * these never touch the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLOSING_REFERENCES_QUERY_TEMPLATE, GithubGraphQlClient } from "../src/github/graphql.js";
import { GitHubProviderError } from "../src/github/errors.js";

interface RecordedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubClient(
  handler: (request: RecordedRequest, index: number) => unknown,
): { client: GithubGraphQlClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input, init) => {
    const recorded: RecordedRequest = {
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
      body: JSON.parse(String(init?.body)) as RecordedRequest["body"],
    };
    requests.push(recorded);
    return jsonResponse(handler(recorded, requests.length - 1));
  }) as unknown as typeof fetch;
  return {
    client: new GithubGraphQlClient({
      fetchImpl,
      env: { GITHUB_TOKEN: "test-token" },
      maxRetries: 0,
    }),
    requests,
  };
}

const repo = { owner: "facebook", repo: "react" };

test("查询模板声明全部 $prN 变量（真实 GraphQL 校验回归）", () => {
  const query = CLOSING_REFERENCES_QUERY_TEMPLATE(3);
  assert.match(query, /query\(\$owner: String!, \$repo: String!, \$pr0: Int!, \$pr1: Int!, \$pr2: Int!\)/);
  assert.match(query, /closingIssuesReferences\(first: 50\)/);
});

test("POST /graphql 带 bearer 认证并解析 closing 引用事实", async () => {
  const { client, requests } = stubClient(() => ({
    data: {
      repository: {
        nameWithOwner: "react/react",
        pr0: {
          number: 37626,
          state: "OPEN",
          merged: false,
          mergedAt: null,
          createdAt: "2026-09-14T10:54:00Z",
          baseRefName: "main",
          url: "https://github.com/react/react/pull/37626",
          closingIssuesReferences: { nodes: [{ number: 37610 }] },
        },
        pr1: null,
      },
    },
  }));

  const result = await client.getClosingReferences({ ...repo, issueNumber: 37610, pullNumbers: [37626, 99999] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.github.com/graphql");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers.authorization, "Bearer test-token");
  assert.equal(requests[0]?.body.variables.pr0, 37626);
  assert.equal(requests[0]?.body.variables.pr1, 99999);

  assert.equal(result.repositoryNameWithOwner, "react/react", "rename resolution recorded as fact");
  const fix = result.facts.find((fact) => fact.pullNumber === 37626);
  assert.equal(fix?.found, true);
  assert.deepEqual(fix?.closingIssueNumbers, [37610]);
  assert.equal(fix?.mergedAt, null);
  const missing = result.facts.find((fact) => fact.pullNumber === 99999);
  assert.deepEqual(missing, { pullNumber: 99999, found: false });
});

test("去重非法编号；空集合不发请求", async () => {
  const { client, requests } = stubClient(() => ({
    data: { repository: { nameWithOwner: "react/react", pr0: null } },
  }));
  const empty = await client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [] });
  assert.deepEqual(empty.facts, []);
  assert.equal(requests.length, 0);

  await client.getClosingReferences({
    ...repo,
    issueNumber: 1,
    pullNumbers: [55, 55, 0, -3, 1.5, 56],
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(
    [requests[0]?.body.variables.pr0, requests[0]?.body.variables.pr1, requests[0]?.body.variables.pr2],
    [55, 56, undefined],
  );
});

test("超过 25 个候选时分块查询并合并事实", async () => {
  const { client, requests } = stubClient((request, index) => {
    const facts: Record<string, unknown> = { nameWithOwner: "react/react" };
    const numbers = Object.entries(request.body.variables)
      .filter(([key]) => /^pr\d+$/.test(key))
      .map(([, value]) => value as number);
    for (const [position, number] of numbers.entries()) {
      facts[`pr${position}`] = {
        number,
        state: "OPEN",
        merged: false,
        mergedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        baseRefName: "main",
        url: "",
        closingIssuesReferences: { nodes: [] },
      };
    }
    return { data: { repository: facts } };
  });
  const numbers = Array.from({ length: 30 }, (_, i) => 100 + i);
  const result = await client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: numbers });
  assert.equal(requests.length, 2);
  assert.equal(result.facts.length, 30);
  assert.deepEqual(
    result.facts.map((fact) => fact.pullNumber),
    numbers,
    "facts stay aligned with requested numbers",
  );
});

test("GraphQL errors 无 data：按扩展码映射为 GitHubProviderError", async () => {
  const unauthorized = stubClient(() => ({
    errors: [{ message: "Bad credentials", extensions: { code: "INSUFFICIENT_TOKENS" } }],
  }));
  await assert.rejects(
    unauthorized.client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "unauthorized" &&
      error.operation === "getClosingReferences",
  );

  const rateLimited = stubClient(() => ({
    errors: [{ message: "There are too many concurrent requests", extensions: { code: "RESOURCE_EXHAUSTED" } }],
  }));
  await assert.rejects(
    rateLimited.client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "rate_limited",
  );

  const notFound = stubClient(() => ({
    errors: [{ message: "Could not resolve to a Repository", extensions: { code: "NOT_FOUND" } }],
  }));
  await assert.rejects(
    notFound.client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "not_found",
  );
});

test("部分 errors 仍带 data 时不抛错：按字段事实返回", async () => {
  const { client } = stubClient(() => ({
    errors: [{ message: "Something odd", extensions: { code: "CUSTOM" } }],
    data: {
      repository: {
        nameWithOwner: "react/react",
        pr0: {
          number: 7,
          state: "MERGED",
          merged: true,
          mergedAt: "2026-01-02T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          baseRefName: "main",
          url: "",
          closingIssuesReferences: { nodes: [{ number: 3 }] },
        },
      },
    },
  }));
  const result = await client.getClosingReferences({ ...repo, issueNumber: 3, pullNumbers: [7] });
  assert.equal(result.facts[0]?.closingIssueNumbers?.[0], 3);
});

test("HTTP 层失败沿用统一网络语义：5xx→server_error 可重试，404→not_found", async () => {
  let calls = 0;
  const client = new GithubGraphQlClient({
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "502" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    env: { GITHUB_TOKEN: "t" },
    maxRetries: 1,
    backoffMs: 1,
  });
  await assert.rejects(
    client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "server_error",
  );
  assert.equal(calls, 2, "server errors keep the shared retry semantics");

  const client404 = new GithubGraphQlClient({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    env: {},
    maxRetries: 0,
  });
  await assert.rejects(
    client404.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "not_found",
  );
});

test("fetch 抛异常按 network_error 包装（与 REST 客户端一致）", async () => {
  const client = new GithubGraphQlClient({
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
    env: {},
    maxRetries: 0,
  });
  await assert.rejects(
    client.getClosingReferences({ ...repo, issueNumber: 1, pullNumbers: [1] }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "network_error",
  );
});

test("19-C getIssueLinkedPulls：closed_by 与 timeline 挂接编号解析（#37652 渠道）", async () => {
  const { client, requests } = stubClient(() => ({
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: { nodes: [{ number: 37651 }, { number: 37653 }] },
          timelineItems: {
            nodes: [
              { __typename: "LabeledEvent" },
              { __typename: "ConnectedEvent", subject: { __typename: "PullRequest", number: 4242 } },
              { __typename: "CrossReferencedEvent", source: { __typename: "Issue", number: 999 } },
            ],
          },
        },
      },
    },
  }));

  const facts = await client.getIssueLinkedPulls({ ...repo, issueNumber: 37652 });

  assert.deepEqual(facts.closedBy, [37651, 37653]);
  assert.deepEqual(facts.connected, [4242], "只有 PullRequest 类型挂接计入 PR 编号");
  assert.equal(facts.truncated, false);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.body.query, /closedByPullRequestsReferences\(first:\s*50\)/);
  assert.match(requests[0]!.body.query, /ConnectedEvent \{ subject/);
  assert.equal(requests[0]!.body.variables.number, 37652);
});

test("19-C getPullsForCommits：别名查询声明全部 $oid 变量并解析关联 PR", async () => {
  const { client, requests } = stubClient(() => ({
    data: {
      repository: {
        c0: { associatedPullRequests: { nodes: [{ number: 36734 }] } },
        c1: null,
      },
    },
  }));

  const results = await client.getPullsForCommits({
    owner: repo.owner,
    repo: repo.repo,
    oids: ["OID-A", " OID-A ", "OID-B", ""],
  });

  assert.deepEqual(results, [
    { oid: "OID-A", pullNumbers: [36734] },
    { oid: "OID-B", pullNumbers: [] },
  ]);
  assert.equal(requests.length, 1, "去重后两个 oid 一次别名查询");
  assert.match(
    requests[0]!.body.query,
    /query\(\$owner: String!, \$name: String!, \$oid0: GitObjectID!, \$oid1: GitObjectID!\)/,
  );
  assert.equal(requests[0]!.body.variables.oid1, "OID-B");
});
