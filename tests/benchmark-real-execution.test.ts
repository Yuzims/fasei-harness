import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalizeDatasetResult,
  convertCaseToScenario,
  executeDatasetCase,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadDataset,
  loadGroundTruthCase,
  REAL_DATASET_ID,
  realDatasetManifestPath,
  runRealDatasetBenchmark,
} from "../src/benchmark/index.js";

const REAL_CASE_IDS = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(relativeDir: string): string[] {
  const dir = join(ROOT, relativeDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

test("Real-v1 full execution produces 10 harness results", async () => {
  const result = await runRealDatasetBenchmark({ writeResult: false });
  assert.equal(result.dataset, REAL_DATASET_ID);
  assert.equal(result.datasetVersion, "v1.1");
  assert.equal(result.cases.length, 10);
  assert.deepEqual(
    result.cases.map((item) => item.caseId),
    REAL_CASE_IDS,
  );
  assert.ok(result.timestamp);
  for (const item of result.cases) {
    assert.match(item.observedOutcome, /^(verified_complete|not_verified|insufficient_evidence)$/);
    assert.match(item.expectedOutcome, /^(verified_complete|not_verified|insufficient_evidence)$/);
    assert.equal(typeof item.evaluation.passed, "boolean");
    assert.ok(item.attempts >= 1);
    assert.ok(item.toolCalls >= 1);
    assert.ok(item.evidenceCount >= 0);
    assert.ok(item.claimCount >= 0);
    assert.ok(Array.isArray(item.failureEvents));
    assert.ok(Array.isArray(item.recoveryEvents));
  }
  assert.equal(typeof result.metrics.taskSuccessRate, "number");
  assert.equal(typeof result.metrics.falseCompletionRate, "number");
  assert.equal(typeof result.metrics.insufficientEvidenceRate, "number");
  assert.equal(typeof result.metrics.evidenceCoverage, "number");
  assert.equal(typeof result.metrics.unsupportedClaimRate, "number");
  assert.equal(typeof result.metrics.recoveryRate, "number");
  assert.equal(typeof result.metrics.recoverySuccessRate, "number");
  assert.equal(typeof result.metrics.averageAttempts, "number");
  assert.equal(typeof result.metrics.averageToolCalls, "number");
  assert.equal(typeof result.metrics.verifierFalsePositiveRate, "number");
});

test("Real-v1 agent input stays isolated from ground-truth.json", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const c07Truth = loadGroundTruthCase(dataset, "C07");
  assert.match(c07Truth.rationale ?? "", /Independent semantic\/effect verification/);
  for (const item of dataset.cases) {
    const executed = await executeDatasetCase(dataset, item.caseId);
    assert.equal("expectedOutcome" in executed.scenario, false);
    const expected = expectedOutcomeForDatasetCase(dataset, item.caseId);
    assert.equal(executed.expected.verificationStatus, expected.verificationStatus);
    const agentInput = JSON.stringify({
      task: executed.report.task,
      scenario: executed.scenario,
      claims: executed.report.claims,
      evidence: executed.report.evidence.map((entry) => ({
        kind: entry.kind,
        summary: entry.summary,
        provenance: entry.provenance,
      })),
    });
    assert.equal(agentInput.includes("expectedOutcome"), false, item.caseId);
    assert.equal(agentInput.includes("expectedFailureModes"), false, item.caseId);
    assert.equal(agentInput.includes("ground-truth.json"), false, item.caseId);
    assert.equal(agentInput.includes("Independent semantic/effect verification"), false, item.caseId);
    const caseRecord = loadCase(dataset, item.caseId);
    const converted = convertCaseToScenario(dataset, caseRecord);
    assert.equal("expectedOutcome" in converted, false);
  }
});

test("Real-v1 benchmark is snapshot-only and does not use LiveGitHubProvider", async () => {
  const runner = readFileSync(join(ROOT, "src/benchmark/runner.ts"), "utf8");
  assert.match(runner, /new SnapshotGitHubProvider/);
  assert.equal(runner.includes("LiveGitHubProvider"), false);
  assert.equal(runner.includes("api.github.com"), false);
  for (const file of sourceFiles("src/benchmark/dataset")) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("LiveGitHubProvider"), false, file);
    assert.equal(source.includes("api.github.com"), false, file);
  }

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

test("Real-v1 benchmark is reproducible after canonicalizing timestamp", async () => {
  const first = await runRealDatasetBenchmark({ writeResult: false });
  const second = await runRealDatasetBenchmark({ writeResult: false });
  assert.equal(first.cases.length, second.cases.length);
  assert.notEqual(first.timestamp, "");
  assert.notEqual(second.timestamp, "");
  assert.deepEqual(canonicalizeDatasetResult(first), canonicalizeDatasetResult(second));
});

test("evaluator and real benchmark runner have no C01-C10 scoring hacks", () => {
  const files = [
    "src/benchmark/runner.ts",
    "src/benchmark/evaluate.ts",
    "src/benchmark/metrics.ts",
    "src/benchmark/injection.ts",
    "examples/real-benchmark.ts",
  ];
  const banned = [
    /caseId\s*===?\s*["'`]C\d+["'`]/,
    /scenarioId\s*===?\s*["'`]C\d+["'`]/,
    /switch\s*\(\s*caseId\s*\)/,
    /switch\s*\(\s*scenarioId\s*\)/,
  ];
  for (const relative of files) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    for (const pattern of banned) {
      assert.equal(pattern.test(source), false, `${relative} matches ${pattern}`);
    }
  }
});
