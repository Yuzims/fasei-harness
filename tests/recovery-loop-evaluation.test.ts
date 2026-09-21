import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/index.js";
import {
  RECOVERY_LOOP_FOCUS_CASES,
  evaluatePhase111FocusCases,
} from "../src/evaluation/index.js";

test("Phase 11.1 evaluation does not leak ground truth and keeps recovery-loop contracts on C07 / C08 / C10", async () => {
  const before = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const results = await evaluatePhase111FocusCases();
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RECOVERY_LOOP_FOCUS_CASES],
  );

  const c07 = results.find((item) => item.caseId === "C07");
  assert.ok(c07);
  assert.equal(c07.executed, true);
  assert.equal(c07.newAttemptCreated, true);
  assert.equal(c07.patchEvidenceBefore, false);
  assert.equal(c07.patchEvidenceAdded, true);
  assert.equal(c07.gapTypesBefore.includes("missing_patch_evidence"), true);
  assert.equal(c07.gapReduced, true);
  assert.equal(c07.verifierInvariant, true);
  assert.equal(c07.noFalseCompletion, true);
  assert.equal(c07.parentVerificationUnchanged, true);

  const c08 = results.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.blockingGapBefore, true);
  assert.equal(c08.executed, true);
  assert.equal(c08.addedPullRequestEvidence, 0);
  assert.equal(c08.falseCandidateCount, 0);
  assert.equal(c08.verifierInvariant, true);
  assert.equal(c08.noFalseCompletion, true);

  const c10 = results.find((item) => item.caseId === "C10");
  assert.ok(c10);
  assert.equal(c10.falseCandidateCount, 0);
  assert.equal(c10.addedPullRequestEvidence, 0);
  assert.equal(c10.addedCommitEvidence, 0);
  assert.equal(c10.verifierInvariant, true);
  assert.equal(c10.noFalseCompletion, true);
  if (c10.blockingGapBefore) {
    assert.equal(c10.executed, true);
    assert.equal(c10.newAttemptCreated, true);
  }

  const after = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(after, before);
});
