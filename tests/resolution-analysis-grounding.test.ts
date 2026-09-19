/**
 * Phase 8.9 — Deterministic Resolution Analysis grounding.
 * Lexical / structural overlap only. Not semantic correctness.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createResolutionAnalysis,
} from "../src/domain/index.js";
import {
  RESOLUTION_ANALYSIS_GROUNDING_LIMITATION,
  analysisCorpus,
  evaluateResolutionAnalysisGrounding,
} from "../src/evaluation/index.js";

const RETRIEVED_AT = "2026-09-19T00:00:00.000Z";

const RESIZE_PATCH = [
  "@@ -10,3 +10,6 @@",
  " function onTerminalResize() {",
  "+  if (terminalSizeChanged) {",
  "+    suggestions.dismiss();",
  "+  }",
  " }",
].join("\n");

function provenance(resource: string) {
  return {
    source: "github" as const,
    repository: "acme/box",
    resource,
    url: `https://github.com/acme/box/${resource}`,
    retrievedAt: RETRIEVED_AT,
    trust: "external_untrusted" as const,
  };
}

function fileEvidence(filename: string, patch?: string) {
  return createEvidence({
    kind: "file",
    summary: `PR #7 modified ${filename}`,
    contentRef: `file:7:${filename}`,
    payload: {
      filename,
      status: "modified",
      additions: 3,
      deletions: 0,
      ...(patch ? { patch } : {}),
    },
    provenance: provenance(`pull/7/files/${filename}`),
  });
}

test("evaluator limitation is lexical / structural, not semantic correctness", () => {
  assert.match(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION, /lexical \/ structural grounding/);
  assert.match(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION, /cannot prove/);
  assert.match(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION, /not semantic correctness/);
  assert.equal(/semantic correctness/.test(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION), true);
  assert.match(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION, /code correctness/);
  assert.match(RESOLUTION_ANALYSIS_GROUNDING_LIMITATION, /resolution correctness/);
});

test("evaluateResolutionAnalysisGrounding: patch identifiers are lexical signals", () => {
  const file = fileEvidence("src/suggest.ts", RESIZE_PATCH);
  const issue = createEvidence({
    kind: "issue",
    summary: "Issue #42: suggestions stay open after terminal resize",
    contentRef: "issue:42",
    payload: { number: 42, title: "suggestions stay open after terminal resize" },
    provenance: provenance("issues/42"),
  });
  const analysis = createResolutionAnalysis({
    candidateEvidenceId: "ev-pr",
    issueEvidenceId: issue.id,
    codeRelevance:
      "Observed facts: src/suggest.ts +3/-0; diff shows that terminalSizeChanged now triggers suggestions.dismiss(). Inference: may relate to resize handling.",
    behavioralAlignment: "Inference: dismiss may run when the terminal size changed. Runtime unproven.",
    testSupport: "Current observed PR file evidence does not include an obvious test-file change (not observed / unknown).",
    unresolvedQuestions: ["The observed diff cannot prove runtime behavior."],
    supportingEvidenceIds: [file.id, issue.id],
    claimIds: [],
  });
  const grounding = evaluateResolutionAnalysisGrounding({
    analysis,
    evidence: [file, issue],
    boundedPatches: [{ filename: "src/suggest.ts", patch: RESIZE_PATCH, additions: 3, deletions: 0 }],
  });
  assert.ok(grounding.patchSignals >= 2);
  assert.ok(grounding.observedFactSignals >= 1);
  assert.ok(grounding.issueReferenceSignals >= 1);
  assert.equal(grounding.grounded, true);
  const corpus = analysisCorpus(analysis);
  assert.match(corpus, /terminalSizeChanged/);
  assert.match(corpus, /suggestions\.dismiss/);
});

test("evaluateResolutionAnalysisGrounding: no patch text is not patch-grounded", () => {
  const file = fileEvidence("src/suggest.ts", RESIZE_PATCH);
  const analysis = createResolutionAnalysis({
    candidateEvidenceId: "ev-pr",
    issueEvidenceId: "ev-issue",
    codeRelevance: "insufficient code-change context",
    behavioralAlignment: "insufficient code-change context",
    testSupport: "not observed / unknown",
    unresolvedQuestions: ["Current file evidence has no bounded patch; code-change context is insufficient."],
    supportingEvidenceIds: [file.id],
    claimIds: [],
  });
  const grounding = evaluateResolutionAnalysisGrounding({
    analysis,
    evidence: [file],
    boundedPatches: [{ filename: "src/suggest.ts", patch: RESIZE_PATCH }],
  });
  assert.equal(grounding.patchSignals, 0);
  assert.equal(grounding.grounded, false);
});

test("evaluateResolutionAnalysisGrounding: test-file path is a test signal, not test execution", () => {
  const testFile = fileEvidence("tests/suggest.spec.ts", "+test(\"dismiss\", () => {});");
  const analysis = createResolutionAnalysis({
    candidateEvidenceId: "ev-pr",
    issueEvidenceId: "ev-issue",
    codeRelevance: "Observed facts: tests/suggest.spec.ts added +1/-0.",
    behavioralAlignment: "Inference: a test-file change was observed. Not a test execution result.",
    testSupport: "Observed facts: test-file change observed in tests/suggest.spec.ts (evidence ev-test).",
    unresolvedQuestions: ["No test execution results were observed."],
    supportingEvidenceIds: [testFile.id],
    claimIds: [],
  });
  const grounding = evaluateResolutionAnalysisGrounding({
    analysis,
    evidence: [testFile],
  });
  assert.ok(grounding.testSignals >= 1);
  assert.equal(/tests passed|all tests pass/i.test(analysisCorpus(analysis)), false);
});

test("evaluateResolutionAnalysisGrounding: fabricated supportingEvidenceIds are not grounded", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const file = fileEvidence("src/cart.ts");
  run.evidence.push(file);
  const analysis = createResolutionAnalysis({
    candidateEvidenceId: "ev-pr",
    issueEvidenceId: "ev-issue",
    codeRelevance: "Observed facts: src/cart.ts modified.",
    behavioralAlignment: "Inference: maybe related.",
    testSupport: "not observed / unknown",
    unresolvedQuestions: [],
    supportingEvidenceIds: ["forged-evidence-id"],
    claimIds: [],
  });
  const grounding = evaluateResolutionAnalysisGrounding({
    analysis,
    evidence: run.evidence,
  });
  assert.equal(grounding.grounded, false);
});
