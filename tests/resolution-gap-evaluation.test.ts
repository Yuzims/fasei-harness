import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RESOLUTION_GAP_FOCUS_CASES,
  evaluatePhase102FocusCases,
  evaluatePhase102ResolutionCase,
} from "../src/evaluation/index.js";

test("Phase 10.2 evaluation does not leak ground truth and keeps verifier invariant", async () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const c01 = await evaluatePhase102ResolutionCase("C01");
  assert.equal(c01.caseId, "C01");
  assert.equal(c01.verifierInvariant, true);
  assert.equal(c01.notes.some((item) => /without Evidence IDs|claimed absence/i.test(item)), false);
  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
});

test("Phase 10.2 focus cases C01 / C07 / C08 expose resolution information gaps", async () => {
  const results = await evaluatePhase102FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RESOLUTION_GAP_FOCUS_CASES],
  );
  for (const item of results) {
    assert.equal(item.verifierInvariant, true);
    for (const gap of item.gaps) {
      assert.ok(gap.evidenceIds.length > 0);
      assert.equal(/no code change happened|no tests exist|verified_complete/i.test(gap.explanation), false);
    }
  }

  const c01 = results.find((item) => item.caseId === "C01");
  assert.ok(c01);
  assert.equal(c01.candidatePresent, true);
  assert.equal(c01.overall === "supported" || c01.overall === "partial", true);
  assert.equal(
    c01.gaps.length === 0 || c01.gaps.every((item) => item.severity === "warning"),
    true,
  );

  const c07 = results.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.equal(c07.candidatePresent, true);
  assert.equal(c07.fileEvidencePresent, true);
  assert.equal(c07.patchEvidencePresent, false);
  assert.equal(c07.gapTypes.includes("missing_patch_evidence"), true);

  const c08 = results.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.candidatePresent, true);
  assert.equal(c08.fileEvidencePresent, false);
  assert.equal(c08.patchEvidencePresent, false);
  assert.equal(c08.gapTypes.includes("insufficient_resolution_context"), true);
});
