import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import type { Task, ToolResult } from "../src/core/types.js";
import { GitHubProviderError } from "../src/github/errors.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  SnapshotInvestigationDriver,
  attemptProvenance,
  attemptToolNames,
  canonicalRecoveryTrace,
  CLOSED_LOOP_TRACE_TYPES,
  investigate,
  type InvestigationSession,
} from "../src/investigation/index.js";
import { resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import {
  FASEI_RECOVERY_SCENARIOS,
  executeScenario,
  runFaseiBenchmark,
  runScenario,
} from "../src/benchmark/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function alwaysTimeoutProvider() {
  const inner = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "getIssue") {
        return async () => {
          throw new GitHubProviderError({
            code: "timeout",
            operation: "getIssue",
            message: "getIssue timed out after 15000ms",
          });
        };
      }
      return value;
    },
  });
}

function timeoutThenSuccessProvider() {
  const inner = new SnapshotGitHubProvider(githubFixturePath("resolved"));
  let issueCalls = 0;
  return new Proxy(inner, {
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
}

function getIssueThenStopModel(): Model {
  return {
    async decide(
      _task: Task,
      _history: HistoryMessage[],
      toolResults: ToolResult[],
    ): Promise<ModelResponse> {
      if (toolResults.some((item) => item.success === false)) {
        return { type: "final", message: "Tool failed; stopping this attempt. Not verified." };
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
  };
}

function assertClosedLoopTrace(events: ReturnType<TraceCollector["getEvents"]>): void {
  const types = events.map((event) => event.type);
  for (const required of CLOSED_LOOP_TRACE_TYPES) {
    assert.equal(types.includes(required), true, `missing trace ${required}`);
  }
  const firstAttempt = types.indexOf("investigation_attempt_started");
  const failure = types.indexOf("failure_detected");
  const planned = types.indexOf("recovery_planned");
  const applied = types.indexOf("recovery_applied");
  const secondAttempt = types.indexOf("investigation_attempt_started", firstAttempt + 1);
  assert.ok(firstAttempt >= 0);
  assert.ok(failure > firstAttempt);
  assert.ok(planned > failure);
  assert.ok(applied > planned);
  assert.ok(secondAttempt > applied);
}

test("TEST 1 — TOOL_FAILURE recovery creates a retry attempt that succeeds", async () => {
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: timeoutThenSuccessProvider(),
    trace,
    maxAttempts: 3,
    model: getIssueThenStopModel(),
  });

  assert.ok(result.run.attempts.length >= 2);
  const first = result.run.attempts[0];
  const second = result.run.attempts[1];
  assert.ok(first && second);
  assert.equal(first.failure?.type, "tool_failure");
  assert.ok(first.failure?.id);
  assert.equal(first.recovery?.action, "retry_with_backoff");
  assert.ok(first.recovery?.id);
  assert.equal(first.recovery?.failureEventId, first.failure?.id);
  assert.equal(second.parentAttemptId, first.id);
  assert.equal(second.recoveryPlanId, first.recovery?.id);
  assert.equal(second.failureEventId, first.failure?.id);
  assert.equal(first.strategy?.type, "observe_issue");
  assert.equal(second.strategy?.type, "retry_failed_tool");
  assert.notEqual(first.id, second.id);
  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);

  const tools1 = attemptToolNames(trace.getEvents(), 1);
  const tools2 = attemptToolNames(trace.getEvents(), 2);
  assert.equal(tools1.includes("github_get_issue"), true);
  assert.equal(tools2.includes("github_get_issue"), true);
  const attempt1Result = trace
    .getEvents()
    .find((event) => event.type === "tool_result" && event.data.attempt === 1);
  const attempt2Result = trace
    .getEvents()
    .find((event) => event.type === "tool_result" && event.data.attempt === 2);
  assert.equal(attempt1Result?.data.success, false);
  assert.equal(attempt2Result?.data.success, true);
  assertClosedLoopTrace(trace.getEvents());
});

test("TEST 2 — INSUFFICIENT_EVIDENCE recovery changes strategy and gathers new evidence", async () => {
  const trace = new TraceCollector();
  const report = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    maxAttempts: 3,
    modelFactory: (session: InvestigationSession): Model => {
      const driver = new SnapshotInvestigationDriver(session.state);
      return {
        async decide(task, history, toolResults, context): Promise<ModelResponse> {
          if ((context?.attempt ?? 1) > 1) {
            return driver.decide(task, history, toolResults, context);
          }
          const issueNumber = session.state.task.target.issueNumber;
          const target = { owner: "acme", repo: "box", issueNumber };
          if (!session.state.investigatedResources.has(resourceKey("issue", String(issueNumber)))) {
            session.state.pendingReason = "Observe the issue first.";
            return {
              type: "tool_call",
              call: { id: "i1", name: "github_get_issue", arguments: target },
            };
          }
          if (!session.state.investigatedResources.has(resourceKey("timeline", String(issueNumber)))) {
            session.state.pendingReason = "Observe the timeline only.";
            return {
              type: "tool_call",
              call: { id: "i2", name: "github_get_issue_timeline", arguments: target },
            };
          }
          if (!session.state.claimsRecorded) {
            session.state.pendingReason = "Record missing resolution evidence.";
            return {
              type: "tool_call",
              call: {
                id: "i3",
                name: "record_claim",
                arguments: {
                  claims: [
                    {
                      text: `Issue #${issueNumber} is closed; resolution evidence is missing.`,
                      polarity: "unknown",
                      critical: true,
                      evidenceIds: session.state.run.evidence.map((item) => item.id),
                      role: "contextual",
                    },
                  ],
                  conclusion: "Insufficient resolution evidence.",
                  polarity: "unknown",
                },
              },
            };
          }
          return {
            type: "final",
            message: "Issue is closed; resolution evidence is insufficient. Not verified.",
          };
        },
      };
    },
  });

  assert.ok(report.run.attempts.length >= 2);
  const first = report.run.attempts[0];
  const second = report.run.attempts[1];
  assert.ok(first && second);
  assert.equal(first.failure?.type, "insufficient_evidence");
  assert.equal(first.recovery?.action, "gather_missing_evidence");
  assert.notEqual(first.strategy?.type, second.strategy?.type);
  assert.equal(second.strategy?.type, "gather_resolution_evidence");
  assert.ok(second.evidenceIds.length > first.evidenceIds.length);
  const tools1 = attemptToolNames(trace.getEvents(), 1);
  const tools2 = attemptToolNames(trace.getEvents(), 2);
  assert.equal(tools1.includes("github_get_issue"), true);
  assert.equal(tools1.includes("github_get_issue_timeline"), true);
  assert.equal(
    tools2.some((tool) => tool === "github_get_pull_request" || tool === "github_list_commits"),
    true,
  );
  assert.equal(report.verification?.status, "verified_complete");
});

