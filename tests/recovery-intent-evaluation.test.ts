import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RECOVERY_INTENT_FOCUS_CASES,
  evaluatePhase110FocusCases,
  observeRecoveryIntents,
} from "../src/evaluation/index.js";
import type { ResolutionGap } from "../src/domain/index.js";

function gap(type: ResolutionGap["type"], severity: ResolutionGap["severity"] = "blocking"): ResolutionGap {
  return {
    candidateId: "cand-1",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-1"],
    explanation: "synthetic",
    recommendedActions: [],
  };
}

test("Phase 11.0 mapping / merge / no-execution contracts", () => {
  const mapped = observeRecoveryIntents([gap("missing_patch_evidence")]);
  assert.deepEqual(mapped.objectives, ["collect_resolution_evidence"]);
  assert.equal(mapped.mappingHold, true);
  assert.equal(mapped.mergeHold, true);
  assert.equal(mapped.noToolExecution, true);

  const merged = observeRecoveryIntents([gap("missing_patch_evidence"), gap("missing_file_evidence")]);
  assert.deepEqual(merged.objectives, ["collect_resolution_evidence"]);
  assert.deepEqual(merged.intents[0]?.triggerGapTypes, ["missing_patch_evidence", "missing_file_evidence"]);
  assert.equal(merged.mergeHold, true);
  assert.equal(merged.autoExecuteFalse, true);
});

test("Phase 11.0 evaluation does not leak ground truth and keeps intent contracts on C01 / C07 / C08", async () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const results = await evaluatePhase110FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RECOVERY_INTENT_FOCUS_CASES],
  );
  for (const item of results) {
    assert.equal(item.mappingHold, true);
    assert.equal(item.mergeHold, true);
    assert.equal(item.noToolExecution, true);
    assert.equal(item.autoExecuteFalse, true);
    assert.equal(item.verifierInvariant, true);
  }

  const c01 = results.find((item) => item.caseId === "C01");
  assert.ok(c01);
  assert.equal(c01.objectives.includes("collect_resolution_evidence"), true);

  const c07 = results.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.equal(c07.gapTypes.includes("missing_patch_evidence"), true);
  assert.equal(c07.objectives.includes("collect_resolution_evidence"), true);

  const c08 = results.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.gapTypes.includes("insufficient_resolution_context"), true);
  assert.equal(c08.objectives.includes("collect_resolution_evidence"), true);
  assert.equal(c08.objectives.filter((item) => item === "collect_resolution_evidence").length, 1);

  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
});
