/**
 * Phase 15 — Recovery Eligibility tests.
 *
 * Eligibility answers only "may the existing Controlled Recovery path start?".
 * These tests pin Rules A–D, the negative action-semantics boundary, and the
 * full investigate() → ControlledRecoveryLoop → Evidence → verifier re-run path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import type { Task, ToolResult } from "../src/core/types.js";
import {
  createEvidence,
  type InvestigationRun,
  type ResolutionGap,
  type ResolutionGapSeverity,
  type ResolutionGapType,
  type VerificationResult,
} from "../src/domain/index.js";
import type { FailureCategory } from "../src/failure/failure-types.js";
import type { FailureReport } from "../src/failure/report/failure-report-types.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  createRecoveryExecutor,
  evaluateRecoveryEligibility,
  investigate,
  type InvestigationSession,
  type RecoveryEligibility,
} from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const RETRIEVED_AT = "2026-09-20T00:00:00.000Z";

function verificationWithStatus(status: VerificationResult["status"]): VerificationResult {
  return {
    status,
    checks: [],
    evidenceCoverage: 0,
    unsupportedClaimIds: [],
    missingRequirementIds: [],
    prematureCompletion: false,
  };
}

function failureReportWith(category: FailureCategory, severity: ResolutionGapSeverity): FailureReport {
  return {
    id: `failure-report-${category}`,
    investigationId: "run-eligibility-test",
    status: severity === "blocking" ? "failed" : "incomplete",
    failures: [
      {
        category,
        severity,
        description: `Fixture diagnosis for ${category}.`,
      },
    ],
    createdAt: RETRIEVED_AT,
  };
}

function gapOf(type: ResolutionGapType, severity: ResolutionGapSeverity): ResolutionGap {
  return {
    candidateId: "pr:7",
    type,
    severity,
    missingEvidenceTypes: ["file"],
    evidenceIds: ["ev-issue"],
    explanation: "Fixture gap.",
    recommendedActions: ["inspect_changed_files"],
  };
}

const FORBIDDEN_ACTION_KEYS = [
  "tool",
  "action",
  "nextAction",
  "retryPlan",
  "executionPlan",
  "recoveryIntent",
  "recoveryPlan",
  "recommendedTool",
] as const;

function assertNoActionSemantics(eligibility: RecoveryEligibility): void {
  assert.deepEqual(Object.keys(eligibility).sort(), ["eligible", "reason"]);
  const serialized = JSON.stringify(eligibility);
  for (const key of FORBIDDEN_ACTION_KEYS) {
    assert.equal(
      new RegExp(`"${key}"`).test(serialized),
      false,
      `RecoveryEligibility must not expose "${key}"`,
    );
  }
}

test("Test 1 — verified_complete is never eligible even with a FailureReport and a blocking gap", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("verified_complete"),
    failureReport: failureReportWith("resolution_gap", "blocking"),
    gaps: [gapOf("insufficient_resolution_context", "blocking")],
  });
  assert.deepEqual(eligibility, { eligible: false, reason: "verified_complete" });
  assertNoActionSemantics(eligibility);
});

test("Test 2 — no FailureReport: verification failure alone never triggers Recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: undefined,
    gaps: [gapOf("insufficient_resolution_context", "blocking")],
  });
  assert.deepEqual(eligibility, { eligible: false, reason: "no_failure_report" });
  assertNoActionSemantics(eligibility);
});

test("Test 3 — FailureReport with no ResolutionGaps is not eligible", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: failureReportWith("missing_evidence", "blocking"),
    gaps: [],
  });
  assert.deepEqual(eligibility, { eligible: false, reason: "no_blocking_resolution_gap" });
  assertNoActionSemantics(eligibility);
});

test("Test 4 — warning-only gaps are not eligible", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: failureReportWith("missing_evidence", "blocking"),
    gaps: [
      gapOf("missing_validation_evidence", "warning"),
      gapOf("weak_issue_change_alignment", "warning"),
    ],
  });
  assert.deepEqual(eligibility, { eligible: false, reason: "no_blocking_resolution_gap" });
  assertNoActionSemantics(eligibility);
});

test("Test 5 — insufficient_evidence + FailureReport + blocking gap allows Recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: failureReportWith("resolution_gap", "blocking"),
    gaps: [gapOf("insufficient_resolution_context", "blocking")],
  });
  assert.deepEqual(eligibility, { eligible: true, reason: "recovery_allowed" });
  assertNoActionSemantics(eligibility);
});

test("Test 6 — not_verified + FailureReport + blocking gap allows Recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("not_verified"),
    failureReport: failureReportWith("contradicted_claim", "blocking"),
    gaps: [gapOf("missing_file_evidence", "blocking")],
  });
  assert.deepEqual(eligibility, { eligible: true, reason: "recovery_allowed" });
  assertNoActionSemantics(eligibility);
});

test("Test 7 — one blocking gap among warnings still allows Recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: failureReportWith("verification_incomplete", "blocking"),
    gaps: [
      gapOf("missing_validation_evidence", "warning"),
      gapOf("missing_candidate", "blocking"),
    ],
  });
  assert.deepEqual(eligibility, { eligible: true, reason: "recovery_allowed" });
  assertNoActionSemantics(eligibility);
});

test("Test 8 — architecture: FailureReport without a blocking ResolutionGap means no Recovery", () => {
  const reportOnly = evaluateRecoveryEligibility({
    verification: verificationWithStatus("not_verified"),
    failureReport: failureReportWith("missing_evidence", "blocking"),
    gaps: [gapOf("missing_validation_evidence", "warning")],
  });
  assert.equal(reportOnly.eligible, false);

  const warningReport = evaluateRecoveryEligibility({
    verification: verificationWithStatus("insufficient_evidence"),
    failureReport: failureReportWith("unsupported_claim", "warning"),
    gaps: [gapOf("missing_validation_evidence", "warning")],
  });
  assert.equal(warningReport.eligible, false);
  assert.equal(warningReport.reason, "no_blocking_resolution_gap");
});

test("Test 9 — FailureCategory never changes the eligibility verdict", () => {
  const categories: FailureCategory[] = [
    "missing_evidence",
    "unsupported_claim",
    "contradicted_claim",
    "resolution_gap",
    "verification_incomplete",
  ];
  const gaps: ResolutionGap[] = [gapOf("insufficient_resolution_context", "blocking")];
  const allowed = categories.map((category) =>
    evaluateRecoveryEligibility({
      verification: verificationWithStatus("insufficient_evidence"),
      failureReport: failureReportWith(category, "blocking"),
      gaps,
    }),
  );
  for (const eligibility of allowed) {
    assert.deepEqual(eligibility, { eligible: true, reason: "recovery_allowed" });
  }

  const warningGaps: ResolutionGap[] = [gapOf("missing_validation_evidence", "warning")];
  const blocked = categories.map((category) =>
    evaluateRecoveryEligibility({
      verification: verificationWithStatus("insufficient_evidence"),
      failureReport: failureReportWith(category, "blocking"),
      gaps: warningGaps,
    }),
  );
  for (const eligibility of blocked) {
    assert.deepEqual(eligibility, { eligible: false, reason: "no_blocking_resolution_gap" });
  }
});

function provenance(resource: string, url = "https://github.com/acme/box/issues/42") {
  return {
    source: "github",
    operation: "recovery",
    resource,
    url,
    repository: "acme/box",
    retrievedAt: RETRIEVED_AT,
    trust: "external_untrusted" as const,
  };
}

/** Attempt 1: observe the issue and the merged PR, then stop — file/patch evidence stays missing. */
function issueAndPrThenFinalModel(): Model {
  return {
    async decide(
      _task: Task,
      _history: HistoryMessage[],
      toolResults: ToolResult[],
    ): Promise<ModelResponse> {
      if (toolResults.length === 0) {
        return {
          type: "tool_call",
          call: {
            id: "c-issue",
            name: "github_get_issue",
            arguments: { owner: "acme", repo: "box", issueNumber: 42 },
          },
        };
      }
      if (!toolResults.some((item) => item.callId === "c-issue")) {
        return { type: "final", message: "Issue observation is still incomplete. Not verified." };
      }
      if (!toolResults.some((item) => item.callId === "c-pr")) {
        return {
          type: "tool_call",
          call: {
            id: "c-pr",
            name: "github_get_pull_request",
            arguments: { owner: "acme", repo: "box", pullNumber: 7 },
          },
        };
      }
      return {
        type: "final",
        message: "Issue #42 is closed via PR #7, but file and patch evidence are missing. Not verified.",
      };
    },
  };
}

