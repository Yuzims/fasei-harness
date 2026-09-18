import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureInvestigationSnapshot, finalizeInvestigationSnapshot } from "../src/github/capture.js";
import { GitHubProviderError } from "../src/github/errors.js";
import { LiveGitHubProvider } from "../src/github/live-provider.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import {
  githubFixturePath,
  loadSnapshot,
  saveSnapshot,
  validateSnapshot,
} from "../src/github/snapshot-store.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resolvedRest(url: string): Response {
  const path = new URL(url).pathname;
  if (path === "/repos/acme/box") {
    return jsonResponse({
      full_name: "acme/box",
      html_url: "https://github.com/acme/box",
      description: "Sample",
      default_branch: "main",
    });
  }
  if (path === "/repos/acme/box/issues/42") {
    return jsonResponse({
      number: 42,
      title: "Null pointer",
      body: "bug",
      state: "closed",
      state_reason: "completed",
      html_url: "https://github.com/acme/box/issues/42",
      closed_at: "2026-08-01T12:00:00Z",
    });
  }
  if (path === "/repos/acme/box/issues/42/comments") {
    return jsonResponse([
      {
        id: 1,
        body: "Fixed in #7.",
        user: { login: "maintainer" },
        created_at: "2026-08-01T11:00:00Z",
        html_url: "https://github.com/acme/box/issues/42#comment-1",
      },
    ]);
  }
  if (path === "/repos/acme/box/issues/42/timeline") {
    return jsonResponse([
      {
        id: 9,
        event: "connected",
        created_at: "2026-08-01T10:00:00Z",
        actor: { login: "maintainer" },
        pull_request: { number: 7 },
      },
    ]);
  }
  if (path === "/repos/acme/box/pulls/7") {
    return jsonResponse({
      number: 7,
      title: "Fix",
      body: "Fixes #42",
      state: "closed",
      merged: true,
      merge_commit_sha: "abc123def456",
      html_url: "https://github.com/acme/box/pull/7",
      head: { sha: "abc123def456" },
    });
  }
  if (path === "/repos/acme/box/pulls/7/reviews") {
    return jsonResponse([
      { id: 1, state: "APPROVED", body: "ok", user: { login: "reviewer" } },
    ]);
  }
  if (path === "/repos/acme/box/pulls/7/files") {
    return jsonResponse([
      { filename: "src/cart.ts", status: "modified", additions: 8, deletions: 2 },
    ]);
  }
  if (path === "/repos/acme/box/pulls/7/commits" || path === "/repos/acme/box/commits") {
    return jsonResponse([
      {
        sha: "abc123def456",
        html_url: "https://github.com/acme/box/commit/abc123def456",
        commit: { message: "Fix empty cart", author: { name: "maintainer" } },
        author: { login: "maintainer" },
      },
    ]);
  }
  if (path === "/repos/acme/box/commits/abc123def456") {
    return jsonResponse({
      sha: "abc123def456",
      html_url: "https://github.com/acme/box/commit/abc123def456",
      commit: { message: "Fix empty cart", author: { name: "maintainer" } },
      author: { login: "maintainer" },
    });
  }
  return jsonResponse({ message: "not found" }, 404);
}

test("Snapshot：resolved fixture 能读出 issue / PR merge / files / commits", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const issue = await provider.getIssue({ owner: "acme", repo: "box", issueNumber: 42 });
  const comments = await provider.getIssueComments({ owner: "acme", repo: "box", issueNumber: 42 });
  const timeline = await provider.getIssueTimeline({ owner: "acme", repo: "box", issueNumber: 42 });
  const pr = await provider.getPullRequest({ owner: "acme", repo: "box", pullNumber: 7 });
  const files = await provider.getPullRequestFiles({ owner: "acme", repo: "box", pullNumber: 7 });
  const reviews = await provider.getPullRequestReviews({ owner: "acme", repo: "box", pullNumber: 7 });
  const commits = await provider.listCommits({ owner: "acme", repo: "box", pullNumber: 7 });
  const commit = await provider.getCommit({ owner: "acme", repo: "box", sha: "abc123def456" });
  const repo = await provider.getRepository({ owner: "acme", repo: "box" });

  assert.equal(issue.state, "closed");
  assert.equal(issue.trust, "external_untrusted");
  assert.equal(comments.length, 1);
  assert.equal(timeline[0]?.pullRequestNumber, 7);
  assert.equal(pr.merged, true);
  assert.equal(files[0]?.filename, "src/cart.ts");
  assert.equal(reviews[0]?.state, "APPROVED");
  assert.equal(commits[0]?.sha, "abc123def456");
  assert.equal(commit.sha, "abc123def456");
  assert.equal(repo.owner, "acme");
});

