import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import {
  executeDatasetCase,
  loadDataset,
  realDatasetManifestPath,
  withGithubNetworkBlocked,
} from "../src/benchmark/index.js";
import type { Task, ToolResult } from "../src/core/types.js";
import {
  RECOVERY_BOUNDS,
  bindClaimEvidence,
  createClaim,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
  type RecoveryBounds,
  type VerificationResult,
} from "../src/domain/index.js";
import { GitHubProviderError } from "../src/github/errors.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  FailureAnalyzer,
  ILLEGAL_INVESTIGATION_ACTION,
  IndependentCompletionVerifier,
  RecoveryPlanner,
  SnapshotInvestigationDriver,
  applyRecoveryPlan,
  investigate,
  investigationFingerprint,
  planInvestigationStrategy,
  type AnalysisContext,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const now = "2026-09-17T00:00:00.000Z";
const analyzer = new FailureAnalyzer();
const planner = new RecoveryPlanner();
const bounds: RecoveryBounds = { ...RECOVERY_BOUNDS };

function targetTask(issueNumber = 42) {
  return createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber },
  });
}

function issueEvidence(issueNumber: number, repository = "acme/box") {
  return createEvidence({
    kind: "issue",
    summary: `Issue #${issueNumber}`,
    payload: { number: issueNumber, repository, state: "closed", title: "x" },
    provenance: {
      source: "github",
      operation: "getIssue",
      resource: `issues/${issueNumber}`,
      repository,
      retrievedAt: now,
      trust: "external_untrusted",
    },
  });
}

function verification(status: VerificationResult["status"], checks: VerificationResult["checks"] = []): VerificationResult {
  return {
    status,
    checks,
    evidenceCoverage: 0,
    unsupportedClaimIds: [],
    missingRequirementIds: status === "insufficient_evidence" ? ["req-pr"] : [],
    prematureCompletion: false,
  };
}

function makeCtx(input: {
  issueNumber?: number;
  evidence?: ReturnType<typeof createEvidence>[];
  verification?: VerificationResult;
  attempt?: number;
  previousFingerprints?: string[];
  toolHistory?: InvestigationState["toolHistory"];
  claims?: ReturnType<typeof createClaim>[];
  agentOutput?: string;
  agentStatus?: "completed" | "failed";
}): AnalysisContext {
  const task = targetTask(input.issueNumber ?? 42);
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  for (const item of input.evidence ?? []) {
    state.addEvidence(item);
    if (item.kind === "issue" && item.payload && typeof item.payload === "object" && "number" in item.payload) {
      state.investigatedResources.add(resourceKey("issue", String((item.payload as { number: number }).number)));
    }
  }
  for (const claim of input.claims ?? []) {
    state.addClaim(claim);
  }
  if (input.toolHistory) {
    for (const entry of input.toolHistory) {
      state.recordTool(entry);
    }
  }
  return {
    task,
    state,
    verification: input.verification ?? verification("insufficient_evidence"),
    agentResult: {
      status: input.agentStatus ?? "completed",
      output: input.agentOutput ?? "Need more evidence; not verified.",
      steps: 2,
    },
    attempt: input.attempt ?? 1,
    previousFingerprints: input.previousFingerprints ?? [],
    previousRecoveries: [],
    bounds,
  };
}

test("Phase 5：timeout → TOOL_FAILURE → retry_with_backoff", () => {
  const ctx = makeCtx({
    toolHistory: [
      {
        tool: "github_get_issue",
        arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        success: false,
        evidenceIds: [],
        error: "getIssue timed out after 15000ms",
        errorCode: "timeout",
        httpStatus: undefined,
        retryable: true,
      },
    ],
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "tool_failure");
  assert.equal(failure?.errorCode, "timeout");
  assert.equal(failure?.retryable, true);
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "retry_with_backoff");
  assert.ok((plan.maxRetries ?? 0) > 0);
  assert.notEqual(plan.action, "stop");
});

test("Phase 5：401/404 → TOOL_FAILURE → no blind retry", () => {
  for (const [errorCode, httpStatus] of [
    ["unauthorized", 401],
    ["not_found", 404],
  ] as const) {
    const ctx = makeCtx({
      toolHistory: [
        {
          tool: "github_get_issue",
          arguments: { owner: "acme", repo: "box", issueNumber: 42 },
          success: false,
          evidenceIds: [],
          error: `${errorCode}`,
          errorCode,
          httpStatus,
          retryable: false,
        },
      ],
    });
    const failure = analyzer.classify(ctx);
    assert.equal(failure?.type, "tool_failure", errorCode);
    const plan = planner.plan(failure!, ctx);
    assert.equal(plan.action, "stop", errorCode);
    assert.match(plan.reason, /no blind retry/i);
  }
});

