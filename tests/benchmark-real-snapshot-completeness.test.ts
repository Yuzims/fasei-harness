import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  convertCaseToScenario,
  executeDatasetCase,
  loadDataset,
  loadSnapshot,
  realDatasetManifestPath,
  runRealDatasetBenchmark,
} from "../src/benchmark/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(relativeDir: string): string[] {
  const dir = join(ROOT, relativeDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

function forbiddenGroundTruth(blob: string, label: string): void {
  assert.equal(blob.includes("expectedOutcome"), false, label);
  assert.equal(blob.includes("expectedFailureModes"), false, label);
  assert.equal(blob.includes("correct_pr"), false, label);
  assert.equal(blob.includes('"wrong_target"'), false, label);
  assert.equal(blob.includes("benchmark rationale"), false, label);
}

test("C06 investigation continues after a missing comment-mentioned PR", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C06");
  const provider = new SnapshotGitHubProvider(snapshot);
  await assert.rejects(
    () => provider.getPullRequest({ owner: "cli", repo: "cli", pullNumber: 123 }),
    (error: unknown) => error instanceof Error && /not in snapshot/i.test(error.message),
  );
  const executed = await executeDatasetCase(dataset, "C06");
  const prCalls = executed.report.investigationSteps.filter((step) => step.tool === "github_get_pull_request");
  const failed123 = prCalls.filter((step) => step.arguments.pullNumber === 123 && step.success === false);
  assert.ok(failed123.length <= 2, `repeated missing PR fetches: ${failed123.length}`);
  assert.ok(executed.report.investigationSteps.some((step) => step.tool === "record_claim"));
  assert.equal(executed.observed.verificationStatus, "insufficient_evidence");
});

test("C07 snapshot exposes PR 7256 files and commits and the harness fetches them", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C07");
  const provider = new SnapshotGitHubProvider(snapshot);
  const pr = await provider.getPullRequest({ owner: "better-auth", repo: "better-auth", pullNumber: 7256 });
  assert.equal(pr.merged, true);
  assert.match(pr.body, /Closes https:\/\/github.com\/better-auth\/better-auth\/issues\/4490/);
  const files = await provider.getPullRequestFiles({
    owner: "better-auth",
    repo: "better-auth",
    pullNumber: 7256,
  });
  assert.ok(files.some((file) => file.filename.includes("multi-session")));
  const commits = await provider.listCommits({ owner: "better-auth", repo: "better-auth", pullNumber: 7256 });
  assert.ok(commits.length > 0);
  forbiddenGroundTruth(JSON.stringify(snapshot), "C07 snapshot");

  const executed = await executeDatasetCase(dataset, "C07");
  assert.equal("expectedOutcome" in executed.scenario, false);
  const fetched = executed.report.investigationSteps.some(
    (step) =>
      step.tool === "github_get_pull_request" && step.arguments.pullNumber === 7256 && step.success === true,
  );
  assert.equal(fetched, true);
  assert.ok(executed.report.evidence.some((item) => item.kind === "pull_request"));
  assert.ok(executed.report.evidence.some((item) => item.kind === "file"));
  assert.ok(executed.report.evidence.some((item) => item.kind === "commit"));
});

test("C08 snapshot exposes commit e70118a as an observation", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C08");
  const provider = new SnapshotGitHubProvider(snapshot);
  const commit = await provider.getCommit({
    owner: "beyond-all-reason",
    repo: "bar-lobby",
    sha: "e70118a2a11aa239472336f6a961784f04c63c9d",
  });
  assert.match(commit.message, /Resolves #291/);
  const executed = await executeDatasetCase(dataset, "C08");
  const listed = executed.report.investigationSteps.some(
    (step) => step.tool === "github_list_commits" && step.success === true,
  );
  assert.equal(listed, true);
  assert.ok(
    executed.report.evidence.some(
      (item) => item.kind === "commit" && /e70118a/i.test(JSON.stringify(item.payload ?? item.summary)),
    ),
  );
});

test("C09 snapshot exposes PR 279 implementation files and the harness fetches them", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C09");
  const provider = new SnapshotGitHubProvider(snapshot);
  const pr = await provider.getPullRequest({ owner: "olafkfreund", repo: "Factory", pullNumber: 279 });
  assert.equal(pr.merged, true);
  assert.match(pr.title, /untrusted-content/i);
  const files = await provider.getPullRequestFiles({
    owner: "olafkfreund",
    repo: "Factory",
    pullNumber: 279,
  });
  assert.ok(files.some((file) => file.filename.includes("untrusted-content-threat-model.md")));
  forbiddenGroundTruth(JSON.stringify(snapshot), "C09 snapshot");

  const executed = await executeDatasetCase(dataset, "C09");
  const fetched = executed.report.investigationSteps.some(
    (step) =>
      step.tool === "github_get_pull_request" && step.arguments.pullNumber === 279 && step.success === true,
  );
  assert.equal(fetched, true);
  assert.equal(executed.observed.verificationStatus, "verified_complete");
});

test("real-v1 snapshots and converted scenarios still omit ground truth", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  for (const item of dataset.cases) {
    const snapshot = loadSnapshot(dataset, item.caseId);
    forbiddenGroundTruth(JSON.stringify(snapshot), item.caseId);
    const scenario = convertCaseToScenario(dataset, item);
    assert.equal("expectedOutcome" in scenario, false);
    forbiddenGroundTruth(JSON.stringify(scenario), `${item.caseId} scenario`);
  }
});

test("Real-v1 benchmark execution remains snapshot-only after completeness repair", async () => {
  const originalFetch = globalThis.fetch;
  const githubUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/github/i.test(url)) {
      githubUrls.push(url);
    }
    throw new Error(`unexpected fetch during real-v1 benchmark: ${url}`);
  }) as typeof fetch;
  try {
    const result = await runRealDatasetBenchmark({ writeResult: false });
    assert.equal(result.cases.length, 10);
    assert.deepEqual(githubUrls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeness repair does not add caseId scoring hacks", () => {
  const files = [
    "src/benchmark/runner.ts",
    "src/benchmark/evaluate.ts",
    "src/github/capture.ts",
    "src/investigation/test-driver.ts",
    "src/investigation/investigation-tools.ts",
  ];
  const banned = [
    /caseId\s*===?\s*["'`]C\d+["'`]/,
    /switch\s*\(\s*caseId\s*\)/,
  ];
  for (const relative of files) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    for (const pattern of banned) {
      assert.equal(pattern.test(source), false, `${relative} matches ${pattern}`);
    }
  }
  for (const file of sourceFiles("src/benchmark")) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("LiveGitHubProvider"), false, file);
  }
});
