import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOVERY_BOUNDS,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  graphFromRun,
  type EvidenceTrust,
  type FailureEvent,
  type RecoveryPlan,
  type VerificationResult,
} from "../src/domain/index.js";
import {
  IndependentCompletionVerifier,
  RecoveryPlanner,
  RESOLUTION_GAP_ANALYZER_NOTICE,
  RESOLUTION_GAP_RECOVERY_AUTO_EXECUTE,
  analyzeResolutionGaps,
  analyzeResolutionGapsForRun,
  applyRecoveryPlan,
  buildResolutionAnalyses,
  buildResolutionChain,
  investigate,
  toRecoveryActionCandidates,
} from "../src/investigation/index.js";
import { InvestigationState } from "../src/investigation/state.js";
import type { AnalysisContext } from "../src/investigation/analysis-context.js";
import { SnapshotGitHubProvider, githubFixturePath } from "../src/github/index.js";
import type { FileChangeSnapshot } from "../src/github/types.js";

const RETRIEVED_AT = "2026-09-20T00:00:00.000Z";
const CART_PATCH = [
  "@@ -1,3 +1,5 @@",
  " export function saveCart() {",
  "-  return cart;",
  "+  if (!cart) throw new Error(\"empty cart\");",
  "+  return cart;",
  " }",
].join("\n");

class PatchFileProvider extends SnapshotGitHubProvider {
  constructor(
    fixture: string,
    private readonly extra: Array<Partial<FileChangeSnapshot> & { filename: string }>,
  ) {
    super(githubFixturePath(fixture));
  }

  override async getPullRequestFiles(ref: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<FileChangeSnapshot[]> {
    const files = await super.getPullRequestFiles(ref);
    const patched = files.map((file) => {
      const override = this.extra.find((item) => item.filename === file.filename);
      return override ? { ...file, ...override } : file;
    });
    const extras = this.extra
      .filter((item) => !files.some((file) => file.filename === item.filename))
      .map((item) => ({
        id: `file:acme/box#${ref.pullNumber}:${item.filename}`,
        repository: "acme/box",
        pullNumber: ref.pullNumber,
        filename: item.filename,
        status: item.status ?? "added",
        additions: item.additions ?? 3,
        deletions: item.deletions ?? 0,
        source: "github",
        url: `https://github.com/acme/box/pull/${ref.pullNumber}`,
        retrievedAt: RETRIEVED_AT,
        trust: "external_untrusted" as const,
        patch: item.patch,
        patchTruncated: item.patchTruncated,
      }));
    return [...patched, ...extras];
  }
}

function provenance(resource: string, url = "https://github.com/acme/box/issues/42") {
  return {
    source: "github",
    operation: "test",
    resource,
    url,
    repository: "acme/box",
    retrievedAt: RETRIEVED_AT,
    trust: "external_untrusted" as const,
  };
}

function fileEvidence(input: {
  id?: string;
  filename: string;
  patch?: string;
  pullNumber?: number;
}) {
  const pullNumber = input.pullNumber ?? 7;
  return createEvidence({
    id: input.id,
    kind: "file",
    summary: `PR #${pullNumber} modified ${input.filename}`,
    contentRef: `file:${pullNumber}:${input.filename}`,
    payload: {
      pullNumber,
      filename: input.filename,
      status: "modified",
      additions: 4,
      deletions: 1,
      ...(input.patch ? { patch: input.patch, patchTruncated: false } : {}),
    },
    provenance: provenance(`pull/${pullNumber}/files/${input.filename}`, "https://github.com/acme/box/pull/7"),
  });
}

function seededRun(input?: {
  issueTitle?: string;
  files?: ReturnType<typeof fileEvidence>[];
  includeCandidate?: boolean;
}) {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const issue = createEvidence({
    id: "ev-issue",
    kind: "issue",
    summary: input?.issueTitle ?? "Null pointer when saving empty cart",
    contentRef: "issue:42",
    payload: {
      number: 42,
      repository: "acme/box",
      state: "closed",
      title: input?.issueTitle ?? "Null pointer when saving empty cart",
    },
    provenance: provenance("issues/42"),
  });
  const evidence = [issue];
  const pr =
    input?.includeCandidate === false
      ? undefined
      : createEvidence({
          id: "ev-pr",
          kind: "pull_request",
          summary: "PR #7 is merged",
          contentRef: "pr:7",
          payload: { number: 7, merged: true, mergeCommitSha: "abc123def456", state: "closed", title: "guard empty cart" },
          provenance: provenance("pull/7", "https://github.com/acme/box/pull/7"),
        });
  if (pr) {
    evidence.push(pr);
  }
  evidence.push(...(input?.files ?? []));
  run.evidence.push(...evidence);
  return { task, run, issue, pr };
}

function withTrust(run: ReturnType<typeof seededRun>["run"], trust: EvidenceTrust) {
  return {
    ...run,
    evidence: run.evidence.map((item) => ({
      ...item,
      provenance: { ...item.provenance, trust },
    })),
  };
}

function verificationFingerprint(result: { status: string; checks: Array<{ id: string; status: string }> }) {
  return `${result.status}|${result.checks.map((item) => `${item.id}:${item.status}`).join("|")}`;
}

test("Gap Analyzer 不改变 verifier result", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new PatchFileProvider("resolved", [{ filename: "src/cart.ts", patch: CART_PATCH }]),
    useTestDriver: true,
  });
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task: result.task, run: result.run });
  const gaps = analyzeResolutionGapsForRun(result.run);
  const after = verifier.verify({ task: result.task, run: result.run });
  assert.equal(verificationFingerprint(after), verificationFingerprint(before));
  assert.equal(after.status, result.verification?.status);
  assert.ok(Array.isArray(gaps));
  assert.match(RESOLUTION_GAP_ANALYZER_NOTICE, /not verification/i);
});

