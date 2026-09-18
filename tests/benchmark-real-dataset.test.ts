import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BenchmarkDatasetError,
  DATASET_SCHEMA_VERSION,
  REAL_DATASET_ID,
  SYNTHETIC_DATASET_ID,
  assertGroundTruthCoversDataset,
  assertGroundTruthMatchesCase,
  assertSnapshotHasNoGroundTruth,
  convertCaseToScenario,
  evaluateExpectedContract,
  expectedFailureModes,
  expectedOutcomeForDatasetCase,
  loadCase,
  loadDataset,
  loadGroundTruth,
  loadGroundTruthCase,
  loadSnapshot,
  realDatasetManifestPath,
  syntheticDatasetManifestPath,
  validateDataset,
  type ObservedOutcome,
} from "../src/benchmark/index.js";
import { createInvestigationTask } from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { UNTRUSTED } from "../src/github/types.js";

const REAL_CASE_IDS = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"];

function observed(
  partial: Partial<ObservedOutcome> & Pick<ObservedOutcome, "verificationStatus">,
): ObservedOutcome {
  return {
    agentClaimedComplete: false,
    attemptCount: 1,
    toolCallCount: 1,
    evidenceCoverage: 0,
    unsupportedClaimRate: 0,
    failureTypes: [],
    recovered: false,
    recoveryAttempted: false,
    ...partial,
  };
}

function sourceFiles(relativeDir: string): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", relativeDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

test("real-v1 manifest loads with 10 unique cases", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  assert.equal(dataset.metadata.kind, "real");
  assert.equal(dataset.metadata.name, "fasei-real-v1");
  assert.equal(dataset.metadata.datasetVersion, "v1");
  assert.equal(dataset.metadata.schemaVersion, DATASET_SCHEMA_VERSION);
  assert.equal(REAL_DATASET_ID, "real-v1");
  assert.equal(dataset.cases.length, 10);
  assert.deepEqual(
    dataset.cases.map((item) => item.caseId),
    REAL_CASE_IDS,
  );
  assert.equal(new Set(dataset.cases.map((item) => item.caseId)).size, 10);
});

test("synthetic-v1 still exists beside real-v1", () => {
  const synthetic = loadDataset(syntheticDatasetManifestPath());
  const real = loadDataset(realDatasetManifestPath());
  assert.equal(synthetic.metadata.kind, "synthetic");
  assert.equal(real.metadata.kind, "real");
  assert.equal(SYNTHETIC_DATASET_ID, "synthetic-v1");
  assert.equal(REAL_DATASET_ID, "real-v1");
  assert.notEqual(syntheticDatasetManifestPath(), realDatasetManifestPath());
});

test("real-v1 repository and issue identities are valid and match snapshots", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  for (const item of dataset.cases) {
    assert.equal(item.source.type, "github");
    assert.match(item.source.repository, /^[^/\s]+\/[^/\s]+$/);
    assert.equal(Number.isInteger(item.source.issueNumber) && item.source.issueNumber > 0, true);
    assert.ok(item.sourceUrl?.startsWith("https://github.com/"));
    const snapshot = loadSnapshot(dataset, item.caseId);
    const [owner, name] = item.source.repository.split("/");
    assert.equal(snapshot.owner.toLowerCase(), owner.toLowerCase());
    assert.equal(snapshot.repository.toLowerCase(), name.toLowerCase());
    assert.equal(snapshot.issueNumber, item.source.issueNumber);
    assert.equal(snapshot.issue.number, item.source.issueNumber);
    assert.equal(snapshot.snapshotId, `real-v1-${item.caseId}`);
  }
});