test("Phase 5：no useful retrieval → RETRIEVAL_FAILURE → change strategy", () => {
  const issue = issueEvidence(42);
  const ctx = makeCtx({
    evidence: [issue],
    toolHistory: [
      {
        tool: "github_get_issue",
        arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        success: true,
        evidenceIds: [issue.id],
      },
    ],
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "retrieval_failure");
  const plan = planner.plan(failure!, ctx);
  assert.ok(
    plan.action === "change_retrieval_strategy" ||
      plan.action === "refine_query" ||
      plan.action === "gather_missing_evidence",
  );
  assert.notEqual(plan.action, "retry_with_backoff");
  assert.ok(plan.retrievalStrategy || plan.nextStep);
});

test("Phase 5：Agent says resolved, verifier insufficient → PREMATURE_COMPLETION → gather/continue", () => {
  const issue = issueEvidence(42);
  const claim = createClaim({
    text: "Issue #42 is resolved.",
    polarity: "resolved",
    critical: true,
  });
  const ctx = makeCtx({
    evidence: [issue],
    claims: [claim],
    agentOutput: "Done. Issue is resolved.",
    verification: {
      ...verification("insufficient_evidence", [
        {
          id: "resolution-candidate",
          name: "resolution candidate",
          type: "pr_existence",
          status: "unknown",
          severity: "required",
          message: "No pull request evidence linked to the target issue.",
          evidenceIds: [],
        },
      ]),
      prematureCompletion: true,
      missingRequirementIds: ["req-pr"],
    },
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "premature_completion");
  assert.ok(failure?.missingRequirementIds?.includes("req-pr"));
  const plan = planner.plan(failure!, ctx);
  assert.ok(plan.action === "continue_investigation" || plan.action === "gather_missing_evidence");
  assert.match(plan.nextStep ?? "", /missing/i);
  assert.notEqual(plan.action, "retry_with_backoff");
});

test("Phase 5：same state repeated → LOOP_FAILURE → replan then stop", () => {
  const issue = issueEvidence(42);
  const first = makeCtx({ evidence: [issue], attempt: 1 });
  const fingerprint = investigationFingerprint(first.state);
  const second = makeCtx({
    evidence: [issue],
    attempt: 2,
    previousFingerprints: [fingerprint],
  });
  second.state.fingerprints.push(fingerprint);
  const failure = analyzer.classify(second);
  assert.equal(failure?.type, "loop_failure");
  assert.equal(failure?.details?.detector, "same_state");
  const replan = planner.plan(failure!, second);
  assert.equal(replan.action, "replan");
  const afterReplan: AnalysisContext = {
    ...second,
    attempt: 3,
    previousRecoveries: [replan],
  };
  const stop = planner.plan(failure!, afterReplan);
  assert.equal(stop.action, "stop");
});

test("Phase 5：required evidence missing → INSUFFICIENT_EVIDENCE → gather or stop", () => {
  const issue = issueEvidence(42);
  const gatherCtx = makeCtx({
    evidence: [issue],
    toolHistory: [
      {
        tool: "github_get_issue",
        arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        success: true,
        evidenceIds: [issue.id],
      },
    ],
  });
  gatherCtx.state.investigatedResources.add(resourceKey("timeline", "42"));
  gatherCtx.state.investigatedResources.add(resourceKey("comments", "42"));
  gatherCtx.state.investigatedResources.add(resourceKey("commits", "repo"));
  const failure = analyzer.classify(gatherCtx);
  assert.ok(failure?.type === "insufficient_evidence" || failure?.type === "retrieval_failure");
  const withSources = planner.plan(
    { type: "insufficient_evidence", reason: "missing", evidenceIds: [issue.id], confidence: 1, missingRequirementIds: ["req-pr"] },
    gatherCtx,
  );
  assert.equal(withSources.action, "stop");

  const openCtx = makeCtx({ evidence: [issue] });
  const gather = planner.plan(
    { type: "insufficient_evidence", reason: "missing", evidenceIds: [issue.id], confidence: 1, missingRequirementIds: ["req-pr"] },
    openCtx,
  );
  assert.equal(gather.action, "gather_missing_evidence");
});

test("Phase 5：invalid evidence is revalidated and never trusted", () => {
  const malformed = createEvidence({
    kind: "issue",
    summary: "broken issue",
    payload: { title: "no number" },
    provenance: {
      source: "github",
      repository: "acme/box",
      retrievedAt: now,
      trust: "harness_derived",
    },
  });
  const ctx = makeCtx({
    evidence: [malformed],
    verification: verification("not_verified", [
      {
        id: "issue-identity",
        name: "issue identity",
        type: "identity",
        status: "unknown",
        severity: "critical",
        message: "No issue evidence; cannot confirm owner/repository/number.",
        evidenceIds: [],
      },
    ]),
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "invalid_evidence");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "revalidate_evidence");
  applyRecoveryPlan(ctx.state, plan, failure!);
  assert.equal(ctx.state.run.evidence.some((item) => item.id === malformed.id), false);
  assert.equal(ctx.state.invalidEvidenceIds.has(malformed.id), true);
  assert.equal(
    ctx.state.run.evidence.every((item) => item.provenance.trust !== "harness_derived"),
    true,
  );
});

test("Phase 5：wrong target acme/box#99 vs #42 → WRONG_TARGET → recheck_target", () => {
  const observed = issueEvidence(99);
  const ctx = makeCtx({
    issueNumber: 42,
    evidence: [observed],
    verification: verification("not_verified", [
      {
        id: "issue-identity",
        name: "issue identity",
        type: "identity",
        status: "fail",
        severity: "critical",
        message: "Evidence points at acme/box#99, not acme/box#42.",
        evidenceIds: [observed.id],
        expected: { repository: "acme/box", issueNumber: 42 },
        actual: { repository: "acme/box", issueNumber: 99 },
      },
    ]),
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "wrong_target");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "recheck_target");
  assert.equal(plan.resetEvidence, true);
  applyRecoveryPlan(ctx.state, plan, failure!);
  assert.equal(ctx.state.run.evidence.length, 0);
});

test("Phase 5：recovery cannot mint completion; only verifier can", () => {
  const issue = issueEvidence(42);
  const ctx = makeCtx({ evidence: [issue] });
  const failure = analyzer.classify(ctx);
  assert.ok(failure);
  const plan = planner.plan(failure!, ctx);
  applyRecoveryPlan(ctx.state, plan, failure!);
  assert.notEqual(ctx.state.run.status, "verified_complete");
  assert.equal(ctx.state.run.status, "in_progress");
});

test("Phase 5：tool retry budget is bounded", () => {
  const ctx = makeCtx({
    attempt: 1,
    toolHistory: [
      {
        tool: "github_get_issue",
        arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        success: false,
        evidenceIds: [],
        errorCode: "timeout",
        retryable: true,
        error: "timeout",
      },
    ],
  });
  ctx.state.toolRetryCount = bounds.maxToolRetries;
  const failure = analyzer.classify(ctx)!;
  assert.equal(failure.type, "tool_failure");
  assert.equal(planner.plan(failure, ctx).action, "stop");
});

test("Phase 5：end-to-end premature completion recovers then re-verifies complete", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    trace,
    maxAttempts: 3,
    modelFactory: (session: InvestigationSession): Model => {
      const driver = new SnapshotInvestigationDriver(session.state);
      return {
        async decide(
          task: Task,
          history: HistoryMessage[],
          toolResults: ToolResult[],
          context,
        ): Promise<ModelResponse> {
          const attempt = context?.attempt ?? 1;
          if (attempt === 1) {
            const issueKey = resourceKey("issue", String(session.state.task.target.issueNumber));
            if (!session.state.investigatedResources.has(issueKey)) {
              session.state.pendingReason = "Observe the issue first.";
              return {
                type: "tool_call",
                call: {
                  id: "p1",
                  name: "github_get_issue",
                  arguments: { owner: "acme", repo: "box", issueNumber: 42 },
                },
              };
            }
            if (!session.state.claimsRecorded) {
              session.state.pendingReason = "Claim resolved without PR evidence.";
              return {
                type: "tool_call",
                call: {
                  id: "p2",
                  name: "record_claim",
                  arguments: {
                    claims: [
                      {
                        text: "Issue #42 is resolved.",
                        polarity: "resolved",
                        critical: true,
                        evidenceIds: session.state.run.evidence.map((item) => item.id),
                        role: "supports",
                      },
                    ],
                    conclusion: "Resolved.",
                    polarity: "resolved",
                  },
                },
              };
            }
            return { type: "final", message: "Done. Issue is resolved." };
          }
          return driver.decide(task, history, toolResults, context);
        },
      };
    },
  });

  assert.ok(result.run.attempts.length >= 2);
  const first = result.run.attempts[0];
  assert.equal(first?.failure?.type, "premature_completion");
  assert.ok(
    first?.recovery?.action === "continue_investigation" ||
      first?.recovery?.action === "gather_missing_evidence",
  );
  assert.equal(first?.verification?.status, "insufficient_evidence");
  assert.equal(result.verification?.status, "verified_complete");
  assert.equal(result.run.status, "verified_complete");
  assert.notEqual(result.status, "verified_complete");
  assert.equal(result.run.attempts[0]?.verification?.status, "insufficient_evidence");
  assert.equal(result.run.attempts.at(-1)?.verification?.status, "verified_complete");
  assert.equal(result.run.attempts[0]?.attempt, 1);
  assert.equal(result.run.attempts[1]?.attempt, 2);

  const types = new Set(trace.getEvents().map((event) => event.type));
  for (const required of [
    "failure_detected",
    "failure_analyzed",
    "recovery_planned",
    "recovery_started",
    "recovery_completed",
    "verification_completed",
  ]) {
    assert.equal(types.has(required as never), true, `missing trace ${required}`);
  }
  const analyzed = trace.getEvents().find((event) => event.type === "failure_analyzed");
  assert.equal(analyzed?.data.primary, "premature_completion");
  const planned = trace.getEvents().find((event) => event.type === "recovery_planned");
  assert.ok(
    planned?.data.action === "continue_investigation" ||
      planned?.data.action === "gather_missing_evidence",
  );
});

