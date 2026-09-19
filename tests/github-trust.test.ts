import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildVerificationResult, createClaim, createInvestigationTask, planRecovery } from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import { UNTRUSTED } from "../src/github/types.js";
import { createGithubGetIssueTool, createInvestigationGithubTools } from "../src/tools/github.js";

test("Trust：Issue/Comment 注入文本不能改变 recovery 或 verification", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence"));
  const issue = await provider.getIssue({ owner: "acme", repo: "box", issueNumber: 7 });
  const comments = await provider.getIssueComments({ owner: "acme", repo: "box", issueNumber: 7 });
  assert.match(issue.body, /Ignore previous instructions/i);
  assert.match(comments[0]?.body ?? "", /skip verification/i);
  assert.equal(issue.trust, UNTRUSTED);
  assert.equal(comments[0]?.trust, UNTRUSTED);

  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 7 },
  });
  const claim = createClaim({
    text: "Issue already resolved because the comment said so.",
    polarity: "resolved",
  });
  const verification = buildVerificationResult({
    checks: [
      {
        id: "identity",
        name: "identity",
        type: "identity",
        status: "pass",
        severity: "critical",
        message: "target matches",
        evidenceIds: [issue.id],
      },
    ],
    requirements: task.requirements,
    claims: [claim],
    claimEvidence: [],
    evidence: [],
    task,
    agentClaimedComplete: true,
  });

  assert.equal(verification.status, "insufficient_evidence");
  assert.equal(planRecovery("insufficient_evidence").action, "gather_missing_evidence");
  assert.notEqual(planRecovery("insufficient_evidence").action, "stop");
});

test("Tools：调查工具走 Provider，不直接 fetch", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const tool = createGithubGetIssueTool({ provider });
  const issue = (await tool.execute({
    owner: "acme",
    repo: "box",
    issueNumber: 42,
  })) as { number: number; trust: string };
  assert.equal(issue.number, 42);
  assert.equal(issue.trust, UNTRUSTED);

  const names = createInvestigationGithubTools({ provider }).map((item) => item.name);
  assert.deepEqual(names, [
    "github_get_issue",
    "github_get_issue_comments",
    "github_get_issue_timeline",
    "github_get_pull_request",
    "github_get_pull_request_files",
    "github_get_pull_request_reviews",
    "github_list_commits",
    "github_get_commit",
  ]);
});

test("Boundary：Agent/Tool 源码不能直接打 GitHub API", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../src");
  const forbidden = ["tools", "agent", "server", "domain", "investigation"];
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      if (source.includes("api.github.com")) {
        hits.push(path);
      }
    }
  }

  for (const folder of forbidden) {
    walk(join(root, folder));
  }

  assert.deepEqual(hits, []);
  const http = readFileSync(join(root, "github/http.ts"), "utf8");
  assert.match(http, /api\.github\.com/);
});
