import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateLlmUsage,
  cacheHitRate,
  extractLlmUsage,
  formatLlmUsageSummary,
  LlmUsageCollector,
  type LlmCallRecord,
} from "../src/agent/llm-usage.js";
import { OpenAICompatModel, parseChatCompletionStream } from "../src/agent/openai-compat-model.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import { INVESTIGATION_SYSTEM_PROMPT, investigate } from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

const QWEN_USAGE = {
  prompt_tokens: 3019,
  completion_tokens: 104,
  total_tokens: 3123,
  prompt_tokens_details: {
    cached_tokens: 2048,
  },
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
): LlmCallRecord {
  return {
    callId: `call-${index}`,
    callIndex: index,
    model: "qwen-plus",
    usage,
    durationMs: 10,
    ok: true,
  };
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test("extractLlmUsage：Qwen prompt_tokens_details.cached_tokens 不叠加到 input", () => {
  const usage = extractLlmUsage({ usage: QWEN_USAGE });
  assert.equal(usage.inputTokens, 3019);
  assert.equal(usage.cachedInputTokens, 2048);
  assert.equal(usage.outputTokens, 104);
  assert.equal(usage.totalTokens, 3123);
  assert.notEqual(usage.inputTokens, 3019 + 2048);
});

test("extractLlmUsage：缺少 cached_tokens 时为 null，不编造 0", () => {
  const usage = extractLlmUsage({
    usage: {
      prompt_tokens: 3019,
      completion_tokens: 104,
      total_tokens: 3123,
    },
  });
  assert.equal(usage.inputTokens, 3019);
  assert.equal(usage.cachedInputTokens, null);
  assert.equal(usage.outputTokens, 104);
  assert.equal(usage.totalTokens, 3123);
});

test("extractLlmUsage：缺失 usage 不 crash，字段为 null", () => {
  assert.deepEqual(extractLlmUsage({ choices: [] }), {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
  assert.deepEqual(extractLlmUsage(null), {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
  assert.deepEqual(extractLlmUsage({ usage: "nope" }), {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
});

test("extractLlmUsage：显式 cached_tokens=0 保留 0，与字段缺失不同", () => {
  const usage = extractLlmUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      total_tokens: 101,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  assert.equal(usage.cachedInputTokens, 0);
});

test("cacheHitRate：token 加权命中率，0/null 不产生 NaN 或 Infinity", () => {
  assert.equal(cacheHitRate(10000, 6000), 0.6);
  assert.equal(cacheHitRate(0, 10), null);
  assert.equal(cacheHitRate(null, 10), null);
  assert.equal(cacheHitRate(10, null), null);
  assert.equal(cacheHitRate(null, null), null);

  const zero = cacheHitRate(0, 0);
  const missing = cacheHitRate(null, 0);
  assert.equal(Number.isNaN(zero as number), false);
  assert.equal(Number.isFinite(zero as number) || zero === null, true);
  assert.equal(zero, null);
  assert.equal(missing, null);
});

test("aggregateLlmUsage：多次 call 按 token 加权，而不是命中率平均", () => {
  const aggregate = aggregateLlmUsage([
    callRecord(1, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, totalTokens: 1100 }),
    callRecord(2, { inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 200, totalTokens: 5200 }),
    callRecord(3, { inputTokens: 10000, cachedInputTokens: 0, outputTokens: 300, totalTokens: 10300 }),
  ]);

  assert.equal(aggregate.llmCalls, 3);
  assert.equal(aggregate.totalInputTokens, 16000);
  assert.equal(aggregate.totalCachedInputTokens, 4800);
  assert.equal(aggregate.totalOutputTokens, 600);
  assert.equal(aggregate.totalTokens, 16600);
  assert.equal(aggregate.overallCacheHitRate, 0.3);
  assert.notEqual(aggregate.overallCacheHitRate, (0.8 + 0.8 + 0) / 3);
  assert.equal(aggregate.averageInputTokensPerCall, 16000 / 3);
  assert.equal(aggregate.averageOutputTokensPerCall, 200);
});

test("formatLlmUsageSummary：缺失字段显示 unavailable，不编造 0", () => {
  const summary = formatLlmUsageSummary(aggregateLlmUsage([]));
  assert.match(summary, /LLM Calls\s+0/);
  assert.match(summary, /Cached Input Tokens\s+unavailable/);
  assert.match(summary, /Cache Hit Rate\s+unavailable/);
  assert.equal(summary.includes("Cached Input Tokens    0"), false);
});

test("parseChatCompletionStream：从最后一块提取 usage", async () => {
  const assembled = await parseChatCompletionStream(
    streamFrom([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      `data: {"choices":[],"usage":${JSON.stringify(QWEN_USAGE)}}\n\n`,
      "data: [DONE]\n\n",
    ]),
  );
  const usage = extractLlmUsage(assembled);
  assert.equal(usage.inputTokens, 3019);
  assert.equal(usage.cachedInputTokens, 2048);
  assert.equal(usage.outputTokens, 104);
});

test("OpenAICompatModel：从 JSON response 提取 usage，失败时仍记录 duration", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    usageCollector: collector,
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "done" } }],
        usage: QWEN_USAGE,
      }),
  });

  await model.decide({ id: "t", description: "hello" }, [{ role: "user", content: "hello" }], []);
  const recorded = collector.getCalls()[0];
  assert.equal(recorded?.usage.inputTokens, 3019);
  assert.equal(recorded?.usage.cachedInputTokens, 2048);
  assert.equal(recorded?.ok, true);
  assert.ok((recorded?.durationMs ?? -1) >= 0);

  const failing = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    usageCollector: collector,
    fetchImpl: async () => jsonResponse({ error: { message: "nope" } }, 401),
  });
  await assert.rejects(() =>
    failing.decide({ id: "t", description: "hello" }, [{ role: "user", content: "hello" }], []),
  );
  const failed = collector.getCalls()[1];
  assert.equal(failed?.ok, false);
  assert.equal(failed?.errorCategory, "http_4xx");
  assert.equal(failed?.usage.inputTokens, null);
  assert.ok((failed?.durationMs ?? -1) >= 0);
});