test("Phase 8.8.4 Test 6 — RecoveryPlan nextRequirementIds become the next attempt target", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    trace,
    maxAttempts: 3,
    modelFactory: (session: InvestigationSession): Model => {
      const driver = new SnapshotInvestigationDriver(session.state);
      return {
        async decide(task, history, toolResults, context): Promise<ModelResponse> {
          const attempt = context?.attempt ?? 1;
          if (attempt === 1) {
            const issueKey = resourceKey("issue", String(session.state.task.target.issueNumber));
            if (!session.state.investigatedResources.has(issueKey)) {
              return {
                type: "tool_call",
                call: {
                  id: "p1",
                  name: "github_get_issue",
                  arguments: { owner: "acme", repo: "box", issueNumber: 42 },
                },
              };
            }
            if (!session.state.claimsRecorded) {
              return {
                type: "tool_call",
                call: {
                  id: "p2",
                  name: "record_claim",
                  arguments: {
                    claims: [
                      {
                        text: "Issue #42 is resolved.",
                        polarity: "resolved",
                        critical: true,
                        evidenceIds: session.state.run.evidence.map((item) => item.id),
                        role: "supports",
                      },
                    ],
                    conclusion: "Resolved.",
                    polarity: "resolved",
                  },
                },
              };
            }
            return { type: "final", message: "Done. Issue is resolved." };
          }
          const legal = context?.legalInvestigationActions ?? [];
          assert.equal(
            legal.some((item) => item.tool === "github_get_issue"),
            false,
            "recovery attempt must not re-open issue observation",
          );
          return driver.decide(task, history, toolResults, context);
        },
      };
    },
  });

  assert.ok(result.run.attempts.length >= 2);
  const first = result.run.attempts[0];
  const second = result.run.attempts[1];
  assert.ok(first && second);
  assert.ok(first.failure?.id);
  assert.ok(first.recovery?.id);
  assert.equal(first.recovery?.failureEventId, first.failure?.id);
  assert.ok((first.recovery?.nextRequirementIds ?? []).length > 0);
  assert.equal(second.parentAttemptId, first.id);
  assert.equal(second.recoveryPlanId, first.recovery?.id);
  assert.equal(second.failureEventId, first.failure?.id);

  const applied = trace.getEvents().find((event) => event.type === "recovery_applied");
  const nextStrategy = applied?.data.nextStrategy as { scope?: string[] } | undefined;
  assert.deepEqual(nextStrategy?.scope, first.recovery?.nextRequirementIds);

  const recovered = makeCtx({ evidence: [issueEvidence(42)] });
  recovered.state.lastRecovery = first.recovery;
  recovered.state.investigationStrategy = second.strategy;
  recovered.state.investigatedResources.add(resourceKey("issue", "42"));
  recovered.state.issueState = "closed";
  const targeted = planInvestigationStrategy(recovered.state);
  assert.equal(targeted.legalActions.some((item) => item.tool === "github_get_issue"), false);
  assert.ok(targeted.legalActions.some((item) => item.tool.startsWith("github_")));
});

