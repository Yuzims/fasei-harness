import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LLM_RUNTIME_BUDGET,
  LLM_CALL_BUDGET_EXCEEDED,
  LLM_RUNTIME_TIMEOUT,
} from "../src/agent/llm-runtime.js";
import type { RecoveryPlan } from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  RecoveryPlanner,
  investigate,
  type AnalysisContext,
} from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const LIVE_ENV = {
  AGENT_MODEL: "openai",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODEL: "qwen-plus",
  OPENAI_BASE_URL: "https://example.invalid/v1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("AbortSignal was not passed to fetch"));
      return;
    }
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  usage?: Record<string, number>,
): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: `call-${name}`,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage,
  });
}

function finalResponse(usage?: Record<string, number>): Response {
  return jsonResponse({
    choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
    usage,
  });
}

function threeDecisionFetch(httpCalls: string[], signals: AbortSignal[]): typeof fetch {
  return async (input, init) => {
    httpCalls.push(String(input));
    if (init?.signal) {
      signals.push(init.signal);
    }
    const index = httpCalls.length;
    if (index === 1) {
      return toolCallResponse("github_get_issue", {
        owner: "acme",
        repo: "box",
        issueNumber: 42,
      }, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    }
    if (index === 2) {
      return toolCallResponse("github_get_issue_timeline", {
        owner: "acme",
        repo: "box",
        issueNumber: 42,
      }, { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 });
    }
    return finalResponse({ prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 });
  };
}

class ContinuePlanner extends RecoveryPlanner {
  plan(_failure: Parameters<RecoveryPlanner["plan"]>[0], _ctx: AnalysisContext): RecoveryPlan {
    return {
      action: "continue_investigation",
      reason: "try to bypass LLM runtime budget",
      nextStep: "Continue investigating.",
    };
  }
}

test("Finalization Boundary reserves the last call; the later budget overrun stays terminal", async () => {
  const httpCalls: string[] = [];
  const signals: AbortSignal[] = [];
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: threeDecisionFetch(httpCalls, signals),
    trace,
    planner: new ContinuePlanner(),
    llmRuntimeBudget: { maxLlmCalls: 2, maxWallClockMs: 120_000 },
    maxAttempts: 3,
    maxRecoveryAttempts: 3,
  });

  // Call 2 was the reserved Finalization decision, not exploration: it is
  // answered with a tool by the scripted model and refused without execution.
  assert.equal(httpCalls.length, 2);
  assert.equal(result.llmUsage.llmCalls, 2);
  assert.equal(
    httpCalls.every((url) => url.includes("/chat/completions")),
    true,
  );
  const boundary = trace
    .getEvents()
    .find((event) => event.type === "finalization_boundary_reached");
  assert.equal(boundary?.data.trigger, "budget");
  assert.equal(boundary?.data.remainingLlmCalls, 1);
  const failure = result.run.attempts.at(-1)?.failure;
  assert.equal(failure?.type, "runtime_budget_exceeded");
  assert.equal(failure?.errorCode, LLM_CALL_BUDGET_EXCEEDED);
  assert.equal(failure?.retryable, false);
  assert.equal(result.run.attempts.at(-1)?.recovery?.action, "stop");
  assert.equal(result.run.status, "stopped");
  assert.equal(result.run.attempts.length, 2);
  assert.equal(signals.length, 2);
  assert.ok(signals[0] instanceof AbortSignal);
});

test("LLM wall-clock: expired deadline sends no HTTP and fails as LLM_RUNTIME_TIMEOUT", async () => {
  let httpCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: async () => {
      httpCalls += 1;
      return finalResponse();
    },
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 0 },
    maxAttempts: 3,
  });

  assert.equal(httpCalls, 0);
  assert.equal(result.llmUsage.llmCalls, 0);
  const failure = result.run.attempts.at(-1)?.failure;
  assert.equal(failure?.type, "runtime_budget_exceeded");
  assert.equal(failure?.errorCode, LLM_RUNTIME_TIMEOUT);
  assert.equal((failure?.details as { resource?: string } | undefined)?.resource, "wall_clock");
  assert.equal(result.run.attempts.at(-1)?.recovery?.action, "stop");
});

