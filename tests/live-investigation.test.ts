import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveInvestigationRoute, runInvestigation } from "../src/server/investigation-service.js";
import { GitHubProviderError } from "../src/github/errors.js";

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