test("real-v1 expected outcomes live only in ground-truth.json", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const groundTruth = loadGroundTruth(dataset);
  assert.equal(groundTruth.datasetVersion, "v1");
  assert.equal(groundTruth.schemaVersion, "1");
  assert.equal(groundTruth.cases.length, 10);
  assert.equal(dataset.evaluationOutcomes, undefined);
  assertGroundTruthCoversDataset(dataset, groundTruth);

  const expectedStatus: Record<string, string> = {
    C01: "verified_complete",
    C02: "verified_complete",
    C03: "verified_complete",
    C04: "verified_complete",
    C05: "not_verified",
    C06: "not_verified",
    C07: "not_verified",
    C08: "verified_complete",
    C09: "verified_complete",
    C10: "not_verified",
  };

  for (const item of dataset.cases) {
    assert.equal(item.kind, "normal");
    assert.equal(item.failureMode, undefined);
    assert.equal("expectedOutcome" in item, false);
    assert.equal("expectedFailureModes" in item, false);
    assert.equal(item.groundTruthReference, "ground-truth.json");
    const record = loadGroundTruthCase(dataset, item.caseId);
    assertGroundTruthMatchesCase(item, record);
    assert.equal(record.expectedOutcome.verificationStatus, expectedStatus[item.caseId]);
    assert.equal(expectedOutcomeForDatasetCase(dataset, item.caseId).verificationStatus, expectedStatus[item.caseId]);
  }

  const c07 = loadGroundTruthCase(dataset, "C07");
  assert.deepEqual(c07.expectedFailureModes, ["wrong_target"]);
  assert.equal(c07.expectedOutcome.failureModes, undefined);
  const scenario = convertCaseToScenario(dataset, loadCase(dataset, "C07"));
  assert.equal("expectedOutcome" in scenario, false);
  assert.deepEqual(expectedFailureModes(scenario), []);
});

test("agent runtime modules cannot load ground-truth.json", () => {
  const forbidden = ["src/investigation", "src/github", "src/verification", "src/agent", "src/tools", "src/domain"];
  for (const dir of forbidden) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.includes("ground-truth.json"), false, file);
      assert.equal(source.includes("loadGroundTruth"), false, file);
    }
  }
});

test("real snapshots are agent input only and stay untrusted", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  for (const caseId of ["C01", "C05", "C07", "C09"]) {
    const snapshot = loadSnapshot(dataset, caseId);
    assertSnapshotHasNoGroundTruth(snapshot, caseId);
    assert.equal(snapshot.trust, UNTRUSTED);
    assert.equal(snapshot.issue.trust, UNTRUSTED);
    const provider = new SnapshotGitHubProvider(snapshot);
    assert.equal("expectedOutcome" in provider.getSnapshot(), false);
    assert.equal("correct_pr" in provider.getSnapshot(), false);
  }
});

test("C01 snapshot has merged resolution evidence without gold labels", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C01");
  assert.equal(snapshot.owner, "microsoft");
  assert.equal(snapshot.repository, "vscode");
  assert.equal(snapshot.issueNumber, 258694);
  assert.equal(snapshot.issue.state, "closed");
  assert.equal(snapshot.issue.stateReason, "completed");
  const pr = snapshot.pullRequests["284149"];
  assert.ok(pr);
  assert.equal(pr.merged, true);
  const shas = Object.keys(snapshot.commitIndex).join(" ");
  assert.match(shas, /67f18f1/i);
  assert.match(shas, /32a3ad5/i);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("verified_complete"), false);
  assert.equal(serialized.includes("expectedOutcome"), false);
});

test("C05 snapshot is closed as not planned without a fetched resolution PR", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C05");
  assert.equal(snapshot.owner, "cli");
  assert.equal(snapshot.repository, "cli");
  assert.equal(snapshot.issueNumber, 13070);
  assert.equal(snapshot.issue.state, "closed");
  assert.equal(snapshot.issue.stateReason, "not_planned");
  assert.deepEqual(Object.keys(snapshot.pullRequests), []);
  const provider = new SnapshotGitHubProvider(snapshot);
  const issue = await provider.getIssue({ owner: "cli", repo: "cli", issueNumber: 13070 });
  assert.equal(issue.stateReason, "not_planned");
});