test("TEST 3 — PREMATURE_COMPLETION does not terminate the investigation", async () => {
  const scenario = FASEI_RECOVERY_SCENARIOS.find(
    (item) => item.id === "recovery-premature-completion",
  );
  assert.ok(scenario);
  const report = await executeScenario(scenario);
  assert.ok(report.run.attempts.length >= 2);
  const first = report.run.attempts[0];
  const second = report.run.attempts[1];
  assert.ok(first && second);
  assert.equal(first.failure?.type, "premature_completion");
  assert.equal(first.recovery?.action, "continue_investigation");
  assert.equal(first.verification?.status, "insufficient_evidence");
  assert.equal(report.verification?.status, "verified_complete");
  assert.equal(second.strategy?.type, "continue_investigation");
  assert.notEqual(first.strategy?.type, second.strategy?.type);
});

test("TEST 4 — Attempt 2 provenance points at recovery, failure, and Attempt 1", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: timeoutThenSuccessProvider(),
    maxAttempts: 3,
    model: getIssueThenStopModel(),
  });
  const first = result.run.attempts[0];
  const second = result.run.attempts[1];
  assert.ok(first && second);
  const provenance = attemptProvenance(second);
  assert.equal(provenance.parentAttemptId, first.id);
  assert.equal(provenance.recoveryPlanId, first.recovery?.id);
  assert.equal(provenance.failureEventId, first.failure?.id);
  assert.equal(first.recovery?.failureEventId, first.failure?.id);
  assert.equal(second.parentAttemptId, first.id);
});