test("Snapshot：closed-unmerged 的 Issue 已关闭但 PR 未合并", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("closed-unmerged"));
  const issue = await provider.getIssue({ owner: "acme", repo: "box", issueNumber: 99 });
  const pr = await provider.getPullRequest({ owner: "acme", repo: "box", pullNumber: 12 });
  assert.equal(issue.state, "closed");
  assert.equal(pr.merged, false);
  assert.equal(pr.state, "open");
});

test("Snapshot：insufficient-evidence 没有关联 PR", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence"));
  const issue = await provider.getIssue({ owner: "acme", repo: "box", issueNumber: 7 });
  const timeline = await provider.getIssueTimeline({ owner: "acme", repo: "box", issueNumber: 7 });
  assert.equal(issue.state, "closed");
  assert.equal(timeline.some((item) => item.pullRequestNumber), false);
  await assert.rejects(
    () => provider.getPullRequest({ owner: "acme", repo: "box", pullNumber: 1 }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "not_found",
  );
});

test("Live → Snapshot replay 得到同一套 normalized 调查链", async () => {
  const live = new LiveGitHubProvider({
    fetchImpl: async (input) => resolvedRest(String(input)),
    now: () => "2026-09-17T00:00:00.000Z",
  });
  const captured = await captureInvestigationSnapshot(live, {
    snapshotId: "live-resolved",
    owner: "acme",
    repo: "box",
    issueNumber: 42,
    createdAt: "2026-09-17T00:00:00.000Z",
  });
  const dir = mkdtempSync(join(tmpdir(), "fasei-snap-"));
  const file = join(dir, "resolved.json");
  saveSnapshot(file, captured);
  const replay = new SnapshotGitHubProvider(loadSnapshot(file));

  const liveIssue = await live.getIssue({ owner: "acme", repo: "box", issueNumber: 42 });
  const replayIssue = await replay.getIssue({ owner: "acme", repo: "box", issueNumber: 42 });
  const livePr = await live.getPullRequest({ owner: "acme", repo: "box", pullNumber: 7 });
  const replayPr = await replay.getPullRequest({ owner: "acme", repo: "box", pullNumber: 7 });
  const liveFiles = await live.getPullRequestFiles({ owner: "acme", repo: "box", pullNumber: 7 });
  const replayFiles = await replay.getPullRequestFiles({ owner: "acme", repo: "box", pullNumber: 7 });
  const liveCommits = await live.listCommits({ owner: "acme", repo: "box", pullNumber: 7 });
  const replayCommits = await replay.listCommits({ owner: "acme", repo: "box", pullNumber: 7 });

  assert.deepEqual(replayIssue, liveIssue);
  assert.deepEqual(replayPr, livePr);
  assert.deepEqual(replayFiles, liveFiles);
  assert.deepEqual(replayCommits, liveCommits);
  assert.equal(replayPr.merged, true);
  assert.equal(captured.trust, "external_untrusted");
});

