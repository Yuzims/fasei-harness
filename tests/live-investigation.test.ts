import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveInvestigationRoute, runInvestigation } from "../src/server/investigation-service.js";
import { GitHubProviderError } from "../src/github/errors.js";
import { LiveGitHubProvider } from "../src/github/live-provider.js";
import { investigate } from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const noLlmEnv = {
  AGENT_MODEL: undefined,
  OPENAI_API_KEY: undefined,
  LLM_API_KEY: undefined,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function liveFetch(calls: string[], owner = "acme", repo = "demo", issueNumber = 7): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === `/repos/${owner}/${repo}/issues/${issueNumber}`) {
      return jsonResponse({
        number: issueNumber,
        title: "Live public issue",
        body: "observed from GitHub API",
        state: "open",
        html_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
      });
    }
    if (
      path === `/repos/${owner}/${repo}/issues/${issueNumber}/comments` ||
      path === `/repos/${owner}/${repo}/issues/${issueNumber}/timeline` ||
      path === `/repos/${owner}/${repo}/commits`
    ) {
      return jsonResponse([]);
    }
    return jsonResponse({ message: "Not Found" }, 404);
  };
}

function liveWithConfiguredModelFetch(
  calls: string[],
  owner: string,
  repo: string,
  issueNumber: number,
): typeof fetch {
  const github = liveFetch(calls, owner, repo, issueNumber);
  let llmCalls = 0;
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      calls.push(url);
      llmCalls += 1;
      if (llmCalls === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "github_get_issue",
                      arguments: JSON.stringify({ owner, repo, issueNumber }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
      });
    }
    return github(input, init);
  };
}

test("Routing：issue input defaults to LIVE, catalog ids stay SNAPSHOT", () => {
  const live = resolveInvestigationRoute({ issue: "microsoft/vscode#258694" });
  assert.equal(live.mode, "live");
  if (live.mode !== "live") {
    throw new Error("expected live route");
  }
  assert.equal(live.target.issueNumber, 258694);

  const explicitLive = resolveInvestigationRoute({
    issue: "https://github.com/microsoft/vscode/issues/258694",
    mode: "live",
  });
  assert.equal(explicitLive.mode, "live");

  const snapshotIssue = resolveInvestigationRoute({
    issue: "microsoft/vscode#258694",
    mode: "snapshot",
  });
  assert.equal(snapshotIssue.mode, "snapshot");

  const caseRoute = resolveInvestigationRoute({ caseId: "C01" });
  assert.equal(caseRoute.mode, "snapshot");
  assert.equal(caseRoute.via, "case");

  const scenarioRoute = resolveInvestigationRoute({ scenarioId: "tool-failure" });
  assert.equal(scenarioRoute.mode, "snapshot");
  assert.equal(scenarioRoute.via, "scenario");
});

test("LIVE → GitHubDataProvider, not SnapshotProvider, even for a Real-v1 issue", async () => {
  const calls: string[] = [];
  const session = await runInvestigation(
    { issue: "microsoft/vscode#258694", mode: "live" },
    { env: noLlmEnv, fetchImpl: liveFetch(calls, "microsoft", "vscode", 258694) },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.dataSource, "live");
  assert.equal(session.catalogId, undefined);
  assert.equal(session.group, undefined);
  assert.equal(session.issue.owner, "microsoft");
  assert.equal(session.issue.repository, "vscode");
  assert.equal(session.issue.number, 258694);
  assert.notEqual(session.actor, "test_driver");
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/microsoft/vscode/issues/258694")));
  assert.equal(
    calls.some((url) => url.includes("C01") || url.includes("snapshot")),
    false,
  );
});

test("LIVE without an LLM key is unconfigured and does not use SnapshotInvestigationDriver", async () => {
  const calls: string[] = [];
  const session = await runInvestigation(
    { issue: "https://github.com/debug-js/debug/issues/1", mode: "live" },
    { env: noLlmEnv, fetchImpl: liveFetch(calls, "debug-js", "debug", 1) },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.actor, "unconfigured");
  assert.equal(session.status, "unconfigured");
  assert.notEqual(session.actor, "test_driver");
  assert.match(session.agentOutput, /unconfigured/i);
  assert.match(session.agentOutput, /no OpenAI-compatible API key/i);
  assert.equal(session.verification, undefined);
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/debug-js/debug/issues/1")));
  assert.equal(
    calls.some((url) => url.includes("/chat/completions")),
    false,
  );
});