test("Phase 5：timeout then success uses a new append-only attempt", async () => {
  const inner = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  let issueCalls = 0;
  const provider = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "getIssue") {
        return async (ref: { owner: string; repo: string; issueNumber: number }) => {
          issueCalls += 1;
          if (issueCalls === 1) {
            throw new GitHubProviderError({
              code: "timeout",
              operation: "getIssue",
              message: "getIssue timed out after 15000ms",
            });
          }
          return target.getIssue(ref);
        };
      }
      return value;
    },
  });

  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    maxAttempts: 3,
    model: {
      async decide(
        _task: Task,
        _history: HistoryMessage[],
        toolResults: ToolResult[],
      ): Promise<ModelResponse> {
        if (toolResults.some((item) => item.success === false)) {
          return { type: "final", message: "Tool failed; stopping this attempt." };
        }
        if (toolResults.length === 0) {
          return {
            type: "tool_call",
            call: {
              id: "t1",
              name: "github_get_issue",
              arguments: { owner: "acme", repo: "box", issueNumber: 42 },
            },
          };
        }
        return { type: "final", message: "Observed the issue. Not verified." };
      },
    },
  });

  assert.equal(result.run.attempts[0]?.failure?.type, "tool_failure");
  assert.equal(result.run.attempts[0]?.recovery?.action, "retry_with_backoff");
  assert.ok(result.run.attempts.length >= 2);
  assert.equal(result.run.attempts[0]?.attempt, 1);
  assert.equal(result.run.attempts[1]?.attempt, 2);
  assert.ok(issueCalls >= 2);
});