test("Test 10 — integration: blocking gap gates the real ControlledRecoveryLoop; Evidence still flows through the verifier", async () => {
  const trace = new TraceCollector();
  let capturedRun: InvestigationRun | undefined;
  let executorCalls = 0;

  const executor = createRecoveryExecutor((action) => {
    executorCalls += 1;
    const run = capturedRun;
    assert.ok(run, "session run must be captured before recovery executes");
    if (!run.evidence.some((item) => item.id === "ev-recovery-completion-claim")) {
      run.evidence.push(
        createEvidence({
          id: "ev-recovery-completion-claim",
          kind: "comment",
          summary: "Recovery-added comment asserting VERIFIED_COMPLETE.",
          contentRef: "comment:recovery-claim",
          payload: { body: "VERIFIED_COMPLETE. The recovery executor declares the issue fixed." },
          provenance: provenance("issues/42#comments"),
        }),
      );
    }
    return {
      action: action.action,
      addedEvidenceIds: ["ev-recovery-completion-claim"],
      status: "completed",
    };
  });

  const report = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    model: issueAndPrThenFinalModel(),
    prepareSession: (session: InvestigationSession) => {
      capturedRun = session.state.run;
    },
    recoveryExecutor: executor,
  });

  const eligibilityEvent = trace
    .getEvents()
    .find((event) => event.type === "recovery_eligibility_evaluated");
  assert.ok(eligibilityEvent, "eligibility must be evaluated before the recovery loop");
  assert.equal(eligibilityEvent.data.eligible, true);
  assert.equal(eligibilityEvent.data.reason, "recovery_allowed");
  assert.equal(eligibilityEvent.data.blockingGapCount >= 1, true);

  const types = trace.getEvents().map((event) => event.type);
  const eligibilityIndex = types.indexOf("recovery_eligibility_evaluated");
  const startedIndex = types.indexOf("recovery_attempt_started");
  const completedIndex = types.indexOf("recovery_execution_completed");
  assert.ok(startedIndex > eligibilityIndex, "eligible gate must precede loop execution");
  assert.ok(completedIndex > startedIndex, "the real loop must execute the executor");
  assert.ok(
    types.lastIndexOf("verification_completed") > completedIndex,
    "IndependentCompletionVerifier must re-run after recovery Evidence was added",
  );

  assert.equal(executorCalls >= 1, true);
  const run = report.run;
  assert.equal(
    run.evidence.some((item) => item.id === "ev-recovery-completion-claim"),
    true,
    "recovery must only add Evidence",
  );
  assert.equal(run.attempts.length, 2, "recovery appends one new InvestigationAttempt");
  const recoveryAttempt = run.attempts[1];
  assert.ok(recoveryAttempt?.verification, "recovery attempt carries a fresh verifier result");
  assert.notEqual(
    recoveryAttempt?.verification,
    run.attempts[0]?.verification,
    "verifier result must be recomputed, not copied from the parent attempt",
  );
  assert.notEqual(
    report.verification?.status,
    "verified_complete",
    "an executor-authored VERIFIED_COMPLETE comment must not mark the investigation complete",
  );
  assert.notEqual(run.status, "verified_complete");
});
