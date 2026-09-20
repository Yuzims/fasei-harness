/**
 * Phase 16.3-B — ReAct Finalization Boundary.
 * Deterministic: snapshot providers and scripted models / fetch only.
 *
 * Contracts under test:
 * A: Final originates from the Agent, never fabricated by Runtime.
 * B: The Finalization Boundary is not a completion verdict.
 * C: closure != GAP_OPEN_ACTIONABLE still gives the Agent a Final turn.
 * D: the configured LLM budget cannot be consumed entirely by exploration.
 * E: record_claim is legal in the final window but is not Final.
 * F: Final claims still flow through capture + IndependentCompletionVerifier.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  GAP_CLOSED_REASON,
  IndependentCompletionVerifier,
  investigate,
} from "../src/investigation/index.js";
import type { InvestigationSession } from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import type { Model, ModelResponse } from "../src/agent/model.js";

const LIVE_ENV = {
  AGENT_MODEL: "openai",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODEL: "qwen-plus",
  OPENAI_BASE_URL: "https://example.invalid/v1",
};

const now = "2026-09-21T00:00:00.000Z";

function provenance(resource: string) {
  return {
    source: "github" as const,
    repository: "acme/box",
    resource,
    url: `https://github.com/acme/box/${resource}`,
    retrievedAt: now,
    trust: "external_untrusted" as const,
  };
}

function makeState(issueNumber = 42): InvestigationState {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber },
  });
  return new InvestigationState(task, createInvestigationRun({ task }));
}

function addClosedIssue(
  state: InvestigationState,
  extra?: { stateReason?: string; state?: "open" | "closed" },
) {
  const number = state.task.target.issueNumber;
  const evidence = createEvidence({
    kind: "issue",
    summary: `Issue #${number} is ${extra?.state ?? "closed"}`,
    payload: {
      number,
      repository: "acme/box",
      state: extra?.state ?? "closed",
      stateReason: extra?.stateReason,
      title: "Null pointer when saving empty cart",
      body: "Saving an empty cart throws. Please fix.",
    },
    provenance: provenance(`issues/${number}`),
    contentRef: resourceKey("issue", String(number)),
  });
  state.addEvidence(evidence);
  state.investigatedResources.add(resourceKey("issue", String(number)));
  state.issueState = extra?.state ?? "closed";
  return evidence;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolCallResponse(name: string, args: Record<string, unknown>): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
}

function finalResponse(message: string, claims: unknown[] = []): Response {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({ message, claims }) } }],
  });
}

function boundaryEvent(trace: TraceCollector, trigger?: string) {
  return trace
    .getEvents()
    .find(
      (event) =>
        event.type === "finalization_boundary_reached" &&
        (trigger === undefined || event.data.trigger === trigger),
    );
}

test("Test 1 — normal exploration (tool -> tool -> final) ends in an Agent Final with claims captured", async () => {
  let decides = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    maxAttempts: 1,
    maxSteps: 12,
    modelFactory: (session: InvestigationSession): Model => ({
      async decide(_task, _history, _toolResults, context): Promise<ModelResponse> {
        decides += 1;
        if (decides <= 2) {
          const github = (context?.legalInvestigationActions ?? []).find((item) =>
            item.tool.startsWith("github_"),
          );
          assert.ok(github, "exploration window must keep legal GitHub actions");
          return {
            type: "tool_call",
            call: { id: `explore-${decides}`, name: github.tool, arguments: github.arguments },
          };
        }
        const evidenceId = session.state.run.evidence[0]?.id;
        assert.ok(evidenceId);
        return {
          type: "final",
          message: "FINAL-T1: two observations are enough for my answer. Not verified.",
          claims: [
            {
              text: "The target issue was observed.",
              polarity: "unknown",
              critical: false,
              evidenceIds: [evidenceId],
              role: "contextual",
            },
          ],
        };
      },
    }),
  });

  assert.equal(result.agentResult?.decision, "final");
  assert.equal(result.agentResult?.status, "completed");
  assert.equal(result.agentResult?.output, "FINAL-T1: two observations are enough for my answer. Not verified.");
  assert.ok(
    result.investigationSteps.filter((step) => step.tool.startsWith("github_")).length >= 2,
  );
  assert.equal(result.run.claims.some((claim) => claim.text === "The target issue was observed."), true);
  assert.ok(result.claimEvidence.length >= 1);
});

test("Test 2 — the reserved budget boundary is answered by an Agent Final instead of LLM_CALL_BUDGET_EXCEEDED", async () => {
  const httpCalls: string[] = [];
  const trace = new TraceCollector();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    httpCalls.push(String(input));
    if (httpCalls.length === 1) {
      return toolCallResponse("github_get_issue", { owner: "acme", repo: "box", issueNumber: 7 });
    }
    return finalResponse("FINAL-T2: budget is spent, here is my answer. Not verified.", [
      {
        text: "The issue body was observed.",
        polarity: "unknown",
        critical: false,
        evidenceIds: [],
        role: "contextual",
      },
    ]);
  }) as typeof fetch;

  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl,
    trace,
    llmRuntimeBudget: { maxLlmCalls: 2, maxWallClockMs: 120_000 },
    maxAttempts: 1,
    maxSteps: 12,
  });

  assert.equal(httpCalls.length, 2);
  assert.equal(boundaryEvent(trace, "budget") !== undefined, true);
  assert.equal(result.agentResult?.decision, "final");
  assert.equal(result.run.status, "insufficient_evidence");
  assert.equal(
    result.run.attempts.some(
      (attempt) => attempt.failure?.errorCode === "LLM_CALL_BUDGET_EXCEEDED",
    ),
    false,
  );
  assert.equal(
    result.run.claims.some((claim) => claim.text === "The issue body was observed."),
    true,
  );
});

test("Test 3 — GAP_CLOSED gives the Agent the Final turn; a tool-holding Agent still ends blocked, not finalized", async () => {
  const seed = makeState();
  addClosedIssue(seed, { stateReason: "not_planned" });
  const seedEvidence = seed.run.evidence[0]!;

  const finalizing = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    maxAttempts: 1,
    model: {
      async decide(): Promise<ModelResponse> {
        return { type: "final", message: "FINAL-T3A: closure observed, answering now." };
      },
    },
    prepareSession: (session) => {
      session.state.addEvidence(seedEvidence);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      session.state.addCandidatePr(616);
    },
  });
  assert.equal(finalizing.agentResult?.decision, "final");
  assert.notEqual(finalizing.agentResult?.decision, "gap_closed");
  const trace = new TraceCollector();
  const holding = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    maxAttempts: 1,
    trace,
    model: {
      async decide(): Promise<ModelResponse> {
        return {
          type: "tool_call",
          call: { id: "refuse", name: "github_get_pull_request", arguments: { owner: "acme", repo: "box", pullNumber: 616 } },
        };
      },
    },
    prepareSession: (session) => {
      session.state.addEvidence(seedEvidence);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      session.state.addCandidatePr(616);
    },
  });
  assert.equal(holding.agentResult?.decision, "gap_closed");
  assert.notEqual(holding.agentResult?.decision, "final");
  assert.equal(holding.agentResult?.status, "failed");
  assert.equal(holding.agentResult?.output, GAP_CLOSED_REASON);
  assert.equal(boundaryEvent(trace, "closure")?.data.investigationClosure, "GAP_CLOSED");
  assert.equal(holding.run.claims.length, 0);
});

test("Test 4 — the Runtime never fabricates the Final answer or Claims at the boundary", async () => {
  const seed = makeState();
  const seedEvidence = addClosedIssue(seed, { stateReason: "not_planned" });
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    maxAttempts: 1,
    trace,
    model: {
      async decide(): Promise<ModelResponse> {
        return { type: "final", message: "FINAL-T4: only my own words reach the report." };
      },
    },
    prepareSession: (session) => {
      session.state.addEvidence(seedEvidence);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      session.state.addCandidatePr(616);
    },
  });

  assert.equal(result.agentResult?.output, "FINAL-T4: only my own words reach the report.");
  const boundary = boundaryEvent(trace);
  assert.ok(boundary);
  assert.equal(boundary.data.finalAuthor, "agent");
  // The Agent finalizes without claims: Runtime must not mint any.
  assert.equal(result.run.claims.length, 0);
  assert.equal(result.report.claimIds.length, 0);
  assert.equal(
    trace.getEvents().some((event) => event.type === "claim_created" || event.type === "claim_recorded"),
    false,
  );
  // ... and completion is still the verifier's call, not the boundary's.
  assert.notEqual(result.verification?.status, "verified_complete");
  assert.notEqual(result.run.status, "verified_complete");
});

test("Test 5 — Final claims still pass through capture and the IndependentCompletionVerifier", async () => {
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    maxAttempts: 1,
    maxSteps: 12,
    trace,
    modelFactory: (session: InvestigationSession): Model => ({
      async decide(_task, _history, toolResults, context): Promise<ModelResponse> {
        if (toolResults.length > 0) {
          const issueEvidence = session.state.run.evidence.find((item) => item.kind === "issue");
          assert.ok(issueEvidence);
          return {
            type: "final",
            message: "FINAL-T5 answering with a claim on observed evidence.",
            claims: [
              {
                text: "The issue is closed in this repository.",
                polarity: "unknown",
                critical: false,
                evidenceIds: [issueEvidence.id],
                role: "contextual",
              },
            ],
          };
        }
        const github = (context?.legalInvestigationActions ?? []).find((item) =>
          item.tool.startsWith("github_"),
        );
        assert.ok(github);
        return {
          type: "tool_call",
          call: { id: "t5-observe", name: github.tool, arguments: github.arguments },
        };
      },
    }),
  });

  assert.equal(result.agentResult?.decision, "final");
  const claim = result.run.claims.find((item) => item.text === "The issue is closed in this repository.");
  assert.ok(claim);
  assert.ok(result.claimEvidence.some((edge) => edge.claimId === claim.id));
  assert.equal(
    trace.getEvents().some((event) => event.type === "verification_completed"),
    true,
  );
  const independent = new IndependentCompletionVerifier().verify({
    task: result.task,
    run: result.run,
  });
  assert.equal(result.verification?.status, independent.status);
});

test("Test 6 — record_claim stays an intermediate action and never substitutes for Final", async () => {
  let seededIssueId = "";
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    maxAttempts: 1,
    maxSteps: 12,
    prepareSession: (session) => {
      const issue = addClosedIssue(session.state);
      seededIssueId = issue.id;
    },
    modelFactory: (session: InvestigationSession): Model => ({
      async decide(_task, _history, _toolResults, context): Promise<ModelResponse> {
        if (session.state.run.claims.length === 0) {
          const recorder = (context?.legalInvestigationActions ?? []).find(
            (item) => item.tool === "record_claim",
          );
          assert.ok(recorder, "record_claim must be offered as a legal investigation action");
          return {
            type: "tool_call",
            call: {
              id: "record-t6",
              name: "record_claim",
              arguments: {
                claims: [
                  {
                    text: "RECORD-T6 intermediate claim.",
                    polarity: "unknown",
                    critical: false,
                    evidenceIds: [seededIssueId],
                    role: "contextual",
                  },
                ],
              },
            },
          };
        }
        return {
          type: "final",
          message: "FINAL-T6: the answer is a separate decision after record_claim.",
        };
      },
    }),
  });

  assert.equal(
    result.investigationSteps.some((step) => step.tool === "record_claim"),
    true,
  );
  assert.equal(result.agentResult?.decision, "final");
  assert.equal(
    result.agentResult?.output,
    "FINAL-T6: the answer is a separate decision after record_claim.",
  );
  assert.equal(
    result.run.claims.some((claim) => claim.text === "RECORD-T6 intermediate claim."),
    true,
  );
  assert.notEqual(result.verification?.status, "verified_complete");
});

test("Test 6b — record_claim offered inside the Finalization Boundary is refused and stays non-Final", async () => {
  const httpCalls: string[] = [];
  const trace = new TraceCollector();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    httpCalls.push(String(input));
    return toolCallResponse("record_claim", { claims: [] });
  }) as typeof fetch;

  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    env: LIVE_ENV,
    fetchImpl,
    trace,
    llmRuntimeBudget: { maxLlmCalls: 1, maxWallClockMs: 120_000 },
    maxAttempts: 1,
    maxSteps: 12,
  });

  assert.equal(httpCalls.length, 1);
  assert.equal(boundaryEvent(trace, "budget") !== undefined, true);
  assert.equal(
    result.investigationSteps.some((step) => step.tool === "record_claim"),
    false,
  );
  assert.notEqual(result.agentResult?.decision, "final");
  assert.equal(result.agentResult?.status, "failed");
  assert.equal(result.run.claims.length, 0);
});