test("LLM in-flight abort: deadline aborts fetch and classifies LLM_RUNTIME_TIMEOUT", async () => {
  let seenSignal: AbortSignal | undefined;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: async (input, init) => {
      seenSignal = init?.signal;
      assert.ok(init?.signal instanceof AbortSignal);
      return hangingFetch(input, init);
    },
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 80 },
    maxAttempts: 1,
  });

  assert.equal(seenSignal?.aborted, true);
  const failure = result.run.attempts.at(-1)?.failure;
  assert.equal(failure?.type, "runtime_budget_exceeded");
  assert.equal(failure?.errorCode, LLM_RUNTIME_TIMEOUT);
  assert.equal(result.llmUsage.llmCalls, 1);
  assert.equal(result.llmUsage.calls[0]?.ok, false);
  assert.equal(result.llmUsage.calls[0]?.errorCategory, "runtime_timeout");
  assert.equal(result.run.attempts.at(-1)?.recovery?.action, "stop");
});

test("LLM usage survives a timed-out second call and keeps unknown tokens null", async () => {
  let httpCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: async (input, init) => {
      httpCalls += 1;
      if (httpCalls === 1) {
        return toolCallResponse(
          "github_get_issue",
          { owner: "acme", repo: "box", issueNumber: 42 },
          { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
        );
      }
      return hangingFetch(input, init);
    },
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 150 },
    maxAttempts: 1,
  });

  assert.equal(httpCalls, 2);
  assert.equal(result.llmUsage.llmCalls, 2);
  const first = result.llmUsage.calls[0];
  const second = result.llmUsage.calls[1];
  assert.equal(first?.ok, true);
  assert.equal(first?.callIndex, 1);
  assert.equal(first?.usage.inputTokens, 40);
  assert.equal(first?.usage.outputTokens, 6);
  assert.equal(second?.ok, false);
  assert.equal(second?.callIndex, 2);
  assert.equal(second?.errorCategory, "runtime_timeout");
  assert.ok((second?.durationMs ?? -1) >= 0);
  assert.equal(second?.usage.inputTokens, null);
  assert.equal(second?.usage.cachedInputTokens, null);
  assert.equal(second?.usage.outputTokens, null);
  assert.equal(second?.usage.totalTokens, null);
  assert.equal(result.run.attempts.at(-1)?.failure?.errorCode, LLM_RUNTIME_TIMEOUT);
});

test("LLM budget failure is terminal and cannot be bypassed by recovery", async () => {
  const httpCalls: string[] = [];
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: threeDecisionFetch(httpCalls, []),
    trace,
    llmRuntimeBudget: { maxLlmCalls: 1, maxWallClockMs: 120_000 },
    maxAttempts: 3,
    maxRecoveryAttempts: 3,
    planner: new ContinuePlanner(),
  });

  // The one allowed call is the Finalization decision itself; the scripted
  // model answers with a tool, so Runtime refuses it without executing.
  assert.equal(httpCalls.length, 1);
  assert.equal(result.llmUsage.llmCalls, 1);
  assert.equal(
    trace.getEvents().some((event) => event.type === "finalization_boundary_reached"),
    true,
  );
  assert.equal(
    trace.getEvents().some((event) => event.type === "tool_call"),
    false,
  );
  assert.equal(result.run.attempts.length, 2);
  const attempt = result.run.attempts.at(-1);
  assert.equal(attempt?.failure?.type, "runtime_budget_exceeded");
  assert.equal(attempt?.failure?.errorCode, LLM_CALL_BUDGET_EXCEEDED);
  assert.equal(attempt?.recovery?.action, "stop");
  assert.equal(result.run.status, "stopped");
});

test("Snapshot test driver is unchanged and does not issue LLM HTTP", async () => {
  let httpCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    useTestDriver: true,
    fetchImpl: async () => {
      httpCalls += 1;
      throw new Error("snapshot path must not call LLM HTTP");
    },
  });

  assert.equal(httpCalls, 0);
  assert.equal(result.actor, "test_driver");
  assert.equal(result.llmUsage.llmCalls, 0);
  assert.equal(result.verification?.status, "verified_complete");
  assert.equal(result.runtimeBudget?.maxLlmCalls, DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls);
  assert.equal(result.runtimeBudget?.maxWallClockMs, DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs);
});
