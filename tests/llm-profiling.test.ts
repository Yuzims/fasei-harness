import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateLlmUsage,
  cacheHitRate,
  ESTIMATED_CHARS_PER_TOKEN,
  formatLlmProfilingSummary,
  LlmUsageCollector,
  profileRequestMessages,
  type LlmCallRecord,
} from "../src/agent/llm-usage.js";
import { DEFAULT_LLM_RUNTIME_BUDGET } from "../src/agent/llm-runtime.js";
import { OpenAICompatModel } from "../src/agent/openai-compat-model.js";
import type { RecoveryPlan } from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  RecoveryPlanner,
  investigate,
  type AnalysisContext,
} from "../src/investigation/index.js";
import { runInvestigation } from "../src/server/investigation-service.js";
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

function callRecord(
  index: number,
  usage: LlmCallRecord["usage"],
  extra: Partial<LlmCallRecord> = {},
): LlmCallRecord {
  return {
    callId: `call-${index}`,
    callIndex: index,
    model: "qwen-plus",
    usage,
    durationMs: 10,
    ok: true,
    ...extra,
  };
}

function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("AbortSignal was not passed to fetch"));
      return;
    }
    const abortError = () => {
      if (signal.reason instanceof Error) {
        reject(signal.reason);
        return;
      }
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      abortError();
      return;
    }
    signal.addEventListener("abort", abortError, { once: true });
  });
}

test("Test 1 — aggregate usage", () => {
  const aggregate = aggregateLlmUsage([
    callRecord(1, { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, totalTokens: 1100 }),
    callRecord(2, { inputTokens: 3000, cachedInputTokens: 1500, outputTokens: 300, totalTokens: 3300 }),
  ]);
  assert.equal(aggregate.totalInputTokens, 4000);
  assert.equal(aggregate.totalCachedInputTokens, 2000);
  assert.equal(aggregate.totalOutputTokens, 400);
  assert.equal(aggregate.overallCacheHitRate, 0.5);
});

test("Test 2 — weighted cache hit, not average of per-call rates", () => {
  const aggregate = aggregateLlmUsage([
    callRecord(1, { inputTokens: 100, cachedInputTokens: 100, outputTokens: 1, totalTokens: 101 }),
    callRecord(2, { inputTokens: 10000, cachedInputTokens: 0, outputTokens: 1, totalTokens: 10001 }),
  ]);
  assert.equal(aggregate.totalInputTokens, 10100);
  assert.equal(aggregate.totalCachedInputTokens, 100);
  assert.equal(aggregate.overallCacheHitRate, 100 / 10100);
  assert.notEqual(aggregate.overallCacheHitRate, 0.5);
  assert.equal(cacheHitRate(10100, 100), 100 / 10100);
});

test("Test 3 — null cache usage stays null, not 0", () => {
  const aggregate = aggregateLlmUsage([
    callRecord(1, { inputTokens: 1000, cachedInputTokens: null, outputTokens: 10, totalTokens: 1010 }),
  ]);
  assert.equal(aggregate.calls[0]?.usage.cachedInputTokens, null);
  assert.equal(aggregate.totalCachedInputTokens, null);
  assert.equal(aggregate.overallCacheHitRate, null);
  const summary = formatLlmProfilingSummary(aggregate);
  assert.match(summary, /Cached input tokens:\s+unavailable/);
  assert.match(summary, /Cache hit rate:\s+unavailable/);
  assert.equal(summary.includes("Cached input tokens: 0"), false);
  assert.equal(summary.includes("Cache hit rate: 0.00%"), false);
});

test("Test 4 — context growth", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    usageCollector: collector,
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
  });
  const histories = [
    [{ role: "user" as const, content: "one" }],
    [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "three" },
    ],
    [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "three" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "five" },
    ],
  ];
  for (const history of histories) {
    await model.decide({ id: "t", description: "grow" }, history, [], { attempt: 1 });
  }
  const calls = collector.getCalls();
  assert.equal(calls[0]?.historyLength, 1);
  assert.equal(calls[1]?.historyLength, 3);
  assert.equal(calls[2]?.historyLength, 5);
  const chars = calls.map((item) => item.serializedRequestChars ?? 0);
  const estimated = calls.map((item) => item.estimatedInputTokens ?? 0);
  assert.ok(chars[0]! > 0 && chars[1]! > chars[0]! && chars[2]! > chars[1]!);
  assert.ok(estimated[0]! > 0 && estimated[1]! > estimated[0]! && estimated[2]! > estimated[1]!);
  assert.equal(calls[0]?.estimatedInputTokens, Math.ceil((calls[0]?.serializedRequestChars ?? 0) / ESTIMATED_CHARS_PER_TOKEN));
  assert.equal(calls[0]?.usage.inputTokens, null);
});

class ContinuePlanner extends RecoveryPlanner {
  plan(_failure: Parameters<RecoveryPlanner["plan"]>[0], _ctx: AnalysisContext): RecoveryPlan {
    return {
      action: "continue_investigation",
      reason: "force a second attempt so call records keep attempt and agentStep separate",
      nextStep: "Continue investigating.",
    };
  }
}

