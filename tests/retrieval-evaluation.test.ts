/**
 * Phase 8.9.x — Retrieval Evaluation.
 * Deterministic Fake Model + snapshots only. No live LLM / GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realDatasetGroundTruthPath } from "../src/benchmark/dataset/paths.js";
import {
  MAX_INVESTIGATED_CANDIDATES,
  RETRIEVAL_TOP_K,
  applyCandidateSelection,
  countTraceToolCalls,
  createRetrievalCandidate,
  investigate,
  rankCandidates,
  type InvestigationAgentReport,
} from "../src/investigation/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { createInvestigationRun, createInvestigationTask, type VerificationStatus } from "../src/domain/index.js";
import {
  RETRIEVAL_EVALUATION_BASELINE_NOTE,
  RETRIEVAL_EVALUATION_REAL_CASE_IDS,
  RETRIEVAL_EVALUATION_VERSION,
  REAL_V1_RETRIEVAL_GROUND_TRUTH,
  aggregateRetrievalCases,
  applyDiscoveryOrderSelection,
  buildRetrievalEvaluationReport,
  candidateIdsMatch,
  diagnoseRetrieval,
  evaluateRealV1RetrievalCase,
  evaluateRealV1RetrievalCases,
  evaluateRetrievalCandidates,
  evaluateSyntheticRetrievalCase,
  precisionAtK,
  recallAtK,
  runRetrievalEvaluation,
  syntheticRetrievalCases,
} from "../src/evaluation/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function candidate(sourceType: "pull_request" | "commit", sourceId: string, extras?: {
  lexicalScore?: number;
  issueReference?: boolean;
  status?: "candidate" | "investigating" | "rejected" | "promoted";
}) {
  return createRetrievalCandidate({
    sourceType,
    sourceId,
    retrievalReason: "test",
    status: extras?.status,
    relevanceSignals: {
      ...(extras?.issueReference ? { issueReference: true } : {}),
      ...(extras?.lexicalScore !== undefined ? { lexicalScore: extras.lexicalScore } : {}),
    },
  });
}

function sourceFiles(dir: string): string[] {
  const folder = join(ROOT, dir);
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(folder, file));
}

test("controlled baseline is not a historical production system", () => {
  assert.equal(RETRIEVAL_EVALUATION_VERSION, "8.9.x-contract");
  assert.match(RETRIEVAL_EVALUATION_BASELINE_NOTE, /controlled baseline/);
  assert.match(RETRIEVAL_EVALUATION_BASELINE_NOTE, /not a historical/);
  assert.match(RETRIEVAL_EVALUATION_BASELINE_NOTE, /controlled baseline ≠ historical production system/);
});

test("A — Recall@K is 1 when the expected candidate is in Top-K", () => {
  const topK = [candidate("pull_request", "7"), candidate("pull_request", "8")];
  const valid = [{ sourceType: "pull_request" as const, sourceId: "7" }];
  assert.equal(recallAtK(topK, valid, 1), 1);
  assert.equal(recallAtK(topK, valid, 5), 1);
});

test("B — Recall@K is 0 when the expected candidate is outside Top-K", () => {
  const topK = [candidate("pull_request", "21"), candidate("pull_request", "22")];
  const valid = [{ sourceType: "pull_request" as const, sourceId: "7" }];
  assert.equal(recallAtK(topK, valid, 1), 0);
  assert.equal(recallAtK(topK, valid, 5), 0);
});

test("C — discovery can succeed while Top-K recall fails", () => {
  const discovered = [
    candidate("pull_request", "101", { issueReference: true }),
    candidate("pull_request", "102", { issueReference: true }),
    candidate("pull_request", "103", { issueReference: true }),
    candidate("pull_request", "104", { issueReference: true }),
    candidate("pull_request", "105", { issueReference: true }),
    candidate("pull_request", "99", { lexicalScore: 1 }),
  ];
  const selected = applyCandidateSelection(discovered, 5);
  const metrics = evaluateRetrievalCandidates({
    caseId: "ranked-out",
    strategy: "evidence_driven",
    candidates: selected,
    groundTruth: {
      caseId: "ranked-out",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "99" }],
    },
  });
  assert.equal(metrics.discoveryFound, true);
  assert.equal(metrics.topKFound, false);
  assert.equal(metrics.recallAt5, 0);
  assert.equal(metrics.diagnosis, "ranked_out_of_top_k");
  assert.equal(
    selected.some((item) => item.sourceId === "99" && item.status === "rejected"),
    true,
  );
});

test("D — discovery failure is distinct from ranked-out-of-Top-K", () => {
  const discovered = [candidate("commit", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
  const metrics = evaluateRetrievalCandidates({
    caseId: "missed",
    strategy: "evidence_driven",
    candidates: discovered,
    groundTruth: {
      caseId: "missed",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "commit", sourceId: "deadbeef0123456789abcdef0123456789abcdef" }],
    },
  });
  assert.equal(metrics.discoveryFound, false);
  assert.equal(metrics.topKFound, false);
  assert.equal(metrics.diagnosis, "discovery_failure");
});

test("E — Precision@K is relevant / actual returned count, not padded K", () => {
  const topK = [
    candidate("pull_request", "7"),
    candidate("pull_request", "21"),
    candidate("pull_request", "8"),
  ];
  const valid = [
    { sourceType: "pull_request" as const, sourceId: "7" },
    { sourceType: "pull_request" as const, sourceId: "8" },
  ];
  assert.equal(precisionAtK(topK, valid, 1), 1);
  assert.equal(precisionAtK(topK, valid, 3), 2 / 3);
  assert.equal(precisionAtK(topK, valid, 5), 2 / 3);
});

test("F — expectedResolution = none is not a retrieval failure", () => {
  const metrics = evaluateRetrievalCandidates({
    caseId: "none",
    strategy: "evidence_driven",
    candidates: [],
    groundTruth: { caseId: "none", expectedResolution: "none", validCandidates: [] },
  });
  assert.equal(metrics.resolutionExpected, false);
  assert.equal(metrics.discoveryFound, null);
  assert.equal(metrics.recallAt5, null);
  assert.equal(metrics.precisionAt5, null);
  assert.equal(metrics.diagnosis, "no_resolution_expected");
  const aggregate = aggregateRetrievalCases([
    metrics,
    evaluateRetrievalCandidates({
      caseId: "hit",
      strategy: "evidence_driven",
      candidates: [candidate("pull_request", "7", { status: "investigating" })],
      groundTruth: {
        caseId: "hit",
        expectedResolution: "candidate",
        validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
      },
    }),
  ]);
  assert.equal(aggregate.noResolutionCases, 1);
  assert.equal(aggregate.resolutionExpectedCases, 1);
  assert.equal(aggregate.discoveryRate, 1);
  assert.equal(aggregate.recallAt5, 1);
});

test("G — any valid candidate in Top-K counts as Recall success", () => {
  const topK = [candidate("pull_request", "8"), candidate("pull_request", "21")];
  const valid = [
    { sourceType: "pull_request" as const, sourceId: "7" },
    { sourceType: "pull_request" as const, sourceId: "8" },
  ];
  assert.equal(recallAtK(topK, valid, 1), 1);
  assert.equal(recallAtK(topK, valid, 5), 1);
});

test("H — C08 direct commit participates in retrieval evaluation", async () => {
  assert.equal(REAL_V1_RETRIEVAL_GROUND_TRUTH.C08?.expectedResolution, "candidate");
  assert.equal(REAL_V1_RETRIEVAL_GROUND_TRUTH.C08?.validCandidates[0]?.sourceType, "commit");
  assert.equal(
    candidateIdsMatch(
      { sourceType: "commit", sourceId: "e70118a2a11aa239472336f6a961784f04c63c9d" },
      { sourceType: "commit", sourceId: "e70118a" },
    ),
    true,
  );
  const comparison = await evaluateRealV1RetrievalCase("C08");
  assert.equal(comparison.caseId, "C08");
  assert.equal(comparison.evidenceDriven.resolutionExpected, true);
  assert.equal(comparison.evidenceDriven.groundTruth[0]?.sourceType, "commit");
  assert.match(comparison.evidenceDriven.groundTruth[0]?.sourceId ?? "", /e70118a/i);
  assert.equal(
    comparison.evidenceDriven.discoveryFound === true || comparison.evidenceDriven.discoveryFound === false,
    true,
  );
});

test("I — C05/C06 not_planned are not false retrieval failures", async () => {
  const c05 = await evaluateRealV1RetrievalCase("C05");
  const c06 = await evaluateRealV1RetrievalCase("C06");
  for (const item of [c05, c06]) {
    assert.equal(item.evidenceDriven.resolutionExpected, false);
    assert.equal(item.baseline.resolutionExpected, false);
    assert.equal(item.evidenceDriven.diagnosis, "no_resolution_expected");
    assert.equal(item.baseline.diagnosis, "no_resolution_expected");
    assert.equal(item.evidenceDriven.recallAt5, null);
    assert.equal(item.evidenceDriven.discoveryFound, null);
  }
  const report = buildRetrievalEvaluationReport({
    datasetId: "real-v1",
    strategy: "evidence_driven",
    cases: [c05.evidenceDriven, c06.evidenceDriven],
  });
  assert.equal(report.aggregate.noResolutionCases, 2);
  assert.equal(report.aggregate.resolutionExpectedCases, 0);
  assert.equal(report.aggregate.discoveryRate, 0);
});

test("J — production runtime does not read retrieval or benchmark ground truth", () => {
  const forbidden = [
    "src/investigation",
    "src/github",
    "src/verification",
    "src/agent",
    "src/tools",
    "src/domain",
  ];
  for (const dir of forbidden) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.includes("ground-truth.json"), false, file);
      assert.equal(source.includes("loadGroundTruth"), false, file);
      assert.equal(source.includes("REAL_V1_RETRIEVAL_GROUND_TRUTH"), false, file);
      assert.equal(source.includes("expectedResolution"), false, file);
      assert.equal(source.includes("retrieval-evaluation"), false, file);
      assert.equal(source.includes("../evaluation/"), false, file);
    }
  }
});

test("K — evaluation does not bypass MAX_INVESTIGATED_CANDIDATES", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    candidate("pull_request", String(100 + index), { issueReference: index < 8 }),
  );
  const baseline = applyDiscoveryOrderSelection(many, MAX_INVESTIGATED_CANDIDATES);
  const ranked = applyCandidateSelection(many, MAX_INVESTIGATED_CANDIDATES);
  for (const group of [baseline, ranked]) {
    const selected = group.filter(
      (item) => item.status === "investigating" || item.status === "promoted",
    );
    assert.ok(selected.length <= MAX_INVESTIGATED_CANDIDATES);
  }
});

test("K — SRE06 investigate honors the investigation budget", async () => {
  const sre06 = syntheticRetrievalCases().find((item) => item.caseId === "SRE06");
  assert.ok(sre06);
  const run = await runRetrievalEvaluation({
    caseId: "SRE06",
    strategy: "evidence_driven",
    provider: new SnapshotGitHubProvider(sre06.snapshot),
    groundTruth: sre06.groundTruth,
  });
  assert.ok(run.metrics.investigatedCandidateCount <= MAX_INVESTIGATED_CANDIDATES);
  assert.ok(run.report.retrievalCandidates.filter((item) => item.status === "investigating" || item.status === "promoted").length <= MAX_INVESTIGATED_CANDIDATES);
});

function verificationReport(
  status: VerificationStatus,
  extras?: Partial<InvestigationAgentReport>,
): InvestigationAgentReport {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  return {
    task,
    run,
    verification: {
      status,
      checks: [],
      evidenceCoverage: 0,
      unsupportedClaimIds: [],
      missingRequirementIds: [],
      prematureCompletion: false,
    },
    claims: [],
    investigationSteps: extras?.investigationSteps ?? [],
    toolCallCount: extras?.toolCallCount ?? 0,
    llmUsage: {
      llmCalls: 0,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalTokens: null,
      totalCachedInputTokens: null,
      overallCacheHitRate: null,
      averageInputTokensPerCall: null,
      averageOutputTokensPerCall: null,
      model: null,
      calls: [],
    },
    ...extras,
  } as InvestigationAgentReport;
}

test("A — toolCalls equals real tool_call events, not investigationSteps.length", async () => {
  const trace = new TraceCollector();
  const executed = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    useTestDriver: true,
  });
  const actualToolCalls = countTraceToolCalls(trace.getEvents());
  assert.ok(actualToolCalls > 0);
  assert.equal(executed.toolCallCount, actualToolCalls);

  const paddedSteps = [...executed.investigationSteps, ...executed.investigationSteps];
  assert.notEqual(paddedSteps.length, executed.toolCallCount);

  const metrics = evaluateRetrievalCandidates({
    caseId: "tool-calls",
    strategy: "evidence_driven",
    candidates: executed.retrievalCandidates,
    groundTruth: { caseId: "tool-calls", expectedResolution: "none", validCandidates: [] },
    report: { ...executed, investigationSteps: paddedSteps },
  });
  assert.equal(metrics.toolCalls, actualToolCalls);
  assert.notEqual(metrics.toolCalls, paddedSteps.length);
  assert.notEqual(metrics.toolCalls, metrics.llmCalls);
});

test("B — topK is the runtime selection, not a re-ranked slice", () => {
  const a = candidate("pull_request", "1", { issueReference: true, lexicalScore: 10, status: "candidate" });
  const b = candidate("pull_request", "2", { lexicalScore: 0, status: "candidate" });
  const c = candidate("pull_request", "3", { lexicalScore: 0, status: "candidate" });
  const reranked = rankCandidates([a, b, c]);
  assert.deepEqual(
    reranked.slice(0, 2).map((item) => item.sourceId),
    ["1", "2"],
  );

  const metrics = evaluateRetrievalCandidates({
    caseId: "actual-topk",
    strategy: "evidence_driven",
    candidates: [a, b, c],
    retrievalTopKCandidates: [b, c],
    investigationCandidates: [b, c],
    groundTruth: {
      caseId: "actual-topk",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "2" }],
    },
  });
  assert.deepEqual(
    metrics.retrievalTopKCandidates.map((item) => item.sourceId),
    ["2", "3"],
  );
  assert.equal(metrics.topKFound, true);
});

test("C — investigation success is selected/investigated, not promoted", () => {
  const gt = candidate("pull_request", "7", { status: "investigating" });
  assert.notEqual(gt.status, "promoted");
  const metrics = evaluateRetrievalCandidates({
    caseId: "investigated-not-promoted",
    strategy: "evidence_driven",
    candidates: [gt, candidate("pull_request", "8", { status: "rejected" })],
    groundTruth: {
      caseId: "investigated-not-promoted",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
    },
  });
  assert.equal(metrics.discoveryFound, true);
  assert.equal(metrics.topKFound, true);
  assert.equal(metrics.inInvestigationBudget, true);
  assert.equal(metrics.investigationSuccess, true);
  assert.equal(metrics.promotedFound, false);
  assert.equal(metrics.promotedCandidateCount, 0);
  assert.equal(metrics.promotedCandidates.length, 0);
});

test("D — discovered but not in actual Top-K is ranked_out_of_top_k", () => {
  const gt = candidate("pull_request", "99", { lexicalScore: 1, status: "rejected" });
  const selected = [
    candidate("pull_request", "101", { issueReference: true, status: "investigating" }),
    candidate("pull_request", "102", { issueReference: true, status: "investigating" }),
  ];
  const metrics = evaluateRetrievalCandidates({
    caseId: "ranked-out-actual",
    strategy: "evidence_driven",
    candidates: [...selected, gt],
    investigationCandidates: selected,
    groundTruth: {
      caseId: "ranked-out-actual",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "99" }],
    },
  });
  assert.equal(metrics.discoveryFound, true);
  assert.equal(metrics.topKFound, false);
  assert.equal(metrics.diagnosis, "ranked_out_of_top_k");
});

test("E — GT missing from discovered candidates is discovery_failure", () => {
  const metrics = evaluateRetrievalCandidates({
    caseId: "not-discovered",
    strategy: "evidence_driven",
    candidates: [candidate("pull_request", "21", { status: "investigating" })],
    groundTruth: {
      caseId: "not-discovered",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "commit", sourceId: "deadbeef0123456789abcdef0123456789abcdef" }],
    },
  });
  assert.equal(metrics.discoveryFound, false);
  assert.equal(metrics.diagnosis, "discovery_failure");
});

test("F — investigated GT with insufficient_evidence is evidence_insufficient", () => {
  const gt = candidate("pull_request", "7", { status: "investigating" });
  const metrics = evaluateRetrievalCandidates({
    caseId: "insufficient",
    strategy: "evidence_driven",
    candidates: [gt],
    investigationCandidates: [gt],
    groundTruth: {
      caseId: "insufficient",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
    },
    report: verificationReport("insufficient_evidence"),
  });
  assert.equal(metrics.investigationSuccess, true);
  assert.equal(metrics.verificationResult, "insufficient_evidence");
  assert.equal(metrics.diagnosis, "evidence_insufficient");
});

test("diagnoses distinguish discovery, ranking, investigation, and insufficient evidence", () => {
  assert.equal(
    diagnoseRetrieval({
      resolutionExpected: true,
      discoveryFound: false,
      topKFound: false,
      investigationSuccess: false,
      verificationInsufficient: false,
    }),
    "discovery_failure",
  );
  assert.equal(
    diagnoseRetrieval({
      resolutionExpected: true,
      discoveryFound: true,
      topKFound: false,
      investigationSuccess: false,
      verificationInsufficient: false,
    }),
    "ranked_out_of_top_k",
  );
  assert.equal(
    diagnoseRetrieval({
      resolutionExpected: true,
      discoveryFound: true,
      topKFound: true,
      investigationSuccess: false,
      verificationInsufficient: false,
    }),
    "investigation_failed",
  );
  assert.equal(
    diagnoseRetrieval({
      resolutionExpected: true,
      discoveryFound: true,
      topKFound: true,
      investigationSuccess: true,
      verificationInsufficient: true,
    }),
    "evidence_insufficient",
  );
});

test("baseline selection keeps discovery order while evidence-driven ranks", () => {
  const discovered = [
    candidate("pull_request", "99"),
    candidate("pull_request", "101", { issueReference: true }),
    candidate("pull_request", "102", { issueReference: true }),
  ];
  const baseline = applyDiscoveryOrderSelection(discovered, 1);
  const ranked = rankCandidates(discovered);
  assert.equal(baseline.find((item) => item.status === "investigating")?.sourceId, "99");
  assert.equal(ranked[0]?.sourceId, "101");
});

test("synthetic SRE01/SRE02/SRE05/SRE07 cover strong PR, commit, none, and discovery failure", async () => {
  const sre01 = await evaluateSyntheticRetrievalCase("SRE01");
  assert.equal(sre01.evidenceDriven.discoveryFound, true);
  assert.equal(sre01.evidenceDriven.topKFound, true);
  assert.ok(sre01.evidenceDriven.retrievalTopKCandidates.some((item) => item.sourceId === "7"));

  const sre02 = await evaluateSyntheticRetrievalCase("SRE02");
  assert.equal(sre02.evidenceDriven.resolutionExpected, true);
  assert.equal(sre02.evidenceDriven.groundTruth[0]?.sourceType, "commit");

  const sre05 = await evaluateSyntheticRetrievalCase("SRE05");
  assert.equal(sre05.evidenceDriven.diagnosis, "no_resolution_expected");
  assert.equal(sre05.evidenceDriven.recallAt5, null);

  const sre07 = await evaluateSyntheticRetrievalCase("SRE07");
  assert.equal(sre07.evidenceDriven.discoveryFound, false);
  assert.equal(sre07.evidenceDriven.diagnosis, "discovery_failure");
});

test("synthetic SRE03/SRE06 cover multiple valid candidates and ranked-out-of-Top-K", async () => {
  const sre03 = await evaluateSyntheticRetrievalCase("SRE03");
  assert.equal(sre03.evidenceDriven.recallAt5, 1);

  const sre06 = await evaluateSyntheticRetrievalCase("SRE06");
  assert.equal(sre06.evidenceDriven.discoveryFound, true);
  assert.equal(sre06.evidenceDriven.topKFound, false);
  assert.equal(sre06.evidenceDriven.diagnosis, "ranked_out_of_top_k");
  assert.equal(sre06.baseline.discoveryFound, true);
  assert.equal(sre06.baseline.topKFound, true);
});

test("Real-v1 adapter does not mutate ground-truth.json and covers C01-C10", async () => {
  const groundTruthBefore = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  const results = await evaluateRealV1RetrievalCases();
  assert.equal(results.length, 10);
  assert.deepEqual(
    results.map((item) => item.caseId),
    [...RETRIEVAL_EVALUATION_REAL_CASE_IDS],
  );
  const c01 = results.find((item) => item.caseId === "C01");
  assert.ok(c01);
  assert.equal(c01.evidenceDriven.groundTruth[0]?.sourceId, "284149");
  const c08 = results.find((item) => item.caseId === "C08");
  assert.ok(c08);
  assert.equal(c08.evidenceDriven.groundTruth[0]?.sourceType, "commit");
  for (const item of results) {
    for (const arm of [item.evidenceDriven, item.baseline]) {
      for (const sourceType of ["pull_request", "commit"] as const) {
        const selected = arm.discovered.filter(
          (candidate) =>
            candidate.sourceType === sourceType &&
            (candidate.status === "investigating" || candidate.status === "promoted"),
        );
        assert.ok(
          selected.length <= MAX_INVESTIGATED_CANDIDATES,
          `${item.caseId} ${arm.strategy} ${sourceType} selected ${selected.length}`,
        );
      }
      assert.equal(arm.inputTokensEstimated, true);
      assert.equal(arm.providerTokensUnavailable, true);
      if (!arm.resolutionExpected) {
        assert.equal(arm.diagnosis, "no_resolution_expected");
        assert.equal(arm.recallAt5, null);
      }
    }
  }
  const groundTruthAfter = createHash("sha256").update(readFileSync(realDatasetGroundTruthPath())).digest("hex");
  assert.equal(groundTruthAfter, groundTruthBefore);
});

test("production investigate() still uses evidence-driven selection by default", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    useTestDriver: true,
  });
  assert.equal(result.verification?.status, "verified_complete");
  assert.equal(Array.isArray(result.retrievalCandidates), true);
  assert.equal(Array.isArray(result.retrievalTopKCandidates), true);
  assert.equal(Array.isArray(result.investigationCandidates), true);
  assert.equal(Array.isArray(result.investigatedCandidates), true);
  assert.equal(Array.isArray(result.promotedCandidates), true);
});

test("retrieval Top-K is independent of the per-type investigation budget", () => {
  assert.equal(MAX_INVESTIGATED_CANDIDATES, 5);
  assert.equal(RETRIEVAL_TOP_K, 5);
  const selected = [
    candidate("pull_request", "1", { status: "investigating" }),
    candidate("pull_request", "2", { status: "investigating" }),
    candidate("pull_request", "3", { status: "investigating" }),
    candidate("commit", "aaa1111", { status: "promoted" }),
    candidate("commit", "bbb2222", { status: "investigating" }),
    candidate("commit", "e70118a2a11aa239472336f6a961784f04c63c9d", { status: "investigating" }),
  ];
  const metrics = evaluateRetrievalCandidates({
    caseId: "combined-vs-budget",
    strategy: "evidence_driven",
    candidates: selected,
    investigationCandidates: selected,
    groundTruth: {
      caseId: "combined-vs-budget",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "commit", sourceId: "e70118a2a11aa239472336f6a961784f04c63c9d" }],
    },
  });
  assert.equal(metrics.retrievalTopKCandidates.length, RETRIEVAL_TOP_K);
  assert.equal(metrics.investigationCandidates.length, 6);
  assert.equal(metrics.discoveryFound, true);
  assert.equal(metrics.topKFound, false);
  assert.equal(metrics.recallAt5, 0);
  assert.equal(metrics.inInvestigationBudget, true);
  assert.equal(metrics.investigationSuccess, true);
  assert.equal(metrics.promotedFound, false);
  assert.equal(metrics.diagnosis, "ranked_out_of_top_k");
  assert.equal(
    metrics.retrievalTopKCandidates.some((item) => item.sourceId.startsWith("e70118a")),
    false,
  );
  assert.equal(
    metrics.investigationCandidates.some((item) => item.sourceId.startsWith("e70118a")),
    true,
  );
});

test("promoted is not the definition of investigation or retrieval Top-K", () => {
  const investigating = candidate("pull_request", "7", { status: "investigating" });
  const promotedNoise = candidate("pull_request", "8", { status: "promoted" });
  const metrics = evaluateRetrievalCandidates({
    caseId: "promoted-is-later",
    strategy: "evidence_driven",
    candidates: [investigating, promotedNoise],
    investigationCandidates: [investigating, promotedNoise],
    promotedCandidates: [promotedNoise],
    groundTruth: {
      caseId: "promoted-is-later",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
    },
  });
  assert.equal(metrics.topKFound, true);
  assert.equal(metrics.inInvestigationBudget, true);
  assert.equal(metrics.investigationSuccess, true);
  assert.equal(metrics.promotedFound, false);
  assert.deepEqual(
    metrics.promotedCandidates.map((item) => item.sourceId),
    ["8"],
  );
});

test("C08 evidence-driven can investigate outside combined retrieval Top-K", async () => {
  const comparison = await evaluateRealV1RetrievalCase("C08");
  const arm = comparison.evidenceDriven;
  assert.equal(arm.discoveryFound, true);
  assert.equal(arm.inInvestigationBudget, true);
  assert.equal(arm.investigationSuccess, true);
  assert.equal(arm.recallAt5, arm.topKFound ? 1 : 0);
  if (arm.investigationCandidates.length > RETRIEVAL_TOP_K) {
    assert.ok(arm.retrievalTopKCandidates.length <= RETRIEVAL_TOP_K);
    assert.ok(arm.investigationCandidates.length > arm.retrievalTopKCandidates.length);
  }
  const expected = arm.groundTruth[0];
  assert.ok(expected);
  const inTopK = arm.retrievalTopKCandidates.some(
    (item) => item.sourceType === expected.sourceType && item.sourceId.toLowerCase().startsWith("e70118a"),
  );
  const inBudget = arm.investigationCandidates.some(
    (item) => item.sourceType === expected.sourceType && item.sourceId.toLowerCase().startsWith("e70118a"),
  );
  assert.equal(inBudget, true);
  assert.equal(arm.topKFound, inTopK);
});