test("OpenAICompatModel：historyLength 随后续 decide 增长", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    usageCollector: collector,
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
  });
  await model.decide({ id: "t", description: "a" }, [{ role: "user", content: "a" }], []);
  await model.decide(
    { id: "t", description: "a" },
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "more" },
    ],
    [],
  );
  assert.equal(collector.getCalls()[0]?.historyLength, 1);
  assert.equal(collector.getCalls()[1]?.historyLength, 3);
  assert.ok((collector.getCalls()[1]?.historyLength ?? 0) > (collector.getCalls()[0]?.historyLength ?? 0));
  assert.ok((collector.getCalls()[0]?.serializedRequestChars ?? 0) > 0);
  assert.ok(
    (collector.getCalls()[1]?.serializedRequestChars ?? 0) >
      (collector.getCalls()[0]?.serializedRequestChars ?? 0),
  );
  assert.ok((collector.getCalls()[0]?.estimatedInputTokens ?? 0) > 0);
  assert.notEqual(collector.getCalls()[0]?.estimatedInputTokens, collector.getCalls()[0]?.usage.inputTokens);
});

test("Investigation：三次真实 LLM call 汇总 token，且 llmCalls ≠ toolCalls", async () => {
  const usages = [
    { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } },
    { prompt_tokens: 5000, completion_tokens: 200, total_tokens: 5200, prompt_tokens_details: { cached_tokens: 4000 } },
    { prompt_tokens: 10000, completion_tokens: 300, total_tokens: 10300, prompt_tokens_details: { cached_tokens: 0 } },
  ];
  let calls = 0;
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    maxAttempts: 1,
    maxRecoveryAttempts: 0,
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "qwen-plus",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    },
    fetchImpl: async () => {
      const index = calls;
      calls += 1;
      if (index === 0) {
        return jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "github_get_issue",
                      arguments: JSON.stringify({ owner: "acme", repo: "box", issueNumber: 42 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: usages[0],
        });
      }
      if (index === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c2",
                    function: {
                      name: "github_get_issue_timeline",
                      arguments: JSON.stringify({ owner: "acme", repo: "box", issueNumber: 42 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: usages[1],
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: usages[2],
      });
    },
  });

  assert.equal(result.llmUsage.llmCalls, 3);
  assert.equal(result.llmUsage.totalInputTokens, 16000);
  assert.equal(result.llmUsage.totalCachedInputTokens, 4800);
  assert.equal(result.llmUsage.totalOutputTokens, 600);
  assert.equal(result.llmUsage.totalTokens, 16600);
  assert.equal(result.llmUsage.overallCacheHitRate, 0.3);
  assert.equal(result.investigationSteps.length, 2);
  assert.notEqual(result.llmUsage.llmCalls, result.investigationSteps.length);

  const completed = trace.getEvents().filter((event) => event.type === "model_call_completed");
  assert.equal(completed.length, 3);
  assert.ok((Number(completed[0]?.data.historyLength) ?? 0) < (Number(completed[2]?.data.historyLength) ?? 0));
  const done = trace.getEvents().find((event) => event.type === "investigation_completed");
  assert.equal((done?.data.llmUsage as { llmCalls?: number } | undefined)?.llmCalls, 3);
});