test("Test 5 — attempt separation", async () => {
  let llmCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    maxAttempts: 2,
    maxRecoveryAttempts: 1,
    planner: new ContinuePlanner(),
    fetchImpl: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "github_get_issue",
                      arguments: JSON.stringify({ owner: "acme", repo: "box", issueNumber: 7 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
      });
    },
  });

  const calls = result.llmUsage.calls;
  assert.ok(calls.length >= 3);
  assert.equal(calls[0]?.attempt, 1);
  assert.equal(calls[0]?.agentStep, 1);
  assert.equal(calls[1]?.attempt, 1);
  assert.equal(calls[1]?.agentStep, 2);
  assert.equal(calls[2]?.attempt, 2);
  assert.equal(calls[2]?.agentStep, 1);
  assert.notEqual(
    `${calls[0]?.attempt}:${calls[0]?.agentStep}`,
    `${calls[2]?.attempt}:${calls[2]?.agentStep}`,
  );
  const profiling = formatLlmProfilingSummary(result.llmUsage);
  assert.match(profiling, /Call #1/);
  assert.match(profiling, /attempt: 1/);
  assert.match(profiling, /Call #3/);
  assert.match(profiling, /attempt: 2/);
});

test("Test 6 — runtime timeout still records duration and null tokens", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: hangingFetch,
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 80 },
    maxAttempts: 1,
  });
  assert.equal(result.llmUsage.llmCalls, 1);
  assert.equal(result.llmUsage.calls[0]?.ok, false);
  assert.equal(result.llmUsage.calls[0]?.errorCategory, "runtime_timeout");
  assert.ok((result.llmUsage.calls[0]?.durationMs ?? -1) >= 0);
  assert.equal(result.llmUsage.calls[0]?.usage.inputTokens, null);
  assert.equal(result.llmUsage.calls[0]?.usage.cachedInputTokens, null);
  assert.equal(result.run.attempts.at(-1)?.failure?.type, "runtime_budget_exceeded");
});

test("Test 7 — maxLlmCalls = 8 still blocks the 9th HTTP call", async () => {
  let httpCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    maxAttempts: 1,
    maxSteps: 12,
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 120_000 },
    fetchImpl: async () => {
      httpCalls += 1;
      return jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: `c${httpCalls}`,
                  function: {
                    name: "github_get_issue",
                    arguments: JSON.stringify({ owner: "acme", repo: "box", issueNumber: 42 }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    },
  });
  assert.equal(DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls, 8);
  assert.equal(httpCalls, 8);
  assert.equal(result.llmUsage.llmCalls, 8);
  assert.equal(result.run.attempts.at(-1)?.failure?.errorCode, "LLM_CALL_BUDGET_EXCEEDED");
});

test("Test 8 — Snapshot path still records zero LLM calls", async () => {
  const session = await runInvestigation({ caseId: "C01" });
  assert.equal(session.actor, "test_driver");
  assert.equal(session.llmUsage?.llmCalls, 0);
  assert.equal(session.verification?.status, "verified_complete");
  assert.match(session.llmUsage?.profilingSummary ?? "", /LLM Profiling/);
});

test("local context estimate is chars/4 and is not provider usage", () => {
  const profile = profileRequestMessages([{ role: "user", content: "abcd".repeat(10) }], 1);
  assert.equal(profile.historyLength, 1);
  assert.equal(profile.messageCount, 1);
  assert.ok((profile.serializedRequestChars ?? 0) > 0);
  assert.equal(
    profile.estimatedInputTokens,
    Math.ceil((profile.serializedRequestChars ?? 0) / ESTIMATED_CHARS_PER_TOKEN),
  );
  assert.equal(JSON.stringify(profile).includes("abcd"), false);
});

test("profiling summary and DTO omit prompts, tools schema, and secrets", async () => {
  const apiKey = "sk-live-OPENAI_API_KEY-secret-value";
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    maxAttempts: 1,
    maxRecoveryAttempts: 0,
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: "qwen-plus",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    },
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 8,
          total_tokens: 88,
          prompt_tokens_details: { cached_tokens: 16 },
        },
      }),
  });
  const session = await runInvestigation(
    { issue: "acme/box#42", mode: "snapshot" },
    {
      env: {
        AGENT_MODEL: "openai",
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: "qwen-plus",
        OPENAI_BASE_URL: "https://example.invalid/v1",
      },
    },
  );
  const blob = JSON.stringify({
    usage: result.llmUsage,
    summary: formatLlmProfilingSummary(result.llmUsage),
    dto: session.llmUsage,
    completed: trace.getEvents().find((event) => event.type === "investigation_completed")?.data,
  });
  assert.equal(blob.includes(apiKey), false);
  assert.equal(blob.includes(INVESTIGATION_SYSTEM_PROMPT), false);
  assert.equal(/Authorization/i.test(blob), false);
  assert.equal(result.llmUsage.calls[0]?.agentStep, 1);
  assert.equal(typeof result.llmUsage.calls[0]?.estimatedInputTokens, "number");
});