test("Snapshot schema：缺字段 / 错误版本 / 坏 JSON / 缺文件", () => {
  assert.throws(
    () => validateSnapshot({ schemaVersion: 1 }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "invalid_snapshot",
  );
  assert.throws(
    () => validateSnapshot({ schemaVersion: 99, snapshotId: "x" }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "invalid_snapshot",
  );
  const dir = mkdtempSync(join(tmpdir(), "fasei-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json", "utf8");
  assert.throws(
    () => loadSnapshot(bad),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "invalid_snapshot",
  );
  assert.throws(
    () => loadSnapshot(join(dir, "missing.json")),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "not_found",
  );
});

test("Live：401 / 404 / 429 / 5xx / network 归一到 GitHubProviderError", async () => {
  const unauthorized = new LiveGitHubProvider({
    fetchImpl: async () => jsonResponse({ message: "bad credentials" }, 401),
    maxRetries: 0,
  });
  await assert.rejects(
    () => unauthorized.getIssue({ owner: "acme", repo: "box", issueNumber: 1 }),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "unauthorized" &&
      error.retryable === false &&
      error.status === 401,
  );

  const missing = new LiveGitHubProvider({
    fetchImpl: async () => jsonResponse({ message: "not found" }, 404),
    maxRetries: 0,
  });
  await assert.rejects(
    () => missing.getIssue({ owner: "acme", repo: "box", issueNumber: 1 }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "not_found",
  );

  let limitedCalls = 0;
  const limited = new LiveGitHubProvider({
    fetchImpl: async () => {
      limitedCalls += 1;
      return new Response("rate limit", { status: 429, headers: { "retry-after": "30" } });
    },
    maxRetries: 1,
    backoffMs: 1,
  });
  await assert.rejects(
    () => limited.getRepository({ owner: "acme", repo: "box" }),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "rate_limited" &&
      error.retryable &&
      error.retryAfterSeconds === 30,
  );
  assert.equal(limitedCalls, 2);

  let serverCalls = 0;
  const server = new LiveGitHubProvider({
    fetchImpl: async () => {
      serverCalls += 1;
      return jsonResponse({ message: "boom" }, 503);
    },
    maxRetries: 1,
    backoffMs: 1,
  });
  await assert.rejects(
    () => server.getRepository({ owner: "acme", repo: "box" }),
    (error: unknown) =>
      error instanceof GitHubProviderError && error.code === "server_error" && error.retryable,
  );
  assert.equal(serverCalls, 2);

  const network = new LiveGitHubProvider({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    maxRetries: 0,
  });
  await assert.rejects(
    () => network.getRepository({ owner: "acme", repo: "box" }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "network_error",
  );
});

test("Live：403 remaining=0 归为 rate_limited", async () => {
  const limited = new LiveGitHubProvider({
    fetchImpl: async () =>
      new Response("forbidden", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
      }),
    maxRetries: 0,
  });
  await assert.rejects(
    () => limited.getIssue({ owner: "acme", repo: "box", issueNumber: 1 }),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "rate_limited" &&
      error.retryAt !== undefined,
  );
});

test("Live：429 之后成功则完成请求", async () => {
  let calls = 0;
  const provider = new LiveGitHubProvider({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("wait", { status: 429 });
      }
      return jsonResponse({
        full_name: "acme/box",
        html_url: "https://github.com/acme/box",
      });
    },
    maxRetries: 2,
    backoffMs: 1,
  });
  const repo = await provider.getRepository({ owner: "acme", repo: "box" });
  assert.equal(repo.repository, "acme/box");
  assert.equal(calls, 2);
});

test("Live：超时归为 timeout", async () => {
  const provider = new LiveGitHubProvider({
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: async (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(
    () => provider.getRepository({ owner: "acme", repo: "box" }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "timeout",
  );
});

function commentLinkedRest(url: string): Response {
  const path = new URL(url).pathname;
  if (path === "/repos/acme/box/issues/42/timeline") {
    return jsonResponse([
      {
        id: 1,
        event: "closed",
        created_at: "2026-08-01T12:00:00Z",
        actor: { login: "maintainer" },
      },
    ]);
  }
  return resolvedRest(url);
}

test("Capture：comment mention of a real PR is fetched even when timeline omits the link", async () => {
  const live = new LiveGitHubProvider({
    fetchImpl: async (input) => commentLinkedRest(String(input)),
    now: () => "2026-09-17T00:00:00.000Z",
  });
  const captured = await captureInvestigationSnapshot(live, {
    snapshotId: "comment-linked",
    owner: "acme",
    repo: "box",
    issueNumber: 42,
    includeTimelinePulls: false,
    includeRepoCommits: false,
    createdAt: "2026-09-17T00:00:00.000Z",
  });
  assert.equal(captured.pullRequests["7"]?.number, 7);
  assert.equal(captured.pullRequests["7"]?.merged, true);
  assert.ok(captured.files["7"]?.some((file) => file.filename.includes("cart.ts")));
  assert.ok(captured.timeline.some((event) => event.pullRequestNumber === 7));
});

test("finalizeInvestigationSnapshot records closing-keyword PRs without ground-truth labels", () => {
  const snapshot = loadSnapshot(githubFixturePath("resolved"));
  snapshot.timeline = snapshot.timeline.map((event) => ({ ...event, pullRequestNumber: undefined }));
  const finalized = finalizeInvestigationSnapshot(snapshot);
  assert.equal(
    finalized.timeline.some((event) => event.event === "cross-referenced" && event.pullRequestNumber === 7),
    true,
  );
  const blob = JSON.stringify(finalized);
  assert.equal(blob.includes("expectedOutcome"), false);
  assert.equal(blob.includes("expectedFailureModes"), false);
  assert.equal(blob.includes("correct_pr"), false);
  assert.equal(blob.includes("wrong_target"), false);
});