test("Investigation：test driver 的 model_call 不是 LLM call", async () => {
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    useTestDriver: true,
  });
  const modelCalls = trace.getEvents().filter((event) => event.type === "model_call").length;
  const toolCalls = trace.getEvents().filter((event) => event.type === "tool_call").length;
  assert.ok(modelCalls > 0);
  assert.ok(toolCalls > 0);
  assert.equal(result.llmUsage.llmCalls, 0);
  assert.equal(result.llmUsage.totalInputTokens, null);
  assert.equal(
    trace.getEvents().some((event) => event.type === "model_call_completed"),
    false,
  );
});

test("Trace：model_call_completed 不含密钥、Authorization 或完整 prompt", async () => {
  const apiKey = "sk-live-OPENAI_API_KEY-secret-value";
  const githubToken = "github_pat_GITHUB_TOKEN_secret_value";
  const trace = new TraceCollector();
  await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    trace,
    maxAttempts: 1,
    maxRecoveryAttempts: 0,
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: apiKey,
      GITHUB_TOKEN: githubToken,
      OPENAI_MODEL: "qwen-plus",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    },
    fetchImpl: async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      assert.match(headers.authorization, /Bearer sk-live/);
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: QWEN_USAGE,
      });
    },
  });

  const completed = trace.getEvents().filter((event) => event.type === "model_call_completed");
  assert.equal(completed.length, 1);
  const blob = JSON.stringify({
    events: completed,
    completed: trace.getEvents().find((event) => event.type === "investigation_completed")?.data,
  });
  assert.equal(blob.includes(apiKey), false);
  assert.equal(blob.includes(githubToken), false);
  assert.equal(/OPENAI_API_KEY/.test(blob), false);
  assert.equal(/GITHUB_TOKEN/.test(blob), false);
  assert.equal(/Authorization/i.test(blob), false);
  assert.equal(blob.includes(INVESTIGATION_SYSTEM_PROMPT), false);
  assert.equal(blob.includes("You are an Investigation Agent for GitHub issues."), false);
  const data = completed[0]?.data ?? {};
  assert.equal("messages" in data, false);
  assert.equal("prompt" in data, false);
  assert.equal("systemPrompt" in data, false);
  assert.equal("headers" in data, false);
  assert.equal("body" in data, false);
  assert.equal((data.usage as { inputTokens?: number }).inputTokens, 3019);
  assert.equal(data.inputTokens, 3019);
  assert.equal(typeof data.estimatedInputTokens, "number");
  assert.ok((data.estimatedInputTokens as number) > 0);
  assert.equal(typeof data.serializedRequestChars, "number");
  const profiling = String(
    trace.getEvents().find((event) => event.type === "investigation_completed")?.data.llmProfilingSummary ??
      "",
  );
  assert.match(profiling, /LLM Profiling/);
  assert.equal(profiling.includes(apiKey), false);
  assert.equal(profiling.includes(INVESTIGATION_SYSTEM_PROMPT), false);
});
