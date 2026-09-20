import assert from "node:assert/strict";
import test from "node:test";
import { investigateGitHubIssue } from "../src/server/investigation-service.js";
import { formatInvestigationSession } from "../examples/investigate.js";

// Opt-in live smoke test against the real GitHub API. Normal `npm test` must not
// depend on network access. Requirements to run:
//   LIVE_GITHUB_SMOKE=1 npm test
//   - network access to api.github.com (public issues work unauthenticated, but
//     GITHUB_TOKEN is strongly recommended to avoid the 60 req/h IP rate limit)
//   - optional LLM env (OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL or AGENT_MODEL)
//     to exercise the full agent path; without it the pipeline runs in
//     "unconfigured" mode and still proves live GitHub data enters the harness.
const enabled = process.env.LIVE_GITHUB_SMOKE === "1";

test("LIVE smoke: a real public GitHub Issue enters the existing investigation pipeline", { skip: enabled ? false : "opt-in: run with LIVE_GITHUB_SMOKE=1 (needs network; GITHUB_TOKEN recommended)" }, async () => {
  const session = await investigateGitHubIssue("https://github.com/microsoft/vscode/issues/258694", {
    mode: "live",
  });
  assert.equal(session.mode, "live");
  assert.equal(session.dataSource, "live");
  assert.equal(session.catalogId, undefined);
  assert.notEqual(session.actor, "test_driver");
  assert.equal(session.task.owner, "microsoft");
  assert.equal(session.task.repository, "vscode");
  assert.equal(session.task.issueNumber, 258694);
  assert.ok(session.evidence.length > 0, "live GitHub data must produce Evidence");
  assert.ok(session.evidence.some((item) => item.kind === "issue"));
  if (session.actor === "llm") {
    assert.notEqual(session.verification?.status, undefined, "LLM path must be verified independently");
    assert.notEqual(session.report.conclusion, undefined);
  }
  console.log(formatInvestigationSession(session));
});