test("TEST 5 — Recovery is bounded and never creates Attempt 4", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: alwaysTimeoutProvider(),
    maxAttempts: 3,
    maxRecoveryAttempts: 3,
    maxToolRetries: 2,
    model: getIssueThenStopModel(),
  });
  assert.equal(result.run.attempts.length, 3);
  assert.equal(result.run.attempts.some((item) => item.attempt === 4), false);
  assert.equal(result.run.status, "recovery_exhausted");
  assert.equal(result.run.attempts.at(-1)?.status, "recovery_exhausted");
  assert.notEqual(result.verification?.status, "verified_complete");
});

test("TEST 6 — Recovery that still fails is not reported as success", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: alwaysTimeoutProvider(),
    maxAttempts: 3,
    model: getIssueThenStopModel(),
  });
  assert.ok(result.run.attempts.length >= 2);
  assert.notEqual(result.run.attempts[1]?.verification?.status, "verified_complete");
  assert.notEqual(result.verification?.status, "verified_complete");
  assert.notEqual(result.run.status, "verified_complete");
});

test("TEST 7 — Recovery runtime cannot see Ground Truth", () => {
  const productionDirs = ["domain", "investigation", "verification"];
  for (const dir of productionDirs) {
    const folder = join(ROOT, "src", dir);
    for (const file of readdirSync(folder)) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(folder, file), "utf8");
      assert.equal(source.includes("ground-truth.json"), false, `${dir}/${file}`);
      assert.equal(source.includes("expectedOutcome"), false, `${dir}/${file}`);
      assert.equal(source.includes("expectedFailureModes"), false, `${dir}/${file}`);
    }
  }
  const planner = readFileSync(join(ROOT, "src/investigation/recovery-planner.ts"), "utf8");
  assert.equal(planner.includes("error.message"), false);
});

test("TEST 8 — Deterministic recovery replay matches canonical trace and outcome", async () => {
  const scenario = FASEI_RECOVERY_SCENARIOS.find((item) => item.id === "tool-failure");
  assert.ok(scenario);
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  assert.deepEqual(
    {
      observed: first.observedOutcome,
      passed: first.passed,
      failures: first.failureTypes,
      recovered: first.recovered,
      attempts: first.attemptCount,
    },
    {
      observed: second.observedOutcome,
      passed: second.passed,
      failures: second.failureTypes,
      recovered: second.recovered,
      attempts: second.attemptCount,
    },
  );

  const traces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const trace = new TraceCollector();
    const report = await investigate({
      task: { owner: "acme", repository: "box", issueNumber: 42 },
      provider: timeoutThenSuccessProvider(),
      trace,
      maxAttempts: 3,
      model: getIssueThenStopModel(),
    });
    traces.push(JSON.stringify(canonicalRecoveryTrace(trace.getEvents())));
    assert.ok(report.run.attempts.length >= 2);
  }
  assert.equal(traces[0], traces[1]);
});

test("Synthetic recovery suite exercises the three closed loops", async () => {
  const report = await runFaseiBenchmark(FASEI_RECOVERY_SCENARIOS);
  assert.equal(report.scenarioCount, 3);
  const byId = Object.fromEntries(report.results.map((item) => [item.scenarioId, item]));
  assert.equal(byId["tool-failure"]?.passed, true);
  assert.equal(byId["tool-failure"]?.recovered, true);
  assert.equal(byId["recovery-insufficient-evidence"]?.passed, true);
  assert.equal(byId["recovery-insufficient-evidence"]?.recovered, true);
  assert.equal(byId["recovery-premature-completion"]?.passed, true);
  assert.equal(byId["recovery-premature-completion"]?.recovered, true);
  assert.equal(report.metrics.recoverySuccessRate, 1);
});
