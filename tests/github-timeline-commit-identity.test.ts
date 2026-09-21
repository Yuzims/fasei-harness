import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LiveGitHubProvider } from "../src/github/live-provider.js";
import { extractCommitShas, normalizeTimelineEvent } from "../src/github/normalize.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath, loadSnapshot, saveSnapshot } from "../src/github/snapshot-store.js";
import type { TimelineEventSnapshot } from "../src/github/types.js";

const OWNER = "microsoft";
const REPO = "vscode";
const RETRIEVED_AT = "2026-09-20T00:00:00.000Z";
const SHA = "67f18f167f3b21708fbd2c35a7cce20670c59b12";

function normalize(raw: Record<string, unknown>): TimelineEventSnapshot {
  return normalizeTimelineEvent(raw, OWNER, REPO, RETRIEVED_AT);
}

test("Timeline normalize：commit_id 与 body 各自保留为独立字段", () => {
  const event = normalize({
    id: 1,
    event: "referenced",
    created_at: "2026-09-01T00:00:00Z",
    actor: { login: "maintainer" },
    commit_id: SHA,
    body: "fixes #258694",
  });

  assert.equal(event.commitId, SHA);
  assert.equal(event.body, "fixes #258694");
});

test("Timeline normalize：body 不含 SHA 时 commit identity 仍然保留", () => {
  const event = normalize({
    id: 2,
    event: "referenced",
    created_at: "2026-09-01T00:00:00Z",
    commit_id: SHA,
    body: "some ordinary timeline text",
  });

  assert.equal(event.commitId, SHA);
  assert.equal(event.body, "some ordinary timeline text");
  assert.equal(event.body.includes(SHA), false);
});

test("Timeline normalize：没有 commit_id 时 commitId 为 undefined 而不是空串", () => {
  const event = normalize({
    id: 3,
    event: "commented",
    created_at: "2026-09-01T00:00:00Z",
    body: "ordinary timeline event",
  });

  assert.equal(event.commitId, undefined);
  assert.ok(!("commitId" in event));
  assert.equal(JSON.parse(JSON.stringify(event)).commitId, undefined);
});

test("Timeline normalize：body 里的 SHA 文本不会被当成 commit identity", () => {
  const event = normalize({
    id: 4,
    event: "commented",
    created_at: "2026-09-01T00:00:00Z",
    body: `discussion mentions ${SHA}`,
  });

  assert.equal(event.commitId, undefined);
  assert.equal(event.body, `discussion mentions ${SHA}`);
});

test("Timeline normalize：空白 commit_id 视作缺失", () => {
  const event = normalize({
    id: 5,
    event: "referenced",
    created_at: "2026-09-01T00:00:00Z",
    commit_id: "   ",
    body: "",
  });

  assert.equal(event.commitId, undefined);
  assert.equal(event.body, "");
});

test("Live 与 snapshot 回放对 commitId 行为一致", async () => {
  const rawTimeline = [
    { id: 10, event: "referenced", created_at: "2026-09-01T00:00:00Z", commit_id: SHA },
    { id: 11, event: "commented", created_at: "2026-09-02T00:00:00Z", body: "no commit here" },
  ];
  const fixtureRef = { owner: "acme", repo: "box", issueNumber: 42 };
  const live = new LiveGitHubProvider({
    fetchImpl: async (input) =>
      new Response(JSON.stringify(rawTimeline), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    now: () => RETRIEVED_AT,
  });
  const liveEvents = await live.getIssueTimeline(fixtureRef);

  const snapshot = loadSnapshot(githubFixturePath("resolved"));
  const dir = mkdtempSync(join(tmpdir(), "fasei-timeline-commitid-"));
  const filePath = join(dir, "snapshot.json");
  snapshot.timeline = liveEvents;
  saveSnapshot(filePath, snapshot);
  const replayed = await new SnapshotGitHubProvider(filePath).getIssueTimeline(fixtureRef);

  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(liveEvents)));
  assert.equal(replayed[0]?.commitId, SHA);
  assert.equal(replayed[0]?.body, "");
  assert.equal(replayed[1]?.commitId, undefined);
  assert.equal(extractCommitShas(replayed)[0], SHA.toLowerCase());
});

test("历史录制 snapshot：SHA 仅在 body 中时不回填 commitId，但仍能发现 commit", () => {
  const recorded = loadSnapshot(
    fileURLToPath(new URL("../fixtures/benchmark/dataset/real-v1/cases/C01/snapshot.json", import.meta.url)),
  );
  const referenced = recorded.timeline.find(
    (event) => event.event === "referenced" && event.body.includes(SHA),
  );

  assert.ok(referenced, "C01 records the vscode#258694 SHA inside body");
  assert.equal(referenced?.commitId, undefined);
  assert.equal(extractCommitShas(recorded.timeline).includes(SHA), true);
});

test("Regression microsoft/vscode#258694：commit identity 不再只存在于 body 中", () => {
  const event = normalize({
    id: 900,
    event: "referenced",
    created_at: "2026-09-01T00:00:00Z",
    actor: { login: "maintainer" },
    commit_id: SHA,
    commit_author: { login: "maintainer" },
  });

  assert.equal(event.commitId, SHA);
  assert.equal(event.body, "");
  assert.equal(extractCommitShas([event]).includes(SHA), true);
});
