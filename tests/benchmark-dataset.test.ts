import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BenchmarkDatasetError,
  DATASET_SCHEMA_VERSION,
  SYNTHETIC_DATASET_ID,
  convertCaseToScenario,
  expectedFailureModes,
  loadCase,
  loadDataset,
  loadSnapshot,
  runBenchmarkCase,
  syntheticDatasetManifestPath,
  validateDataset,
} from "../src/benchmark/index.js";

function writeManifest(dir: string, manifest: unknown): string {
  const path = join(dir, "benchmark-dataset.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function tempDatasetDir(): string {
  return mkdtempSync(join(tmpdir(), "fasei-dataset-"));
}

function baseManifest(cases: unknown[]): Record<string, unknown> {
  return {
    datasetVersion: "v1",
    schemaVersion: "1",
    kind: "synthetic",
    name: "temp-dataset",
    cases,
  };
}

function resolvedCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "synthetic-resolved",
    source: { type: "github", repository: "acme/box", issueNumber: 42 },
    snapshotPath: "snapshots/resolved.json",
    scenarioId: "resolved",
    kind: "normal",
    description: "synthetic resolved",
    expectedOutcome: { verificationStatus: "verified_complete" },
    ...overrides,
  };
}

function copyResolvedSnapshot(dir: string): void {
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  copyFileSync(
    join(dirname(syntheticDatasetManifestPath()), "snapshots", "resolved.json"),
    join(dir, "snapshots", "resolved.json"),
  );
}

test("Test 1：合法 Dataset 可以加载", () => {
  const dataset = loadDataset();
  assert.equal(dataset.metadata.kind, "synthetic");
  assert.equal(dataset.metadata.name, "fasei-synthetic-v1");
  assert.equal(dataset.cases.length, 3);
  assert.deepEqual(
    dataset.cases.map((item) => item.caseId),
    ["synthetic-resolved", "synthetic-closed-unmerged", "synthetic-insufficient-evidence"],
  );
  const resolved = loadCase(dataset, "synthetic-resolved");
  assert.equal(resolved.source.repository, "acme/box");
  assert.equal(resolved.source.issueNumber, 42);
  assert.equal(resolved.snapshotPath, "snapshots/resolved.json");
  assert.equal(resolved.scenarioId, "resolved");
});

test("Test 2：不存在 snapshot 时失败", () => {
  const dir = tempDatasetDir();
  writeManifest(dir, baseManifest([resolvedCase()]));
  assert.throws(
    () => loadDataset(join(dir, "benchmark-dataset.json")),
    (error: unknown) => error instanceof BenchmarkDatasetError && error.code === "missing_snapshot",
  );
});

test("Test 3：重复 caseId 时失败", () => {
  const dir = tempDatasetDir();
  writeManifest(
    dir,
    baseManifest([resolvedCase(), resolvedCase({ scenarioId: "resolved-dup" })]),
  );
  assert.throws(
    () => loadDataset(join(dir, "benchmark-dataset.json")),
    (error: unknown) => error instanceof BenchmarkDatasetError && error.code === "duplicate_case_id",
  );
});

test("Test 4：snapshot identity 与 case identity 不一致时失败", () => {
  const dir = tempDatasetDir();
  copyResolvedSnapshot(dir);
  writeManifest(
    dir,
    baseManifest([
      resolvedCase({
        source: { type: "github", repository: "acme/box", issueNumber: 99 },
      }),
    ]),
  );
  assert.throws(
    () => loadDataset(join(dir, "benchmark-dataset.json")),
    (error: unknown) => {
      return (
        error instanceof BenchmarkDatasetError &&
        error.code === "identity_mismatch" &&
        error.message.includes("acme/box#99") &&
        error.message.includes("acme/box#42")
      );
    },
  );
});

test("Test 5：非法 expectedOutcome 时失败", () => {
  const dir = tempDatasetDir();
  writeManifest(
    dir,
    baseManifest([
      resolvedCase({
        expectedOutcome: { verificationStatus: "verified" },
      }),
    ]),
  );
  assert.throws(
    () => loadDataset(join(dir, "benchmark-dataset.json")),
    (error: unknown) => error instanceof BenchmarkDatasetError && error.code === "invalid_expected_outcome",
  );

  const dirModes = tempDatasetDir();
  writeManifest(
    dirModes,
    baseManifest([
      resolvedCase({
        expectedOutcome: {
          verificationStatus: "verified_complete",
          failureModes: ["not_a_failure_mode"],
        },
      }),
    ]),
  );
  assert.throws(
    () => loadDataset(join(dirModes, "benchmark-dataset.json")),
    (error: unknown) => error instanceof BenchmarkDatasetError && error.code === "invalid_expected_outcome",
  );
});