test("Phase 5：401 does not retry the tool", async () => {
  const inner = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  let issueCalls = 0;
  const provider = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "getIssue") {
        return async () => {
          issueCalls += 1;
          throw new GitHubProviderError({
            code: "unauthorized",
            operation: "getIssue",
            status: 401,
            message: "unauthorized",
            retryable: false,
          });
        };
      }
      return value;
    },
  });
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    maxAttempts: 3,
    model: {
      async decide(
        _task: Task,
        _history: HistoryMessage[],
        toolResults: ToolResult[],
      ): Promise<ModelResponse> {
        if (toolResults.length === 0) {
          return {
            type: "tool_call",
            call: {
              id: "u1",
              name: "github_get_issue",
              arguments: { owner: "acme", repo: "box", issueNumber: 42 },
            },
          };
        }
        return { type: "final", message: "Unauthorized. Not verified." };
      },
    },
  });
  assert.equal(result.run.attempts[0]?.failure?.type, "tool_failure");
  assert.equal(result.run.attempts[0]?.recovery?.action, "stop");
  assert.equal(result.run.attempts.length, 1);
  assert.equal(issueCalls, 1);
});

test("Phase 5：looping model stops instead of running forever", async () => {
  const provider = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    maxAttempts: 3,
    maxRecoveryAttempts: 3,
    model: {
      async decide(
        _task: Task,
        _history: HistoryMessage[],
        toolResults: ToolResult[],
      ): Promise<ModelResponse> {
        if (toolResults.length === 0) {
          return {
            type: "tool_call",
            call: {
              id: "loop",
              name: "github_get_issue",
              arguments: { owner: "acme", repo: "box", issueNumber: 42 },
            },
          };
        }
        return { type: "final", message: "Still looking. Not verified." };
      },
    },
  });
  assert.ok(result.run.attempts.length <= 3);
  assert.ok(result.run.attempts.some((item) => item.failure?.type === "loop_failure" || item.recovery?.action === "stop"));
  assert.notEqual(result.verification?.status, "verified_complete");
});

test("Phase 5：contradictory claim evidence is invalid, not trusted", () => {
  const issue = issueEvidence(42);
  const claim = createClaim({ text: "resolved", polarity: "resolved", critical: true });
  const ctx = makeCtx({
    evidence: [issue],
    claims: [claim],
    verification: verification("not_verified", [
      {
        id: "claims-supported",
        name: "claims supported",
        type: "claim_coverage",
        status: "fail",
        severity: "required",
        message: "Critical claim is contradicted by evidence.",
        evidenceIds: [issue.id],
      },
    ]),
  });
  ctx.state.bind(bindClaimEvidence({ claimId: claim.id, evidenceId: issue.id, role: "contradicts" }));
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "invalid_evidence");
  assert.equal(planner.plan(failure!, ctx).action, "revalidate_evidence");
});

function loopCtx(input: {
  evidence?: ReturnType<typeof createEvidence>[];
  verification?: VerificationResult;
  missingRequirementIds?: string[];
}): AnalysisContext {
  const evidence = input.evidence ?? [issueEvidence(42)];
  const first = makeCtx({ evidence });
  const fingerprint = investigationFingerprint(first.state);
  const second = makeCtx({
    evidence,
    attempt: 2,
    previousFingerprints: [fingerprint],
    verification:
      input.verification ??
      (input.missingRequirementIds
        ? {
            ...verification("insufficient_evidence"),
            missingRequirementIds: input.missingRequirementIds,
          }
        : verification("insufficient_evidence")),
  });
  second.state.fingerprints.push(fingerprint);
  return second;
}

function linkedPullRequest(issueId: string, trust: "external_untrusted" | "harness_derived" = "external_untrusted") {
  const pr = createEvidence({
    kind: "pull_request",
    summary: "PR #7 merged=true",
    payload: {
      number: 7,
      repository: "acme/box",
      merged: true,
      state: "closed",
      title: "Fix empty cart",
      body: "Fixes #42",
    },
    provenance: {
      source: "github",
      operation: "getPullRequest",
      resource: "pull/7",
      repository: "acme/box",
      retrievedAt: now,
      trust,
    },
    contentRef: resourceKey("pr", "7"),
  });
  const relation = createRelation({ fromEvidenceId: pr.id, toEvidenceId: issueId, type: "fixes" });
  return { pr, relation };
}

test("Phase 8.8.5 Test 1 — premature_completion preserves verifier missing requirements", () => {
  const issue = issueEvidence(42);
  const ctx = makeCtx({
    evidence: [issue],
    claims: [createClaim({ text: "Issue #42 is resolved.", polarity: "resolved", critical: true })],
    agentOutput: "Done. Issue is resolved.",
    verification: {
      ...verification("insufficient_evidence"),
      prematureCompletion: true,
      missingRequirementIds: ["req-pr", "req-commit"],
    },
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "premature_completion");
  assert.deepEqual(failure?.missingRequirementIds, ["req-pr", "req-commit"]);
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "continue_investigation");
  assert.deepEqual(plan.nextRequirementIds, ["req-pr", "req-commit"]);
});

