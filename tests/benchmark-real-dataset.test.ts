import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DATASET_SCHEMA_VERSION,
  REAL_DATASET_ID,
  SYNTHETIC_DATASET_ID,
  assertGroundTruthMatchesCase,
  assertSnapshotHasNoGroundTruth,
  convertCaseToScenario,
  evaluateScenarioContract,
  expectedFailureModes,
  loadCase,
  loadDataset,
  loadGroundTruth,
  loadGroundTruthCase,
  loadSnapshot,
  realDatasetManifestPath,
  syntheticDatasetManifestPath,
  type ObservedOutcome,
} from "../src/benchmark/index.js";
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

test("real-v1 expected outcomes and ground truth metadata are valid and separated", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const groundTruth = loadGroundTruth(dataset);
  assert.equal(groundTruth.datasetVersion, "v1");
  assert.equal(groundTruth.schemaVersion, "1");
  assert.equal(groundTruth.cases.length, 10);

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
    assert.equal(item.expectedOutcome.verificationStatus, expectedStatus[item.caseId]);
    assert.equal(item.groundTruthReference, "ground-truth.json");
    const record = loadGroundTruthCase(dataset, item.caseId);
    assertGroundTruthMatchesCase(item, record);
    assert.equal(record.expectedOutcome.verificationStatus, item.expectedOutcome.verificationStatus);
  }

  const c07 = loadCase(dataset, "C07");
  assert.deepEqual(c07.expectedFailureModes, ["wrong_target"]);
  assert.equal(c07.expectedOutcome.failureModes, undefined);
  const scenario = convertCaseToScenario(dataset, c07);
  assert.equal(scenario.expectedOutcome.failureModes, undefined);
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

test("C07 snapshot includes related PR observations without telling the agent the target is wrong", async () => {
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

test("expected vs observed evaluation still uses the existing benchmark evaluator", () => {
  const dataset = loadDataset(realDatasetManifestPath());
  const c01 = convertCaseToScenario(dataset, loadCase(dataset, "C01"));
  const c05 = convertCaseToScenario(dataset, loadCase(dataset, "C05"));
  const c07 = convertCaseToScenario(dataset, loadCase(dataset, "C07"));

  assert.equal(evaluateScenarioContract(c01, observed({ verificationStatus: "verified_complete" })).passed, true);
  assert.equal(evaluateScenarioContract(c01, observed({ verificationStatus: "not_verified" })).passed, false);
  assert.equal(evaluateScenarioContract(c05, observed({ verificationStatus: "not_verified" })).passed, true);
  assert.equal(
    evaluateScenarioContract(c05, observed({ verificationStatus: "verified_complete" })).passed,
    false,
  );
  assert.equal(evaluateScenarioContract(c07, observed({ verificationStatus: "not_verified" })).passed, true);
  assert.equal(
    evaluateScenarioContract(
      c07,
      observed({ verificationStatus: "not_verified", failureTypes: ["insufficient_evidence"] }),
    ).passed,
    true,
  );
  assert.equal(c07.kind, "normal");
  assert.equal(c07.failureMode, undefined);
});