test("LIVE with a configured model uses the real Investigation Agent path", async () => {
  const calls: string[] = [];
  const session = await runInvestigation(
    { issue: "https://github.com/debug-js/debug/issues/1", mode: "live" },
    {
      env: {
        AGENT_MODEL: "openai",
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: "gpt-test",
        OPENAI_BASE_URL: "https://llm.test/v1",
      },
      fetchImpl: liveWithConfiguredModelFetch(calls, "debug-js", "debug", 1),
    },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.actor, "llm");
  assert.notEqual(session.actor, "test_driver");
  assert.notEqual(session.actor, "unconfigured");
  assert.equal(session.issue.title, "Live public issue");
  assert.ok(session.evidence.some((item) => item.kind === "issue"));
  assert.notEqual(session.verification?.status, undefined);
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/debug-js/debug/issues/1")));
  assert.ok(calls.some((url) => url.includes("https://llm.test/v1/chat/completions")));
  assert.ok((session.llmUsage?.llmCalls ?? 0) >= 1);
  assert.equal(session.llmUsage?.calls.some((call) => call.ok), true);
});

test("SNAPSHOT → SnapshotInvestigationDriver and never calls GitHub HTTP", async () => {
  const calls: string[] = [];
  const session = await runInvestigation(
    { caseId: "C01" },
    {
      fetchImpl: async (input) => {
        calls.push(String(input));
        throw new Error("snapshot path must not call GitHub HTTP");
      },
    },
  );
  assert.equal(session.mode, "snapshot");
  assert.equal(session.dataSource, "snapshot");
  assert.equal(session.catalogId, "C01");
  assert.equal(session.actor, "test_driver");
  assert.equal(session.verification?.status, "verified_complete");
  assert.equal(calls.length, 0);
});

test("LIVE unknown issue returns GitHubProviderError, not a fake snapshot", async () => {
  await assert.rejects(
    () =>
      runInvestigation(
        { issue: "https://github.com/foo/bar/issues/999999999", mode: "live" },
        {
          env: noLlmEnv,
          fetchImpl: async () => jsonResponse({ message: "Not Found" }, 404),
        },
      ),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "not_found" &&
      error.status === 404,
  );
});

test("LIVE does not fall through to a matching snapshot fixture", async () => {
  const calls: string[] = [];
  const session = await runInvestigation(
    { issue: "acme/box#42", mode: "live" },
    { env: noLlmEnv, fetchImpl: liveFetch(calls, "acme", "box", 42) },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.catalogId, undefined);
  assert.equal(session.actor, "unconfigured");
  assert.notEqual(session.actor, "test_driver");
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/acme/box/issues/42")));
});

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) {
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

const SECRET = "github_pat_TEST_SECRET_DO_NOT_LEAK";

function assertNoSecret(value: unknown): void {
  const blob = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(blob.includes(SECRET), false, "secret must not appear in user-visible output");
}

test("LIVE Investigation sends GitHub Authorization through the HTTP layer", async () => {
  const githubAuth: boolean[] = [];
  const session = await runInvestigation(
    { issue: "acme/box#42", mode: "live" },
    {
      env: { ...noLlmEnv, GITHUB_TOKEN: "test-token" },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = headerMap(init);
        if (url.includes("api.github.com")) {
          githubAuth.push(headers.authorization === "Bearer test-token");
          assert.equal(headers.accept, "application/vnd.github+json");
          assert.equal(headers["x-github-api-version"], "2022-11-28");
        }
        return liveFetch([], "acme", "box", 42)(input, init);
      },
    },
  );

  assert.equal(session.mode, "live");
  assert.equal(session.dataSource, "live");
  assert.notEqual(session.actor, "test_driver");
  assert.equal(session.actor, "unconfigured");
  assert.equal(githubAuth.length > 0, true);
  assert.equal(
    githubAuth.every((ok) => ok),
    true,
    "every GitHub request must carry Bearer token",
  );
});

