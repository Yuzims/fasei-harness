import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  type ResolutionGap,
  type ResolutionGapType,
  type VerificationResult,
} from "../src/domain/index.js";
import {
  IndependentCompletionVerifier,
  RECOVERY_INTENT_AUTO_EXECUTE,
  RECOVERY_INTENT_NOTICE,
  RecoveryPlanner,
  RESOLUTION_GAP_OBJECTIVE_MAPPING,
  analyzeResolutionGapsForRun,
  applyRecoveryPlan,
  buildResolutionAnalyses,
  deriveRecoveryIntents,
  investigate,
  recordRecoveryIntentDecisions,
  toRecoveryActionCandidatesFromIntents,
  toRecoveryIntentEvents,
} from "../src/investigation/index.js";
import { InvestigationState } from "../src/investigation/state.js";
import type { AnalysisContext } from "../src/investigation/analysis-context.js";
import { SnapshotGitHubProvider, githubFixturePath } from "../src/github/index.js";
import type { FileChangeSnapshot } from "../src/github/types.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { intentHasExecutionLeak } from "../src/evaluation/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

function fileEvidence(filename: string, id = "ev-src") {
  return createEvidence({
    id,
    kind: "file",
    summary: `PR #7 modified ${filename}`,
    contentRef: `file:7:${filename}`,
    payload: {
      pullNumber: 7,
      filename,
      status: "modified",
      additions: 4,
      deletions: 1,
    },
    provenance: provenance(`pull/7/files/${filename}`, "https://github.com/acme/box/pull/7"),
  });
}

function seededRun(files: ReturnType<typeof fileEvidence>[] = [fileEvidence("src/cart.ts")]) {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  run.evidence.push(
    createEvidence({
      id: "ev-issue",
      kind: "issue",
      summary: "Null pointer when saving empty cart",
      contentRef: "issue:42",
      payload: {
        number: 42,
        repository: "acme/box",
        state: "closed",
        title: "Null pointer when saving empty cart",
      },
      provenance: provenance("issues/42"),
    }),
    createEvidence({
      id: "ev-pr",
      kind: "pull_request",
      summary: "PR #7 is merged",
      contentRef: "pr:7",
      payload: { number: 7, merged: true, mergeCommitSha: "abc123def456", state: "closed", title: "guard empty cart" },
      provenance: provenance("pull/7", "https://github.com/acme/box/pull/7"),
    }),
    ...files,
  );
  run.resolutionAnalyses = buildResolutionAnalyses(run);
  return { task, run };
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

function gap(type: ResolutionGapType, severity: ResolutionGap["severity"] = "blocking"): ResolutionGap {
  return {
    candidateId: "cand-1",
    type,
    severity,
    missingEvidenceTypes: [],
    evidenceIds: ["ev-issue"],
    explanation: "synthetic gap",
    recommendedActions: [],
  };
}

function verificationFingerprint(result: { status: string; checks: Array<{ id: string; status: string }> }) {
  return `${result.status}|${result.checks.map((item) => `${item.id}:${item.status}`).join("|")}`;
}

function intentFingerprint(intents: ReturnType<typeof deriveRecoveryIntents>) {
  return intents.map((item) => `${item.objective}:${item.priority}:${item.triggerGapTypes.join(",")}`).join("|");
}

test("Test 1 — missing_patch_evidence maps to collect_resolution_evidence", () => {
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.missing_patch_evidence, "collect_resolution_evidence");
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.missing_file_evidence, "collect_resolution_evidence");
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.insufficient_resolution_context, "collect_resolution_evidence");
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.missing_validation_evidence, "collect_validation_evidence");
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.missing_candidate, "expand_candidate_discovery");
  assert.equal(RESOLUTION_GAP_OBJECTIVE_MAPPING.weak_issue_change_alignment, "improve_issue_change_alignment");
  const intents = deriveRecoveryIntents([gap("missing_patch_evidence")]);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.objective, "collect_resolution_evidence");
  assert.deepEqual(intents[0]?.triggerGapTypes, ["missing_patch_evidence"]);
  assert.match(RECOVERY_INTENT_NOTICE, /not a tool call/i);
});

test("Test 2 — missing_patch and missing_file merge into one collect_resolution_evidence", () => {
  const intents = deriveRecoveryIntents([
    gap("missing_patch_evidence"),
    gap("missing_file_evidence"),
    gap("missing_patch_evidence", "warning"),
  ]);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.objective, "collect_resolution_evidence");
  assert.deepEqual(intents[0]?.triggerGapTypes, ["missing_patch_evidence", "missing_file_evidence"]);
  assert.equal(intents[0]?.priority, "blocking");
});

