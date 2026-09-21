import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RESOLUTION_EFFECT_FOCUS_CASES,
  evaluatePhase10FocusCases,
  evaluatePhase10ResolutionCase,
} from "../src/evaluation/index.js";

test("Phase 10.0 evaluation does not leak ground truth and keeps verifier invariant", async () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const c01 = await evaluatePhase10ResolutionCase("C01");
  assert.equal(c01.caseId, "C01");
  assert.equal(c01.verifierInvariant, true);
  assert.equal(c01.notes.some((item) => /without Evidence IDs/i.test(item)), false);
  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
});

test("Phase 10.0 focus cases C01 / C07 / C08 observe resolution evidence without deciding solved", async () => {
  const results = await evaluatePhase10FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RESOLUTION_EFFECT_FOCUS_CASES],
  );
  for (const item of results) {
    assert.equal(item.verifierInvariant, true);
    assert.notEqual(item.overall, "verified_complete");
    if (item.fileScope) {
      assert.ok(item.fileScope.evidenceIds.length > 0);
      assert.equal(/issue fixed|verified_complete/i.test(item.fileScope.explanation ?? ""), false);
    }
    if (item.patchIntent) {
      assert.ok(item.patchIntent.evidenceIds.length > 0);
    }
    if (item.testEvidence) {
      assert.ok(item.testEvidence.evidenceIds.length > 0);
    }
  }

  const c01 = results.find((item) => item.caseId === "C01");
  assert.ok(c01);
  assert.equal(c01.candidatePresent, true);
  assert.equal(c01.resolutionClaimPresent, true);
  assert.equal(c01.fileEvidencePresent, true);
  assert.equal(c01.fileScope?.status, "supported");
  assert.equal(c01.patchIntent?.status, "unknown");
  assert.notEqual(c01.overall, "verified_complete");

  const c07 = results.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.equal(c07.candidatePresent, true);
  assert.equal(c07.resolutionClaimPresent, true);
  assert.equal(c07.patchIntent?.status, "unknown");
  assert.notEqual(c07.verificationStatus, "verified_complete");

  const c08 = results.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.candidatePresent, true);
  assert.equal(c08.fileEvidencePresent, false);
  assert.equal(c08.patchEvidencePresent, false);
  assert.equal(c08.patchIntent?.status ?? "unknown", "unknown");
  assert.equal(c08.fileScope?.status ?? "unknown", "unknown");
});