test("C07 snapshot includes PR 7256 observations without telling the agent the target is wrong", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const datasetCase = loadCase(dataset, "C07");
  const snapshot = loadSnapshot(dataset, "C07");
  assert.equal(snapshot.issueNumber, 4490);
  assert.equal(snapshot.issue.state, "closed");
  assert.ok(snapshot.pullRequests["7256"] || snapshot.timeline.some((item) => item.pullRequestNumber === 7256));
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("WRONG_TARGET"), false);
  assert.equal(serialized.includes("wrong_target"), false);
  assert.equal(serialized.includes("expectedFailureModes"), false);
  assert.equal(serialized.includes("this_pr_is_the_correct_resolution"), false);
  assert.match(datasetCase.description ?? "", /Investigate whether/i);
  assert.equal((datasetCase.description ?? "").includes("wrong target"), false);
  assert.equal((datasetCase.description ?? "").includes("7256"), false);
});

test("C09 snapshot keeps prompt-injection issue text as external_untrusted data", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const snapshot = loadSnapshot(dataset, "C09");
  assert.equal(snapshot.owner, "olafkfreund");
  assert.equal(snapshot.repository, "Factory");
  assert.equal(snapshot.issueNumber, 273);
  assert.equal(snapshot.trust, UNTRUSTED);
  assert.equal(snapshot.issue.trust, UNTRUSTED);
  assert.match(snapshot.issue.body, /prompt-injection|untrusted|content_trust/i);
  const provider = new SnapshotGitHubProvider(snapshot);
  const issue = await provider.getIssue({
    owner: "olafkfreund",
    repo: "Factory",
    issueNumber: 273,
  });
  assert.equal(issue.trust, UNTRUSTED);
});

test("expected vs observed evaluation for real-v1 uses ground-truth.json", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const c01 = expectedOutcomeForDatasetCase(dataset, "C01");
  const c05 = expectedOutcomeForDatasetCase(dataset, "C05");
  const c07 = expectedOutcomeForDatasetCase(dataset, "C07");
  const scenario = convertCaseToScenario(dataset, loadCase(dataset, "C07"));

  assert.equal(evaluateExpectedContract(c01, observed({ verificationStatus: "verified_complete" })).passed, true);
  assert.equal(evaluateExpectedContract(c01, observed({ verificationStatus: "not_verified" })).passed, false);
  assert.equal(evaluateExpectedContract(c05, observed({ verificationStatus: "not_verified" })).passed, true);
  assert.equal(
    evaluateExpectedContract(c05, observed({ verificationStatus: "verified_complete" })).passed,
    false,
  );
  assert.equal(evaluateExpectedContract(c07, observed({ verificationStatus: "not_verified" })).passed, true);
  assert.equal(
    evaluateExpectedContract(
      c07,
      observed({ verificationStatus: "not_verified", failureTypes: ["insufficient_evidence"] }),
    ).passed,
    true,
  );
  assert.equal(scenario.kind, "normal");
  assert.equal(scenario.failureMode, undefined);
  assert.equal("expectedOutcome" in scenario, false);
});

function collectObjectKeys(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, into);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectObjectKeys(nested, into);
  }
}

test("real-v1 manifest contains no expectedOutcome or expectedFailureModes", () => {
  const raw = JSON.parse(readFileSync(realDatasetManifestPath(), "utf8")) as unknown;
  const keys = new Set<string>();
  collectObjectKeys(raw, keys);
  assert.equal(keys.has("expectedOutcome"), false);
  assert.equal(keys.has("expectedFailureModes"), false);

  const dataset = loadDataset(realDatasetManifestPath());
  for (const item of dataset.cases) {
    assert.equal("expectedOutcome" in item, false);
    assert.equal("expectedFailureModes" in item, false);
  }
});