test("Test 3 — Intent does not contain tool execution", () => {
  const intents = deriveRecoveryIntents([
    gap("missing_patch_evidence"),
    gap("missing_validation_evidence", "warning"),
    gap("missing_candidate"),
    gap("weak_issue_change_alignment", "warning"),
  ]);
  const candidates = toRecoveryActionCandidatesFromIntents(intents);
  const events = toRecoveryIntentEvents("failure-1", intents);
  assert.equal(intentHasExecutionLeak(intents), false);
  assert.equal(intentHasExecutionLeak(events), false);
  for (const intent of intents) {
    assert.equal("tool" in intent, false);
    assert.equal("toolName" in intent, false);
    assert.equal("apiCall" in intent, false);
    assert.equal("execution" in intent, false);
    assert.equal("executionResult" in intent, false);
  }
  assert.equal(candidates.every((item) => item.autoExecute === false), true);
  assert.equal(
    candidates.some((item) => /^github_/.test(item.action) || /tool_call/i.test(item.action)),
    false,
  );
});

test("Test 4 — Intent does not change verifier result", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new PatchFileProvider("resolved", [{ filename: "src/cart.ts", patch: CART_PATCH }]),
    useTestDriver: true,
  });
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task: result.task, run: result.run });
  const gaps = analyzeResolutionGapsForRun(result.run);
  const intents = deriveRecoveryIntents(gaps);
  const candidates = toRecoveryActionCandidatesFromIntents(intents);
  const after = verifier.verify({ task: result.task, run: result.run });
  assert.equal(verificationFingerprint(after), verificationFingerprint(before));
  assert.equal(after.status, result.verification?.status);
  assert.equal(RECOVERY_INTENT_AUTO_EXECUTE, false);
  assert.equal(candidates.every((item) => item.autoExecute === false), true);

  const planner = new RecoveryPlanner();
  const state = new InvestigationState(result.task, result.run);
  const verification: VerificationResult = {
    status: "insufficient_evidence",
    checks: [],
    evidenceCoverage: 0,
    unsupportedClaimIds: [],
    missingRequirementIds: ["req-pr"],
    prematureCompletion: false,
  };
  const ctx: AnalysisContext = {
    task: result.task,
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
  assert.equal(state.run.evidence.length, result.run.evidence.length);
  assert.equal(typeof applyRecoveryPlan, "function");
});

test("Test 5 — external_untrusted evidence cannot change Intent classification", () => {
  const { run } = seededRun();
  const untrusted = withTrust(run, "external_untrusted");
  untrusted.resolutionAnalyses = buildResolutionAnalyses(untrusted);
  const derived = withTrust(run, "harness_derived");
  derived.resolutionAnalyses = buildResolutionAnalyses(derived);
  const graphUntrusted = graphFromRun(untrusted);
  const graphDerived = graphFromRun(derived);
  assert.ok(graphUntrusted.evidence.length > 0);
  assert.ok(graphDerived.evidence.length > 0);
  const left = intentFingerprint(deriveRecoveryIntents(analyzeResolutionGapsForRun(untrusted)));
  const right = intentFingerprint(deriveRecoveryIntents(analyzeResolutionGapsForRun(derived)));
  assert.equal(left, right);
  assert.match(left, /collect_resolution_evidence/);
});

test("adapter emits candidates without executing them", () => {
  const intents = deriveRecoveryIntents([gap("missing_patch_evidence"), gap("missing_file_evidence")]);
  const candidates = toRecoveryActionCandidatesFromIntents(intents);
  assert.equal(candidates.some((item) => item.action === "fetch_commit_patch"), true);
  assert.equal(candidates.every((item) => item.autoExecute === false), true);
  assert.equal(intentHasExecutionLeak(candidates), false);
});

test("trace records Recovery Intent decisions only", () => {
  const intents = deriveRecoveryIntents([gap("missing_patch_evidence")]);
  const events = toRecoveryIntentEvents("failure-42", intents);
  const trace = new TraceCollector();
  recordRecoveryIntentDecisions(trace, "run-42", 0, events);
  const recorded = trace.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.failureId, "failure-42");
  assert.deepEqual(events[0]?.gapTypes, ["missing_patch_evidence"]);
  assert.equal(events[0]?.intent, "collect_resolution_evidence");
  assert.equal(recorded[0]?.type, "recovery_intent");
  assert.deepEqual(recorded[0]?.data, {
    failureId: "failure-42",
    gapTypes: ["missing_patch_evidence"],
    intent: "collect_resolution_evidence",
  });
  assert.equal("result" in (recorded[0]?.data ?? {}), false);
  assert.equal("tool" in (recorded[0]?.data ?? {}), false);
  assert.equal("success" in (recorded[0]?.data ?? {}), false);
});

test("Recovery Intent layer does not import planner, GitHub, or agent loop", () => {
  const folder = join(ROOT, "src", "investigation", "recovery");
  for (const file of readdirSync(folder)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(folder, file), "utf8");
    assert.equal(/from ["'][^"']*recovery-planner/.test(source), false, file);
    assert.equal(/from ["'][^"']*apply-recovery/.test(source), false, file);
    assert.equal(/from ["'][^"']*agent-loop/.test(source), false, file);
    assert.equal(/from ["'][^"']*github/.test(source), false, file);
    assert.equal(/from ["'][^"']*independent-completion-verifier/.test(source), false, file);
  }
});