test("unknown evidence 不能生成 absent claim", () => {
  const { run, pr } = seededRun();
  assert.ok(pr);
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const graph = graphFromRun(run);
  const chain = buildResolutionChain({ graph, analysis: run.resolutionAnalyses[0] });
  assert.equal(chain.code_change.status, "unknown");
  assert.equal(chain.affected_area.status, "unknown");
  assert.equal(chain.validation.status, "unknown");
  const gaps = analyzeResolutionGaps(chain, graph);
  assert.ok(gaps.some((item) => item.type === "insufficient_resolution_context"));
  const corpus = JSON.stringify({ chain, gaps });
  assert.equal(/no code change happened/i.test(corpus), false);
  assert.equal(/no tests exist/i.test(corpus), false);
  assert.equal(chain.code_change.status === "unknown", true);
});

test("missing patch 不能生成 code_change unsupported", () => {
  const { run } = seededRun({
    files: [fileEvidence({ id: "ev-src", filename: "src/cart.ts" })],
  });
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const graph = graphFromRun(run);
  const chain = buildResolutionChain({ graph, analysis: run.resolutionAnalyses[0] });
  assert.equal(chain.affected_area.status, "observed");
  assert.equal(chain.code_change.status, "unknown");
  assert.notEqual(String(chain.code_change.status), "unsupported");
  const gaps = analyzeResolutionGaps(chain, graph);
  assert.ok(gaps.some((item) => item.type === "missing_patch_evidence"));
  assert.equal(gaps.some((item) => /unsupported/i.test(item.explanation)), false);
  assert.equal(/no code change happened/i.test(JSON.stringify(gaps)), false);
});

test("Gap 必须引用 Evidence ID", () => {
  const { run } = seededRun({
    files: [fileEvidence({ id: "ev-src", filename: "src/cart.ts" })],
  });
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const graph = graphFromRun(run);
  const known = new Set(graph.evidence.map((item) => item.id));
  const gaps = analyzeResolutionGapsForRun(run, graph);
  assert.ok(gaps.length > 0);
  for (const item of gaps) {
    assert.ok(item.evidenceIds.length > 0);
    assert.equal(item.evidenceIds.every((id) => known.has(id)), true);
  }
});