test("LIVE + configured LLM GitHub requests still use the same HTTP Authorization", async () => {
  const githubAuth: boolean[] = [];
  const llmUsedGithubToken: boolean[] = [];
  const session = await runInvestigation(
    { issue: "https://github.com/debug-js/debug/issues/1", mode: "live" },
    {
      env: {
        AGENT_MODEL: "openai",
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: "gpt-test",
        OPENAI_BASE_URL: "https://llm.test/v1",
        GITHUB_TOKEN: "test-token",
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = headerMap(init);
        if (url.includes("api.github.com")) {
          githubAuth.push(headers.authorization === "Bearer test-token");
        }
        if (url.includes("/chat/completions")) {
          llmUsedGithubToken.push(headers.authorization === "Bearer test-token");
        }
        return liveWithConfiguredModelFetch([], "debug-js", "debug", 1)(input, init);
      },
    },
  );

  assert.equal(session.mode, "live");
  assert.equal(session.actor, "llm");
  assert.notEqual(session.actor, "test_driver");
  assert.equal(githubAuth.length > 0, true);
  assert.equal(
    githubAuth.every((ok) => ok),
    true,
    "LiveGitHubProvider GitHub requests must carry Bearer token",
  );
  assert.equal(
    llmUsedGithubToken.some((used) => used),
    false,
    "LLM requests must not reuse GITHUB_TOKEN",
  );
});

test("LIVE Investigation does not leak GITHUB_TOKEN into DTO, trace, report, or errors", async () => {
  const session = await runInvestigation(
    { issue: "acme/box#42", mode: "live" },
    {
      env: { ...noLlmEnv, GITHUB_TOKEN: SECRET },
      fetchImpl: liveFetch([], "acme", "box", 42),
    },
  );
  assert.notEqual(session.actor, "test_driver");
  assertNoSecret(session);

  const trace = new TraceCollector();
  const report = await investigate({
    task: { owner: "debug-js", repository: "debug", issueNumber: 1 },
    provider: new LiveGitHubProvider({
      env: {
        AGENT_MODEL: "openai",
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: "gpt-test",
        OPENAI_BASE_URL: "https://llm.test/v1",
        GITHUB_TOKEN: SECRET,
      },
      fetchImpl: liveWithConfiguredModelFetch([], "debug-js", "debug", 1),
    }),
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
      OPENAI_BASE_URL: "https://llm.test/v1",
      GITHUB_TOKEN: SECRET,
    },
    fetchImpl: liveWithConfiguredModelFetch([], "debug-js", "debug", 1),
    trace,
  });
  assert.notEqual(report.actor, "test_driver");
  assertNoSecret(report);
  assertNoSecret(trace.getEvents());

  await assert.rejects(
    () =>
      runInvestigation(
        { issue: "foo/bar#1", mode: "live" },
        {
          env: { ...noLlmEnv, GITHUB_TOKEN: SECRET },
          fetchImpl: async () =>
            jsonResponse({ message: `unauthorized Bearer ${SECRET}` }, 401),
        },
      ),
    (error: unknown) => {
      assert.equal(error instanceof GitHubProviderError, true);
      assertNoSecret(error instanceof Error ? error.message : error);
      assertNoSecret(error instanceof Error ? error.stack : "");
      return error instanceof GitHubProviderError && error.code === "unauthorized";
    },
  );
});

test("Live investigation must not use SnapshotInvestigationDriver", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/server");
  const service = readFileSync(join(dir, "investigation-service.ts"), "utf8");
  const app = readFileSync(join(dir, "app.ts"), "utf8");
  assert.equal(service.includes("useTestDriver"), false);
  assert.equal(service.includes("SnapshotInvestigationDriver"), false);
  assert.equal(app.includes("useTestDriver"), false);
  assert.equal(app.includes("SnapshotInvestigationDriver"), false);
  const liveFn = service.slice(service.indexOf("async function runLiveIssue"));
  assert.match(liveFn, /LiveGitHubProvider/);
  assert.match(liveFn, /investigate\(/);
  assert.equal(liveFn.includes("useTestDriver"), false);
});