test("Test 6：Dataset Version / Schema Version 可以读取", () => {
  const dataset = loadDataset();
  assert.equal(dataset.metadata.datasetVersion, "v1");
  assert.equal(dataset.metadata.schemaVersion, DATASET_SCHEMA_VERSION);
  assert.equal(dataset.metadata.schemaVersion, "1");
  assert.equal(SYNTHETIC_DATASET_ID, "synthetic-v1");
  assert.notEqual(dataset.metadata.datasetVersion, dataset.metadata.schemaVersion);
});

test("Test 7：Dataset Case 可以转换成 Benchmark Scenario", () => {
  const dataset = loadDataset();
  const datasetCase = loadCase(dataset, "synthetic-insufficient-evidence");
  const scenario = convertCaseToScenario(dataset, datasetCase);
  assert.equal(scenario.id, "insufficient-evidence");
  assert.equal(scenario.kind, "failure");
  assert.equal(scenario.failureMode, "insufficient_evidence");
  assert.equal(scenario.fixture, undefined);
  assert.ok(scenario.snapshotPath?.endsWith(join("snapshots", "insufficient-evidence.json")));
  assert.equal(scenario.target.owner, "acme");
  assert.equal(scenario.target.repository, "box");
  assert.equal(scenario.target.issueNumber, 7);
  assert.deepEqual(scenario.expectedOutcome, {
    verificationStatus: "insufficient_evidence",
    failureModes: ["insufficient_evidence"],
  });
  assert.deepEqual(expectedFailureModes(scenario), ["insufficient_evidence"]);
});

test("Test 8：Benchmark Runner 可以使用 Snapshot 执行一个完整 Case", async () => {
  const dataset = loadDataset();
  const expected: Record<string, string> = {
    "synthetic-resolved": "verified_complete",
    "synthetic-closed-unmerged": "not_verified",
    "synthetic-insufficient-evidence": "insufficient_evidence",
  };
  for (const [caseId, status] of Object.entries(expected)) {
    const result = await runBenchmarkCase(dataset, caseId);
    assert.equal(result.observedOutcome, status, caseId);
    assert.equal(result.passed, true, caseId);
  }
});

test("Dataset input 可复现：同一 case 两次加载得到相同 snapshot", () => {
  const dataset = loadDataset();
  const first = loadSnapshot(dataset, "synthetic-closed-unmerged");
  const second = loadSnapshot(dataset, "synthetic-closed-unmerged");
  assert.deepEqual(first, second);
  assert.equal(first.owner, "acme");
  assert.equal(first.repository, "box");
  assert.equal(first.issueNumber, 99);
});

test("Dataset Case 在 fixture mode 下两次运行结果稳定", async () => {
  const dataset = loadDataset();
  const first = await runBenchmarkCase(dataset, "synthetic-closed-unmerged");
  const second = await runBenchmarkCase(dataset, "synthetic-closed-unmerged");
  assert.equal(first.observedOutcome, second.observedOutcome);
  assert.equal(first.passed, second.passed);
  assert.equal(first.verificationStatus, "not_verified");
  assert.equal(first.passed, true);
});

test("expectedOutcome.failureModes 不从 scenario.failureMode 或 reserved expectedFailureModes 回填", () => {
  const dataset = loadDataset();
  const original = loadCase(dataset, "synthetic-resolved");
  const scenario = convertCaseToScenario(dataset, {
    ...original,
    expectedFailureModes: ["tool_failure"],
    expectedOutcome: { verificationStatus: "verified_complete" },
  });
  assert.equal(scenario.failureMode, undefined);
  assert.equal(scenario.expectedOutcome.failureModes, undefined);
  assert.deepEqual(expectedFailureModes(scenario), []);
});

test("validateDataset 在 schema 错误时 fail fast", () => {
  assert.throws(
    () => validateDataset({ datasetVersion: "v1", schemaVersion: "99", kind: "synthetic", name: "x", cases: [] }, "/tmp"),
    (error: unknown) => error instanceof BenchmarkDatasetError && error.code === "unsupported_schema",
  );
});

test("Dataset 默认不依赖实时 GitHub API，且不复制生产 Verifier / Analyzer", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/benchmark/dataset");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(dir, file), "utf8");
    assert.equal(source.includes("api.github.com"), false, file);
    assert.equal(source.includes("LiveGitHubProvider"), false, file);
    assert.equal(source.includes("new IndependentCompletionVerifier"), false, file);
    assert.equal(source.includes("new FailureAnalyzer"), false, file);
    assert.equal(source.includes("new RecoveryPlanner"), false, file);
    assert.equal(source.includes("evaluateEvidenceRequirement"), false, file);
  }

  const productionDirs = ["domain", "investigation", "verification", "github"];
  const root = join(dirname(fileURLToPath(import.meta.url)), "../src");
  for (const name of productionDirs) {
    for (const file of readdirSync(join(root, name))) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(root, name, file), "utf8");
      assert.equal(source.includes("benchmark/dataset"), false, `${name}/${file}`);
    }
  }
});
