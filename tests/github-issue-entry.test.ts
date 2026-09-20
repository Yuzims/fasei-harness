import assert from "node:assert/strict";
import test from "node:test";
import {
  investigateGitHubIssue,
  investigationCatalog,
  type InvestigateGitHubIssueOptions,
} from "../src/server/investigation-service.js";
import { InvestigationHttpError } from "../src/server/investigation-errors.js";
import { GitHubIssueInputError } from "../src/github/issue-input.js";
import { formatInvestigationSession } from "../examples/investigate.js";
import type { InvestigationSessionDTO } from "../src/api/dto.js";

const noLlmEnv = {
  AGENT_MODEL: undefined,
  OPENAI_API_KEY: undefined,
  LLM_API_KEY: undefined,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function liveFetch(calls: string[], owner: string, repo: string, issueNumber: number): typeof fetch {
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
                    function: { name: "github_get_issue", arguments: JSON.stringify({ owner, repo, issueNumber }) },
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

function networkForbidden(): typeof fetch {
  return async (input) => {
    throw new Error(`must not touch the network: ${String(input)}`);
  };
}

test("Entry: https://github.com/owner/repo/issues/123 parses through the existing parser into LIVE", async () => {
  const calls: string[] = [];
  const session = await investigateGitHubIssue("https://github.com/acme/demo/issues/123", {
    env: noLlmEnv,
    fetchImpl: liveFetch(calls, "acme", "demo", 123),
  });
  assert.equal(session.mode, "live");
  assert.equal(session.dataSource, "live");
  assert.deepEqual(session.task, {
    owner: "acme",
    repository: "demo",
    issueNumber: 123,
    description: session.task.description,
  });
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/acme/demo/issues/123")));
});

test("Entry: owner/repo#123 parses through the existing parser into LIVE", async () => {
  const calls: string[] = [];
  const session = await investigateGitHubIssue("acme/demo#123", {
    env: noLlmEnv,
    fetchImpl: liveFetch(calls, "acme", "demo", 123),
  });
  assert.equal(session.mode, "live");
  assert.equal(session.task.owner, "acme");
  assert.equal(session.task.repository, "demo");
  assert.equal(session.task.issueNumber, 123);
});

test("Entry: invalid input fails in the parser before any network call", async () => {
  const options: InvestigateGitHubIssueOptions = { env: noLlmEnv, fetchImpl: networkForbidden() };
  await assert.rejects(() => investigateGitHubIssue("not-an-issue", options), GitHubIssueInputError);
  await assert.rejects(
    () => investigateGitHubIssue("https://github.com/acme/demo/pull/1", options),
    GitHubIssueInputError,
  );
});

test("Entry: mode is explicit and defaults to LIVE, never silently switching to a snapshot", async () => {
  const snapshotItem = investigationCatalog().snapshots[0];
  assert.ok(snapshotItem, "real-v1 dataset must contain at least one snapshot case");
  const input = `${snapshotItem.owner}/${snapshotItem.repository}#${snapshotItem.issueNumber}`;
  const calls: string[] = [];
  const session = await investigateGitHubIssue(input, {
    env: noLlmEnv,
    fetchImpl: liveFetch(calls, snapshotItem.owner, snapshotItem.repository, snapshotItem.issueNumber),
  });
  assert.equal(session.mode, "live");
  assert.equal(session.catalogId, undefined);
  assert.notEqual(session.actor, "test_driver");
  assert.ok(calls.every((url) => url.includes("api.github.com")));
});

test("Entry: snapshot mode replays recorded data only and 404s without touching the network", async () => {
  const snapshotItem = investigationCatalog().snapshots[0];
  const replay = await investigateGitHubIssue(
    `${snapshotItem.owner}/${snapshotItem.repository}#${snapshotItem.issueNumber}`,
    { mode: "snapshot", fetchImpl: networkForbidden() },
  );
  assert.equal(replay.mode, "snapshot");
  assert.equal(replay.actor, "test_driver");
  assert.equal(replay.verification?.status, "verified_complete");

  await assert.rejects(
    () =>
      investigateGitHubIssue("acme/nonexistent#999999", {
        mode: "snapshot",
        fetchImpl: networkForbidden(),
      }),
    (error: unknown) =>
      error instanceof InvestigationHttpError && error.status === 404 && error.body.error.code === "SNAPSHOT_NOT_FOUND",
  );
});

test("Entry: real issue flows through task → investigation → evidence → verification result", async () => {
  const calls: string[] = [];
  const session = await investigateGitHubIssue("https://github.com/debug-js/debug/issues/1", {
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
      OPENAI_BASE_URL: "https://llm.test/v1",
    },
    fetchImpl: liveWithConfiguredModelFetch(calls, "debug-js", "debug", 1),
  });
  assert.equal(session.actor, "llm");
  assert.equal(session.task.owner, "debug-js");
  assert.equal(session.task.issueNumber, 1);
  assert.ok(session.evidence.some((item) => item.kind === "issue"));
  assert.ok(Array.isArray(session.claims));
  assert.ok(Array.isArray(session.claimEvidence));
  assert.notEqual(session.verification?.status, undefined);
  assert.notEqual(session.status, undefined);
  assert.ok(calls.some((url) => url.includes("api.github.com/repos/debug-js/debug/issues/1")));
});

function fakeSession(overrides: Partial<InvestigationSessionDTO> = {}): InvestigationSessionDTO {
  const base = {
    mode: "live",
    dataSource: "live",
    actor: "llm",
    status: "completed",
    runStatus: "completed",
    task: { owner: "acme", repository: "demo", issueNumber: 123, description: "Investigate." },
    issue: { owner: "acme", repository: "demo", number: 123, url: "https://github.com/acme/demo/issues/123" },
    agentOutput: "the agent answered",
    evidence: [
      { id: "ev-1", kind: "issue", summary: "issue body observed", trust: "primary", url: "https://github.com/acme/demo/issues/123" },
    ],
    relations: [],
    claims: [{ id: "cl-1", text: "The issue is resolved by commit abc.", polarity: "positive", critical: true }],
    claimEvidence: [{ claimId: "cl-1", evidenceId: "ev-1", role: "supports" }],
    steps: [],
    attempts: [
      {
        id: "at-1",
        attempt: 1,
        checks: [],
        failureType: "evidence_gap",
        failureReason: "missing commit evidence",
        recoveryAction: "retrieve_commits",
        recoveryReason: "expand commit discovery",
        evidenceIds: ["ev-1"],
        claimIds: ["cl-1"],
      },
    ],
    report: { conclusion: "resolved", polarity: "positive", uncertainty: "low", openQuestions: [] },
  } as InvestigationSessionDTO;
  return { ...base, ...overrides };
}

test("CLI output keeps Investigation Status and Verification Status separate and lists the full chain", () => {
  const output = formatInvestigationSession(
    fakeSession({ verification: { status: "verified_complete", evidenceCoverage: 1, prematureCompletion: false, missingRequirementIds: [], unsupportedClaimIds: [], checks: [] } }),
  );
  assert.match(output, /Target:\s+acme\/demo#123/);
  assert.match(output, /Mode:\s+live/);
  assert.match(output, /Investigation Status:\s+completed/);
  assert.match(output, /Verification Status:\s+verified_complete/);
  assert.match(output, /Evidence \(1\):/);
  assert.match(output, /Claims \(1\):/);
  assert.match(output, /Claim Evidence \(1\):/);
  assert.match(output, /Failure:/);
  assert.match(output, /evidence_gap/);
  assert.match(output, /Recovery:/);
  assert.match(output, /retrieve_commits/);
  assert.match(output, /Agent Conclusion \(unverified claim, not a verdict\)/);
});

test("CLI output: a completed investigation with a failed verification is printed as two distinct statuses", () => {
  const output = formatInvestigationSession(
    fakeSession({ verification: { status: "verification_incomplete", evidenceCoverage: 0.5, prematureCompletion: true, missingRequirementIds: ["r-1"], unsupportedClaimIds: ["cl-1"], checks: [] } }),
  );
  assert.match(output, /Investigation Status:\s+completed/);
  assert.match(output, /Verification Status:\s+verification_incomplete/);
});

test("CLI output: missing verification prints not_performed, not a fake pass", () => {
  const output = formatInvestigationSession(fakeSession({ verification: undefined }));
  assert.match(output, /Verification Status:\s+not_performed/);
});