test("Phase 8.8.5 Test 2 — insufficient_evidence preserves verifier missing requirements", () => {
  const issue = issueEvidence(42);
  const ctx = makeCtx({ evidence: [issue] });
  const gather = planner.plan(
    {
      type: "insufficient_evidence",
      reason: "missing",
      evidenceIds: [issue.id],
      confidence: 1,
      missingRequirementIds: ["req-pr", "req-commit"],
    },
    ctx,
  );
  assert.equal(gather.action, "gather_missing_evidence");
  assert.deepEqual(gather.nextRequirementIds, ["req-pr", "req-commit"]);
});

test("Phase 8.8.5 Test 3 — loop_failure derives target from current missing requirements when available", () => {
  const ctx = loopCtx({ missingRequirementIds: ["req-pr"] });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "loop_failure");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "replan");
  assert.deepEqual(plan.nextRequirementIds, ["req-pr"]);
  assert.match(plan.nextStep ?? "", /req-pr/);
  assert.equal(plan.nextStep?.includes("github_"), false);
});

test("Phase 8.8.5 Test 4 — loop_failure does not invent a requirement when none is available", () => {
  const issue = issueEvidence(42);
  const { pr, relation } = linkedPullRequest(issue.id);
  const commit = createEvidence({
    kind: "commit",
    summary: "Commit abc123",
    payload: { sha: "abc123def456", repository: "acme/box", message: "Fix\n\nFixes #42" },
    provenance: {
      source: "github",
      operation: "listCommits",
      resource: "commit/abc123",
      repository: "acme/box",
      retrievedAt: now,
      trust: "external_untrusted",
    },
    contentRef: resourceKey("commit", "abc123def456"),
  });
  const first = makeCtx({
    evidence: [issue, pr, commit],
    verification: { ...verification("not_verified"), missingRequirementIds: [] },
  });
  first.state.addRelation(relation);
  first.state.addRelation(createRelation({ fromEvidenceId: commit.id, toEvidenceId: pr.id, type: "derived_from" }));
  first.state.addCandidatePr(7);
  first.state.mergedPrs.add(7);
  const fingerprint = investigationFingerprint(first.state);
  const ctx = makeCtx({
    evidence: [issue, pr, commit],
    attempt: 2,
    previousFingerprints: [fingerprint],
    verification: { ...verification("not_verified"), missingRequirementIds: [] },
  });
  ctx.state.addRelation(relation);
  ctx.state.addRelation(createRelation({ fromEvidenceId: commit.id, toEvidenceId: pr.id, type: "derived_from" }));
  ctx.state.addCandidatePr(7);
  ctx.state.mergedPrs.add(7);
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "loop_failure");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "replan");
  assert.equal((plan.nextRequirementIds ?? []).length, 0);
  assert.equal((plan.nextRequirementIds ?? []).includes(issue.id), false);
  assert.equal((plan.nextRequirementIds ?? []).includes(pr.id), false);
  assert.equal(
    (plan.nextRequirementIds ?? []).some(
      (id) => id.startsWith("req-") && !ctx.task.requirements.some((item) => item.id === id),
    ),
    false,
  );
});

test("Phase 8.8.5 Test 5 — invalid_evidence targets the affected requirement when deterministically known", () => {
  const issue = issueEvidence(42);
  const { pr, relation } = linkedPullRequest(issue.id, "harness_derived");
  const ctx = makeCtx({
    evidence: [issue, pr],
    verification: verification("not_verified", [
      {
        id: "issue-identity",
        name: "issue identity",
        type: "identity",
        status: "pass",
        severity: "critical",
        message: "Target issue identity matches.",
        evidenceIds: [issue.id],
      },
    ]),
  });
  ctx.state.addRelation(relation);
  ctx.state.addCandidatePr(7);
  ctx.state.mergedPrs.add(7);
  const reqPr = ctx.task.requirements.find((item) => item.id === "req-pr");
  assert.ok(reqPr);
  reqPr.satisfiedBy = [pr.id];
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "invalid_evidence");
  assert.ok(failure?.evidenceIds.includes(pr.id));
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "revalidate_evidence");
  assert.ok((plan.nextRequirementIds ?? []).includes("req-pr"));
  assert.equal((plan.nextRequirementIds ?? []).includes(pr.id), false);
});