test("Recovery suggestion 不会自动执行", () => {
  const { task, run } = seededRun({
    files: [fileEvidence({ id: "ev-src", filename: "src/cart.ts" })],
  });
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const gaps = analyzeResolutionGapsForRun(run);
  const suggestions = toRecoveryActionCandidates(gaps);
  assert.equal(RESOLUTION_GAP_RECOVERY_AUTO_EXECUTE, false);
  assert.ok(suggestions.length > 0);
  assert.equal(suggestions.every((item) => item.autoExecute === false), true);

  const planner = new RecoveryPlanner();
  const state = new InvestigationState(task, run);
  const verification: VerificationResult = {
    status: "insufficient_evidence",
    checks: [],
    evidenceCoverage: 0,
    unsupportedClaimIds: [],
    missingRequirementIds: ["req-pr"],
    prematureCompletion: false,
  };
  const ctx: AnalysisContext = {
    task,
    state,
    verification,
    attempt: 1,
    previousFingerprints: [],
    previousRecoveries: [],
    bounds: { ...RECOVERY_BOUNDS },
  };
  const failure: FailureEvent = {
    type: "insufficient_evidence",
    reason: "Required evidence is missing.",
    evidenceIds: [],
    missingRequirementIds: ["req-pr"],
    confidence: 0.8,
  };
  const planned: RecoveryPlan = planner.plan(failure, ctx);
  const plannedAgain: RecoveryPlan = planner.plan(failure, ctx);
  assert.deepEqual(plannedAgain, planned);
  assert.equal(state.run.evidence.length, run.evidence.length);
  assert.equal(typeof applyRecoveryPlan, "function");
  assert.equal(
    suggestions.some((item) => item.recommendedActions.includes("fetch_commit_patch")),
    true,
  );
});

test("external_untrusted evidence 不能改变 gap classification", () => {
  const { run } = seededRun({
    files: [fileEvidence({ id: "ev-src", filename: "src/cart.ts" })],
  });
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const untrusted = withTrust(run, "external_untrusted");
  untrusted.resolutionAnalyses = buildResolutionAnalyses(untrusted);
  const derived = withTrust(run, "harness_derived");
  derived.resolutionAnalyses = buildResolutionAnalyses(derived);
  const left = analyzeResolutionGapsForRun(untrusted).map((item) => `${item.type}:${item.severity}`).sort();
  const right = analyzeResolutionGapsForRun(derived).map((item) => `${item.type}:${item.severity}`).sort();
  assert.deepEqual(left, right);
  assert.ok(left.includes("missing_patch_evidence:warning") || left.includes("missing_patch_evidence:blocking"));
});

test("weak issue-change alignment without behavior hypothesis", () => {
  const { run } = seededRun({
    issueTitle: "widget flicker",
    files: [fileEvidence({ id: "ev-file", filename: "src/widget.ts" })],
  });
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  const graph = graphFromRun(run);
  const chain = buildResolutionChain({ graph, analysis: run.resolutionAnalyses[0] });
  if (chain.alignment.status !== "partial") {
    chain.alignment.status = "partial";
    chain.behaviorHypothesis.present = false;
  }
  const gaps = analyzeResolutionGaps(chain, graph);
  assert.ok(gaps.some((item) => item.type === "weak_issue_change_alignment"));
  assert.equal(gaps.find((item) => item.type === "weak_issue_change_alignment")?.severity, "warning");
});

test("issue without candidate produces missing_candidate", () => {
  const { run } = seededRun({ includeCandidate: false });
  const graph = graphFromRun(run);
  const chain = buildResolutionChain({ graph });
  const gaps = analyzeResolutionGaps(chain, graph);
  assert.equal(chain.candidate.status, "unknown");
  assert.ok(gaps.some((item) => item.type === "missing_candidate"));
  assert.ok(gaps[0]?.evidenceIds.includes("ev-issue"));
});
