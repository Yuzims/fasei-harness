import assert from "node:assert/strict";
import test from "node:test";
import { resolveInvestigationRoute, runInvestigation } from "../src/server/investigation-service.js";
import { GitHubProviderError } from "../src/github/errors.js";

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
    { fetchImpl: liveFetch(calls, "microsoft", "vscode", 258694) },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.dataSource, "live");
  assert.equal(session.catalogId, undefined);
  assert.equal(session.group, undefined);
  assert.equal(session.issue.owner, "microsoft");
  assert.equal(session.issue.repository, "vscode");
  assert.equal(session.issue.number, 258694);
  assert.equal(session.issue.title, "Live public issue");
  assert.notEqual(session.verification?.status, undefined);
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/microsoft/vscode/issues/258694")));
  assert.equal(
    calls.some((url) => url.includes("C01") || url.includes("snapshot")),
    false,
  );
});

test("SNAPSHOT → SnapshotProvider and never calls GitHub HTTP", async () => {
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
  assert.equal(session.verification?.status, "verified_complete");
  assert.equal(calls.length, 0);
});

test("LIVE unknown issue returns GitHubProviderError, not a fake snapshot", async () => {
  await assert.rejects(
    () =>
      runInvestigation(
        { issue: "https://github.com/foo/bar/issues/999999999", mode: "live" },
        {
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
    { fetchImpl: liveFetch(calls, "acme", "box", 42) },
  );
  assert.equal(session.mode, "live");
  assert.equal(session.catalogId, undefined);
  assert.equal(session.issue.title, "Live public issue");
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/acme/box/issues/42")));
});