test("Phase 8.8.5 Test 6 — invalid_evidence does not fabricate requirement IDs", () => {
  const malformed = createEvidence({
    id: "ev-malformed",
    kind: "issue",
    summary: "broken issue",
    payload: { title: "no number" },
    provenance: {
      source: "github",
      repository: "acme/box",
      retrievedAt: now,
      trust: "harness_derived",
    },
  });
  const ctx = makeCtx({
    evidence: [malformed],
    verification: verification("not_verified", [
      {
        id: "issue-identity",
        name: "issue identity",
        type: "identity",
        status: "unknown",
        severity: "critical",
        message: "No issue evidence; cannot confirm owner/repository/number.",
        evidenceIds: [],
      },
    ]),
  });
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "invalid_evidence");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "revalidate_evidence");
  const ids = plan.nextRequirementIds ?? [];
  assert.equal(ids.includes("ev-malformed"), false);
  assert.equal(ids.includes(malformed.id), false);
  assert.equal(
    ids.some((id) => !ctx.task.requirements.some((item) => item.id === id)),
    false,
  );
});

test("Phase 8.8.5 Test 7 — tool_failure preserves current bounded retry behavior", () => {
  const retryCtx = makeCtx({
    verification: { ...verification("not_verified"), missingRequirementIds: [] },
    toolHistory: [
      {
        tool: "github_get_issue",
        arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        success: false,
        evidenceIds: [],
        error: "timeout",
        errorCode: "timeout",
        retryable: true,
      },
    ],
  });
  const retryFailure = analyzer.classify(retryCtx);
  assert.equal(retryFailure?.type, "tool_failure");
  const retryPlan = planner.plan(retryFailure!, retryCtx);
  assert.equal(retryPlan.action, "retry_with_backoff");
  assert.ok((retryPlan.maxRetries ?? 0) > 0);
  assert.equal((retryPlan.nextRequirementIds ?? []).length, 0);

  const exhausted = makeCtx({
    verification: { ...verification("not_verified"), missingRequirementIds: [] },
    toolHistory: retryCtx.state.toolHistory,
  });
  exhausted.state.toolRetryCount = bounds.maxToolRetries;
  const stopPlan = planner.plan(analyzer.classify(exhausted)!, exhausted);
  assert.equal(stopPlan.action, "stop");

  const withMissing = makeCtx({
    toolHistory: retryCtx.state.toolHistory,
    verification: {
      ...verification("insufficient_evidence"),
      missingRequirementIds: ["req-pr"],
    },
  });
  const propagated = planner.plan(analyzer.classify(withMissing)!, withMissing);
  assert.equal(propagated.action, "retry_with_backoff");
  assert.deepEqual(propagated.nextRequirementIds, ["req-pr"]);
});

test("Phase 8.8.5 Test 8 — wrong_target does not inherit requirements from wrong-target evidence", () => {
  const observed = issueEvidence(99);
  const { pr, relation } = linkedPullRequest(observed.id);
  const ctx = makeCtx({
    issueNumber: 42,
    evidence: [observed, pr],
    verification: {
      ...verification("not_verified", [
        {
          id: "issue-identity",
          name: "issue identity",
          type: "identity",
          status: "fail",
          severity: "critical",
          message: "Evidence points at acme/box#99, not acme/box#42.",
          evidenceIds: [observed.id],
          expected: { repository: "acme/box", issueNumber: 42 },
          actual: { repository: "acme/box", issueNumber: 99 },
        },
      ]),
      missingRequirementIds: ["req-pr", "req-commit"],
    },
  });
  ctx.state.addRelation(relation);
  ctx.state.addCandidatePr(7);
  const reqPr = ctx.task.requirements.find((item) => item.id === "req-pr");
  if (reqPr) {
    reqPr.satisfiedBy = [pr.id];
  }
  const failure = analyzer.classify(ctx);
  assert.equal(failure?.type, "wrong_target");
  const plan = planner.plan(failure!, ctx);
  assert.equal(plan.action, "recheck_target");
  assert.equal(plan.resetEvidence, true);
  assert.equal(plan.nextRequirementIds, undefined);
  applyRecoveryPlan(ctx.state, plan, failure!);
  assert.equal(ctx.state.run.evidence.length, 0);
  assert.equal(ctx.state.lastRecovery?.nextRequirementIds, undefined);
});

test("Phase 8.8.5 Test 9 — RecoveryPlan next attempt still produces legal actions for the target", () => {
  const ctx = loopCtx({ missingRequirementIds: ["req-pr"] });
  ctx.state.investigatedResources.add(resourceKey("issue", "42"));
  ctx.state.issueState = "closed";
  const failure = analyzer.classify(ctx)!;
  const plan = planner.plan(failure, ctx);
  applyRecoveryPlan(ctx.state, plan, failure);
  const planned = planInvestigationStrategy(ctx.state);
  assert.ok((plan.nextRequirementIds ?? []).includes("req-pr"));
  assert.ok(planned.legalActions.length > 0);
  assert.ok(planned.legalActions.some((item) => item.targetRequirementIds.includes("req-pr")));
  assert.ok(planned.legalActions.some((item) => item.tool.startsWith("github_")));
  assert.equal(
    planned.legalActions.some((item) => item.tool === "github_get_issue"),
    false,
  );
});

