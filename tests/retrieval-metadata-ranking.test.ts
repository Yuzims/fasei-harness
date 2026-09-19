/**
 * Metadata-enriched retrieval ranking.
 * Candidate metadata is a ranking signal, not resolution proof.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_INVESTIGATED_CANDIDATES,
  RETRIEVAL_TOP_K,
  applyCandidateSelection,
  applyMetadataEnrichedSelection,
  calculateIssueReferenceStrength,
  calculateMergeStateSignal,
  calculateMessageOrTitleAlignment,
  calculatePathOverlapScore,
  calculateResolutionKeywordSignal,
  calculateStructuralChangeSignal,
  candidateMetadataFromSnapshot,
  createRetrievalCandidate,
  enrichCandidateWithMetadata,
  existingRankingScore,
  extractMetadataSignals,
  investigate,
  metadataScore,
  rankCandidates,
  rankingScore,
} from "../src/investigation/index.js";
import {
  MAX_INVESTIGATED_CANDIDATES as BUDGET_FROM_SELECTION,
  RETRIEVAL_TOP_K as TOP_K_FROM_SELECTION,
} from "../src/investigation/retrieval/selection.js";
import {
  REAL_V1_RETRIEVAL_GROUND_TRUTH,
  evaluateRealV1RetrievalCase,
  evaluateRetrievalCandidates,
  evaluateSyntheticRetrievalCase,
  runRetrievalEvaluation,
  syntheticRetrievalCases,
} from "../src/evaluation/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { UNTRUSTED, type InvestigationSnapshot } from "../src/github/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETRIEVED_AT = "2026-09-19T00:00:00.000Z";

function candidate(sourceId: string, extras?: {
  sourceType?: "pull_request" | "commit";
  lexicalScore?: number;
  issueReference?: boolean;
  status?: "candidate" | "investigating" | "rejected" | "promoted";
}) {
  return createRetrievalCandidate({
    sourceType: extras?.sourceType ?? "pull_request",
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

const ISSUE = { issueNumber: 42, issueTitle: "empty cart save throws", issueBody: "Saving an empty cart throws in src/cart.ts" };

test("A — metadata signal extraction is stable for PR and commit metadata", () => {
  const pr = extractMetadataSignals(
    {
      title: "Fix empty cart save",
      body: "Fixes #42\n\nUpdate src/cart.ts",
      state: "closed",
      merged: true,
      changedFiles: [{ filename: "src/cart.ts", additions: 8, deletions: 2 }],
    },
    ISSUE,
  );
  const commit = extractMetadataSignals(
    { message: "Fix empty cart save\n\nFixes #42" },
    ISSUE,
  );
  assert.equal(pr.issueReferenceStrength, 20);
  assert.ok((pr.pathOverlapScore ?? 0) > 0);
  assert.ok((pr.messageOrTitleAlignment ?? 0) > 0);
  assert.equal(pr.resolutionKeywordSignal, 10);
  assert.equal(pr.mergeStateSignal, 8);
  assert.ok((pr.structuralChangeSignal ?? 0) > 0);
  assert.equal(commit.issueReferenceStrength, 20);
  assert.equal(commit.mergeStateSignal, undefined);
  assert.deepEqual(pr, extractMetadataSignals(
    {
      title: "Fix empty cart save",
      body: "Fixes #42\n\nUpdate src/cart.ts",
      state: "closed",
      merged: true,
      changedFiles: [{ filename: "src/cart.ts", additions: 8, deletions: 2 }],
    },
    ISSUE,
  ));
});

test("B — ranking is deterministic for the same candidate and metadata", () => {
  const catalog = {
    "pull_request:7": {
      title: "Fix empty cart save",
      body: "Fixes #42",
      merged: true,
      changedFiles: [{ filename: "src/cart.ts", additions: 4, deletions: 1 }],
    },
    "pull_request:21": { title: "Docs only", body: "changelog" },
    "pull_request:22": { title: "Unrelated", body: "see #99" },
  };
  const input = [candidate("21"), candidate("7"), candidate("22")];
  const first = applyMetadataEnrichedSelection(input, { catalog, context: ISSUE });
  const second = applyMetadataEnrichedSelection(input, { catalog, context: ISSUE });
  const third = rankCandidates(enrichOnce());
  assert.deepEqual(
    first.map((item) => item.sourceId),
    second.map((item) => item.sourceId),
  );
  assert.deepEqual(
    first.map((item) => item.sourceId),
    applyMetadataEnrichedSelection(input, { catalog, context: ISSUE }).map((item) => item.sourceId),
  );
  assert.deepEqual(
    first.map((item) => rankingScore(item)),
    second.map((item) => rankingScore(item)),
  );
  assert.equal(third[0]?.sourceId, first[0]?.sourceId);

  function enrichOnce() {
    return applyMetadataEnrichedSelection(input, { catalog, context: ISSUE });
  }
});

test("C — metadata mismatch is not a hard filter", () => {
  const unmatched = candidate("99");
  const selected = applyMetadataEnrichedSelection([unmatched], {
    catalog: {},
    context: ISSUE,
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.sourceId, "99");
  assert.notEqual(selected[0]?.status, undefined);
  assert.equal(metadataScore(selected[0]?.relevanceSignals ?? {}), 0);
});

test("D — closing reference is stronger than an ordinary reference", () => {
  const closing = calculateIssueReferenceStrength("Fixes #42 and lands the cart patch", 42);
  const ordinary = calculateIssueReferenceStrength("related to #42 / see #42", 42);
  const negative = calculateIssueReferenceStrength("Does not resolve #42", 42);
  assert.equal(closing, 20);
  assert.equal(ordinary, 8);
  assert.equal(negative, 0);
  assert.ok(closing > ordinary);
  assert.notEqual(closing, ordinary);
});

test("E — metadata signals can change deterministic ordering vs lexical distractors", () => {
  const resolution = candidate("7", { lexicalScore: 1 });
  const distractors = [
    candidate("21", { lexicalScore: 6 }),
    candidate("22", { lexicalScore: 5 }),
    candidate("23", { lexicalScore: 4 }),
  ];
  const discovered = [...distractors, resolution];
  const withoutMetadata = rankCandidates(discovered);
  assert.equal(withoutMetadata[0]?.sourceId, "21");

  const catalog = {
    "pull_request:7": {
      title: "Fix empty cart save",
      body: "Fixes #42",
      merged: true,
      changedFiles: [
        { filename: "src/cart.ts", additions: 12, deletions: 3 },
        { filename: "src/cart.test.ts", additions: 8, deletions: 0 },
      ],
    },
    "pull_request:21": { title: "Docs only", body: "changelog" },
    "pull_request:22": { title: "Docs only", body: "changelog" },
    "pull_request:23": { title: "Docs only", body: "changelog" },
  };
  const withMetadata = applyMetadataEnrichedSelection(discovered, { catalog, context: ISSUE });
  assert.equal(withMetadata[0]?.sourceId, "7");
  assert.equal(withMetadata.length, 4);
  assert.ok(rankingScore(withMetadata[0]!) > existingRankingScore(resolution));
});

test("F — ranking code does not read ground truth, verifier, or task outcome", () => {
  const rankingFiles = [
    join(ROOT, "src/investigation/retrieval/ranking.ts"),
    join(ROOT, "src/investigation/retrieval/metadata-signals.ts"),
    join(ROOT, "src/investigation/retrieval/selection.ts"),
    join(ROOT, "src/investigation/retrieval/discovery.ts"),
    join(ROOT, "src/investigation/retrieval/candidate.ts"),
  ];
  const forbidden = [
    "ground-truth.json",
    "loadGroundTruth",
    "REAL_V1_RETRIEVAL_GROUND_TRUTH",
    "expectedResolution",
    "expectedOutcome",
    "IndependentCompletionVerifier",
    "verificationResult",
    "verified_complete",
    "../evaluation/",
    "src/evaluation",
  ];
  for (const file of rankingFiles) {
    const source = readFileSync(file, "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} contains ${token}`);
    }
  }
});

test("G — metadata ranking does not change MAX_INVESTIGATED_CANDIDATES", () => {
  assert.equal(MAX_INVESTIGATED_CANDIDATES, 5);
  assert.equal(BUDGET_FROM_SELECTION, 5);
  assert.equal(RETRIEVAL_TOP_K, 5);
  assert.equal(TOP_K_FROM_SELECTION, 5);
  const many = Array.from({ length: 12 }, (_, index) => candidate(String(100 + index), { lexicalScore: index }));
  const catalog = Object.fromEntries(
    many.map((item) => [
      `pull_request:${item.sourceId}`,
      { title: `PR ${item.sourceId}`, body: "Fixes #42", merged: true },
    ]),
  );
  const selected = applyMetadataEnrichedSelection(many, { catalog, context: ISSUE });
  const inBudget = selected.filter((item) => item.status === "investigating" || item.status === "promoted");
  assert.equal(inBudget.length, MAX_INVESTIGATED_CANDIDATES);
  assert.equal(selected.length, many.length);
});

test("H — measurement lists stay independently recorded under metadata ranking", async () => {
  const sre01 = syntheticRetrievalCases().find((item) => item.caseId === "SRE01");
  assert.ok(sre01);
  const run = await runRetrievalEvaluation({
    caseId: "SRE01",
    strategy: "metadata_enriched",
    provider: new SnapshotGitHubProvider(sre01.snapshot),
    groundTruth: sre01.groundTruth,
  });
  assert.equal(Array.isArray(run.report.retrievalCandidates), true);
  assert.equal(Array.isArray(run.report.retrievalTopKCandidates), true);
  assert.equal(Array.isArray(run.report.investigationCandidates), true);
  assert.equal(Array.isArray(run.report.investigatedCandidates), true);
  assert.equal(Array.isArray(run.report.promotedCandidates), true);
  assert.equal(Array.isArray(run.metrics.retrievalTopKCandidates), true);
  assert.equal(Array.isArray(run.metrics.investigationCandidates), true);
  assert.equal(Array.isArray(run.metrics.investigatedCandidates), true);
  assert.equal(Array.isArray(run.metrics.promotedCandidates), true);
  assert.equal(run.metrics.strategy, "metadata_enriched");
  assert.ok(run.metrics.retrievalTopKCandidates.length <= RETRIEVAL_TOP_K);
});

test("I — C08 combined Recall@5 and source-specific investigation success can still differ", async () => {
  const comparison = await evaluateRealV1RetrievalCase("C08");
  for (const arm of [comparison.baseline, comparison.evidenceDriven, comparison.metadataEnriched]) {
    assert.equal(arm.discoveryFound, true);
    assert.equal(arm.investigationSuccess, true);
    assert.equal(arm.inInvestigationBudget, true);
    assert.ok(arm.retrievalTopKCandidates.length <= RETRIEVAL_TOP_K);
    for (const sourceType of ["pull_request", "commit"] as const) {
      const selected = arm.discovered.filter(
        (item) =>
          item.sourceType === sourceType &&
          (item.status === "investigating" || item.status === "promoted"),
      );
      assert.ok(selected.length <= MAX_INVESTIGATED_CANDIDATES, `${arm.strategy} ${sourceType}`);
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
    assert.equal(arm.recallAt5, inTopK ? 1 : 0);
    if (arm.investigationCandidates.length > RETRIEVAL_TOP_K) {
      assert.ok(arm.retrievalTopKCandidates.length <= RETRIEVAL_TOP_K);
      assert.ok(arm.investigationCandidates.length > arm.retrievalTopKCandidates.length);
    }
  }
  assert.equal(comparison.metadataEnriched.strategy, "metadata_enriched");
  assert.equal(REAL_V1_RETRIEVAL_GROUND_TRUTH.C08?.validCandidates[0]?.sourceType, "commit");
});

test("metadata-enriched comparison keeps discovery-order and evidence-driven arms", async () => {
  const sre01 = await evaluateSyntheticRetrievalCase("SRE01");
  assert.equal(sre01.baseline.strategy, "baseline");
  assert.equal(sre01.evidenceDriven.strategy, "evidence_driven");
  assert.equal(sre01.metadataEnriched.strategy, "metadata_enriched");
  assert.equal(sre01.baseline.candidateCount, sre01.evidenceDriven.candidateCount);
  assert.equal(sre01.baseline.candidateCount, sre01.metadataEnriched.candidateCount);
});

test("individual metadata calculators stay bounded and observable", () => {
  assert.equal(calculateResolutionKeywordSignal("fix the cart"), 10);
  assert.equal(calculateResolutionKeywordSignal("update changelog"), 0);
  assert.equal(calculateMergeStateSignal(true, "closed"), 8);
  assert.equal(calculateMergeStateSignal(false, "closed"), 0);
  assert.equal(calculateStructuralChangeSignal([]), 0);
  assert.equal(calculateStructuralChangeSignal([{ filename: "a.ts", additions: 1, deletions: 0 }]), 4);
  assert.equal(
    calculateStructuralChangeSignal([
      { filename: "a.ts", additions: 8, deletions: 2 },
      { filename: "b.ts", additions: 1, deletions: 0 },
    ]),
    8,
  );
  assert.ok(
    calculatePathOverlapScore("empty cart in src/cart.ts", [{ filename: "src/cart.ts" }]) >
      calculatePathOverlapScore("empty cart in src/cart.ts", [{ filename: "docs/readme.md" }]),
  );
  assert.ok(
    calculateMessageOrTitleAlignment("empty cart save throws", "Fix empty cart save") >
      calculateMessageOrTitleAlignment("empty cart save throws", "docs only"),
  );
  const aligned = calculateMessageOrTitleAlignment("a ".repeat(40) + "cart save", "cart save token ".repeat(20));
  assert.ok(aligned <= 15);
});

test("existing ranking score is unchanged when metadata signals are absent", () => {
  const item = candidate("7", { issueReference: true, lexicalScore: 4 });
  assert.equal(rankingScore(item), existingRankingScore(item));
  assert.equal(rankingScore(item), 104);
  const enriched = enrichCandidateWithMetadata(
    item,
    { title: "Fix empty cart save", body: "Fixes #42", merged: true },
    ISSUE,
  );
  assert.equal(existingRankingScore(enriched), 104);
  assert.ok(rankingScore(enriched) > existingRankingScore(enriched));
});

test("snapshot catalog does not invent candidates and production default stays evidence-driven", async () => {
  const snapshot: InvestigationSnapshot = {
    snapshotId: "meta-empty",
    schemaVersion: 1,
    createdAt: RETRIEVED_AT,
    source: "github",
    owner: "acme",
    repository: "box",
    issueNumber: 42,
    retrievedAt: RETRIEVED_AT,
    trust: UNTRUSTED,
    repositoryData: {
      id: "repo:acme/box",
      repository: "acme/box",
      source: "github",
      url: "https://github.com/acme/box",
      retrievedAt: RETRIEVED_AT,
      trust: UNTRUSTED,
      owner: "acme",
      name: "box",
      description: "",
      defaultBranch: "main",
    },
    issue: {
      id: "issue:acme/box#42",
      repository: "acme/box",
      source: "github",
      url: "https://github.com/acme/box/issues/42",
      retrievedAt: RETRIEVED_AT,
      trust: UNTRUSTED,
      number: 42,
      title: "none",
      body: "no candidate",
      state: "closed",
    },
    comments: [],
    timeline: [],
    pullRequests: {},
    reviews: {},
    files: {},
    commits: { repo: [] },
    commitIndex: {},
  };
  const catalog = candidateMetadataFromSnapshot(snapshot);
  assert.deepEqual(catalog, {});
  const selected = applyMetadataEnrichedSelection([], { catalog, context: ISSUE });
  assert.deepEqual(selected, []);

  const evidenceOnly = applyCandidateSelection([candidate("7"), candidate("8")]);
  const metadata = applyMetadataEnrichedSelection([candidate("7"), candidate("8")], {
    catalog: {},
    context: ISSUE,
  });
  assert.deepEqual(
    evidenceOnly.map((item) => item.sourceId),
    metadata.map((item) => item.sourceId),
  );

  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(snapshot),
    useTestDriver: true,
    maxSteps: 4,
  });
  assert.equal(Array.isArray(result.retrievalTopKCandidates), true);
});

test("evaluator still uses runtime Top-K lists, not a re-rank of metadata scores", () => {
  const gt = candidate("7", { status: "investigating" });
  const noise = candidate("8", { status: "investigating" });
  const metrics = evaluateRetrievalCandidates({
    caseId: "runtime-topk",
    strategy: "metadata_enriched",
    candidates: [gt, noise],
    retrievalTopKCandidates: [noise],
    investigationCandidates: [gt, noise],
    groundTruth: {
      caseId: "runtime-topk",
      expectedResolution: "candidate",
      validCandidates: [{ sourceType: "pull_request", sourceId: "7" }],
    },
  });
  assert.deepEqual(
    metrics.retrievalTopKCandidates.map((item) => item.sourceId),
    ["8"],
  );
  assert.equal(metrics.topKFound, false);
  assert.equal(metrics.investigationSuccess, true);
});