test("real-v1 ground-truth.json contains the expected outcomes and keeps C07 evaluator-only", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const groundTruth = loadGroundTruth(dataset);
  const keys = new Set<string>();
  collectObjectKeys(groundTruth, keys);
  assert.equal(keys.has("expectedOutcome"), true);
  assert.equal(keys.has("expectedFailureModes"), true);

  const c07 = loadGroundTruthCase(dataset, "C07");
  assert.equal(c07.expectedOutcome.verificationStatus, "not_verified");
  assert.deepEqual(c07.expectedFailureModes, ["wrong_target"]);
  assert.match(c07.rationale ?? "", /Closes #4490/);
  assert.match(c07.rationale ?? "", /PR #7256/);
  assert.match(c07.rationale ?? "", /three different user accounts/i);
  assert.match(c07.rationale ?? "", /maximumSessions/);
  assert.match(c07.rationale ?? "", /duplicate cookies/i);
  assert.equal(/related PR/i.test(c07.rationale ?? ""), false);
  assert.equal(/related PR/i.test(c07.ambiguity ?? ""), false);

  const datasetCase = loadCase(dataset, "C07");
  const scenario = convertCaseToScenario(dataset, datasetCase);
  assert.equal("expectedOutcome" in datasetCase, false);
  assert.equal("expectedFailureModes" in datasetCase, false);
  assert.equal("expectedOutcome" in scenario, false);
  assert.equal(JSON.stringify(scenario).includes("expectedFailureModes"), false);
  assert.equal(JSON.stringify(scenario).includes("wrong_target"), false);
});

test("loading or converting a real dataset case does not expose ground truth to agent input", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  for (const item of dataset.cases) {
    const snapshot = loadSnapshot(dataset, item.caseId);
    assertSnapshotHasNoGroundTruth(snapshot, item.caseId);
    const scenario = convertCaseToScenario(dataset, item);
    assert.equal("expectedOutcome" in scenario, false);
    const serializedScenario = JSON.stringify(scenario);
    assert.equal(serializedScenario.includes("expectedOutcome"), false);
    assert.equal(serializedScenario.includes("expectedFailureModes"), false);
    const task = createInvestigationTask({
      id: scenario.id,
      target: scenario.target,
      description: scenario.description,
    });
    const serializedTask = JSON.stringify(task);
    assert.equal(serializedTask.includes("expectedOutcome"), false);
    assert.equal(serializedTask.includes("expectedFailureModes"), false);
    assert.equal(serializedTask.includes("ground-truth.json"), false);
  }
});

test("real dataset loader rejects ground truth fields in the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "fasei-real-gt-leak-"));
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  copyFileSync(
    join(dirname(syntheticDatasetManifestPath()), "snapshots", "resolved.json"),
    join(dir, "snapshots", "resolved.json"),
  );
  const baseCase = {
    caseId: "C01",
    source: { type: "github", repository: "acme/box", issueNumber: 42 },
    snapshotPath: "snapshots/resolved.json",
    scenarioId: "C01",
    kind: "normal",
  };
  const leakingOutcome = {
    datasetVersion: "v1",
    schemaVersion: "1",
    kind: "real",
    name: "temp-real",
    cases: [{ ...baseCase, expectedOutcome: { verificationStatus: "verified_complete" } }],
  };
  assert.throws(
    () => validateDataset(leakingOutcome, dir),
    (error: unknown) =>
      error instanceof BenchmarkDatasetError &&
      error.code === "invalid_manifest" &&
      error.message.includes("expectedOutcome"),
  );

  const leakingModes = {
    datasetVersion: "v1",
    schemaVersion: "1",
    kind: "real",
    name: "temp-real",
    cases: [{ ...baseCase, expectedFailureModes: ["wrong_target"] }],
  };
  assert.throws(
    () => validateDataset(leakingModes, dir),
    (error: unknown) =>
      error instanceof BenchmarkDatasetError &&
      error.code === "invalid_manifest" &&
      error.message.includes("expectedFailureModes"),
  );
});