test("Phase 8.8.5 Test 10 — LLM still cannot execute an action outside legal recovery actions", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    model: {
      async decide(): Promise<ModelResponse> {
        return {
          type: "tool_call",
          call: {
            id: "bypass-recovery-target",
            name: "github_get_issue",
            arguments: { owner: "acme", repo: "box", issueNumber: 42 },
          },
        };
      },
    },
    maxAttempts: 1,
    prepareSession: (session) => {
      const issue = issueEvidence(42);
      session.state.addEvidence(issue);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      const analysis: AnalysisContext = {
        task: session.state.task,
        state: session.state,
        verification: {
          ...verification("insufficient_evidence"),
          missingRequirementIds: ["req-pr"],
        },
        attempt: 2,
        previousFingerprints: ["prior"],
        previousRecoveries: [],
        bounds,
      };
      const failure = {
        type: "loop_failure" as const,
        reason: "same state",
        evidenceIds: [issue.id],
        missingRequirementIds: ["req-pr"],
        confidence: 1,
      };
      applyRecoveryPlan(session.state, planner.plan(failure, analysis), failure);
    },
  });
  assert.equal(
    result.investigationSteps.some((step) => step.tool === "github_get_issue"),
    false,
  );
  assert.equal(result.agentResult?.decision, "illegal_investigation_action");
  assert.equal(result.agentResult?.output, ILLEGAL_INVESTIGATION_ACTION);
});

test("Phase 8.8.5 Test 11 — IndependentCompletionVerifier remains independent and unchanged", async () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/verification/independent-completion-verifier.ts"),
    "utf8",
  );
  assert.equal(/from ["'].*(react|hono|openai|github\/http|github\/live)["']/.test(source), false);
  assert.equal(source.includes("api.github.com"), false);
  assert.equal(source.includes("nextRequirementIds"), false);

  const plannerSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/investigation/recovery-planner.ts"),
    "utf8",
  );
  assert.equal(plannerSource.includes("openai-compat-model"), false);
  assert.equal(plannerSource.includes("../github/"), false);
  assert.match(plannerSource, /Does not call GitHub, LLM/);

  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    model: {
      async decide(): Promise<ModelResponse> {
        return { type: "final", message: "Need more evidence; not verified." };
      },
    },
    maxAttempts: 1,
    prepareSession: (session) => {
      const issue = issueEvidence(42);
      session.state.addEvidence(issue);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      const analysis: AnalysisContext = {
        task: session.state.task,
        state: session.state,
        verification: {
          ...verification("insufficient_evidence"),
          missingRequirementIds: ["req-pr"],
        },
        attempt: 2,
        previousFingerprints: [],
        previousRecoveries: [],
        bounds,
      };
      const failure = {
        type: "loop_failure" as const,
        reason: "same state",
        evidenceIds: [issue.id],
        missingRequirementIds: ["req-pr"],
        confidence: 1,
      };
      applyRecoveryPlan(session.state, planner.plan(failure, analysis), failure);
    },
  });
  const independent = new IndependentCompletionVerifier().verify({
    task: result.task,
    run: result.run,
  });
  assert.equal(result.verification?.status, independent.status);
  assert.notEqual(independent.status, "verified_complete");
  assert.notEqual(result.run.status, "verified_complete");
});

test("Phase 8.8.5 — snapshot Fake Model cases C01 C05 C06 C07 C08 C10 keep recovery trajectories", async () => {
  const dataset = loadDataset(realDatasetManifestPath());
  await withGithubNetworkBlocked(async () => {
    for (const caseId of ["C01", "C05", "C06", "C07", "C08", "C10"]) {
      const executed = await executeDatasetCase(dataset, caseId);
      const attempts = executed.report.run.attempts;
      assert.ok(attempts.length >= 1, caseId);
      for (let index = 0; index < attempts.length - 1; index += 1) {
        const current = attempts[index];
        const next = attempts[index + 1];
        assert.ok(current && next, caseId);
        if (!current.failure || !current.recovery || current.recovery.action === "stop") {
          continue;
        }
        assert.equal(next.parentAttemptId, current.id, caseId);
        assert.equal(next.recoveryPlanId, current.recovery.id, caseId);
        assert.equal(next.failureEventId, current.failure.id, caseId);
        const ids = current.recovery.nextRequirementIds ?? [];
        if (ids.length > 0) {
          assert.ok(next.strategy, caseId);
          assert.equal(
            ids.some((id) => (current.failure?.evidenceIds ?? []).includes(id)),
            false,
            caseId,
          );
        }
        if (current.failure.type === "wrong_target") {
          assert.equal((current.recovery.nextRequirementIds ?? []).length, 0, caseId);
        }
      }
    }
  });
});

