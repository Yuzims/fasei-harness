import assert from "node:assert/strict";
import test from "node:test";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  contextFingerprintDelta,
  formatLlmProfilingSummary,
  largestContextContributor,
  llmCallTraceData,
  LlmUsageCollector,
  profileRequestMessages,
} from "../src/agent/llm-usage.js";
import { DEFAULT_LLM_RUNTIME_BUDGET } from "../src/agent/llm-runtime.js";
import { OpenAICompatModel, toOpenAITools } from "../src/agent/openai-compat-model.js";
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

const SAMPLE_TOOLS = toOpenAITools([
  {
    name: "github_get_issue",
    description: "Read a GitHub issue.",
    parameters: { type: "object", properties: { issueNumber: { type: "number" } } },
  },
  {
    name: "github_get_issue_timeline",
    description: "Read a GitHub issue timeline.",
    parameters: { type: "object", properties: { issueNumber: { type: "number" } } },
  },
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function legalInvestigationToolResponse(
  callIndex: number,
  issueNumber: number,
  usage: Record<string, unknown>,
): Response {
  const tools: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "github_get_issue", arguments: { owner: "acme", repo: "box", issueNumber } },
    { name: "github_get_issue_timeline", arguments: { owner: "acme", repo: "box", issueNumber } },
    { name: "github_get_issue_comments", arguments: { owner: "acme", repo: "box", issueNumber } },
    { name: "github_list_commits", arguments: { owner: "acme", repo: "box" } },
  ];
  const pick =
    callIndex <= tools.length
      ? tools[callIndex - 1]!
      : { name: "record_claim", arguments: { claims: [] } };
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: `c${callIndex}`,
              function: {
                name: pick.name,
                arguments: JSON.stringify(pick.arguments),
              },
            },
          ],
        },
      },
    ],
    usage,
  });
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

function assistantTool(id: string, name: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  };
}

function toolResult(id: string, content: string): Record<string, unknown> {
  return {
    role: "tool",
    tool_call_id: id,
    content,
  };
}

class ContinuePlanner extends RecoveryPlanner {
  plan(_failure: Parameters<RecoveryPlanner["plan"]>[0], _ctx: AnalysisContext): RecoveryPlan {
    return {
      action: "continue_investigation",
      reason: "force a second attempt so call records keep attempt and agentStep separate",
      nextStep: "Continue investigating.",
    };
  }
}

test("Test 1 — message role breakdown", () => {
  const system = "S".repeat(10);
  const user = "U".repeat(20);
  const assistant1 = "A".repeat(30);
  const assistant2 = "B".repeat(40);
  const tool1 = "T".repeat(11);
  const tool2 = "T".repeat(12);
  const tool3 = "T".repeat(13);
  const profile = profileRequestMessages(
    [
      { role: "system", content: system },
      { role: "user", content: user },
      { role: "assistant", content: assistant1 },
      toolResult("t1", tool1),
      { role: "assistant", content: assistant2 },
      toolResult("t2", tool2),
      toolResult("t3", tool3),
    ],
    6,
  );

  const byRole = Object.fromEntries(profile.messageRoles.map((item) => [item.role, item]));
  assert.equal(byRole.system?.count, 1);
  assert.equal(byRole.system?.totalChars, 10);
  assert.equal(byRole.user?.count, 1);
  assert.equal(byRole.user?.totalChars, 20);
  assert.equal(byRole.assistant?.count, 2);
  assert.equal(byRole.assistant?.totalChars, 70);
  assert.equal(byRole.tool?.count, 3);
  assert.equal(byRole.tool?.totalChars, 36);
  assert.equal(profile.systemMessageCount, 1);
  assert.equal(profile.userMessageCount, 1);
  assert.equal(profile.assistantMessageCount, 2);
  assert.equal(profile.toolMessageCount, 3);
  assert.equal(profile.messageCount, 7);
});

test("Test 2 — tools vs messages serialized separately", () => {
  const messages = [
    { role: "system", content: "system-only" },
    { role: "user", content: "user-only" },
  ];
  const profile = profileRequestMessages(messages, 1, SAMPLE_TOOLS);
  const messageChars = JSON.stringify(messages).length;
  const toolChars = JSON.stringify(SAMPLE_TOOLS).length;

  assert.equal(profile.serializedMessagesChars, messageChars);
  assert.equal(profile.serializedToolsChars, toolChars);
  assert.equal(profile.serializedRequestChars, messageChars);
  assert.notEqual(profile.serializedMessagesChars, profile.serializedToolsChars);
  assert.equal(profile.estimatedMessageTokens, Math.ceil(messageChars / ESTIMATED_CHARS_PER_TOKEN));
  assert.equal(profile.estimatedToolsTokens, Math.ceil(toolChars / ESTIMATED_CHARS_PER_TOKEN));
  assert.equal(
    profile.estimatedTotalInputTokens,
    Math.ceil((messageChars + toolChars) / ESTIMATED_CHARS_PER_TOKEN),
  );
  assert.equal(profile.estimatedInputTokens, profile.estimatedMessageTokens);
  assert.notEqual(profile.estimatedTotalInputTokens, profile.estimatedInputTokens);
});

test("Test 3 — context growth", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    tools: SAMPLE_TOOLS.map((item) => ({
      name: item.function.name,
      description: item.function.description,
      parameters: item.function.parameters,
    })),
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
  const messageChars = calls.map((item) => item.context?.serializedMessagesChars ?? 0);
  const toolChars = calls.map((item) => item.context?.serializedToolsChars ?? 0);
  assert.ok(messageChars[0]! > 0 && messageChars[1]! > messageChars[0]! && messageChars[2]! > messageChars[1]!);
  assert.ok(toolChars[0]! > 0);
  assert.equal(toolChars[0], toolChars[1]);
  assert.equal(toolChars[1], toolChars[2]);
  assert.equal(calls[0]?.context?.toolsFingerprint, calls[2]?.context?.toolsFingerprint);
  assert.notEqual(calls[0]?.context?.messagesFingerprint, calls[2]?.context?.messagesFingerprint);
});

test("Test 4 — tool result contribution without storing content", () => {
  const small = "A".repeat(100);
  const large = "B".repeat(5000);
  const profile = profileRequestMessages(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "ask" },
      assistantTool("c1", "github_get_issue"),
      toolResult("c1", small),
      assistantTool("c2", "github_get_issue_timeline"),
      toolResult("c2", large),
    ],
    5,
  );
  assert.equal(profile.toolResultCount, 2);
  assert.equal(profile.largestToolResultChars, 5000);
  assert.equal(profile.totalToolResultChars, 5100);
  const issue = profile.toolContributions.find((item) => item.toolName === "github_get_issue");
  const timeline = profile.toolContributions.find((item) => item.toolName === "github_get_issue_timeline");
  assert.equal(issue?.invocationCount, 1);
  assert.equal(issue?.totalChars, 100);
  assert.equal(timeline?.largestResultChars, 5000);
  const blob = JSON.stringify(profile);
  assert.equal(blob.includes(small), false);
  assert.equal(blob.includes(large), false);
  assert.equal(blob.includes("ask"), false);
});

test("Test 5 — attempt 1 step 5 is not confused with attempt 2 step 1", async () => {
  let llmCalls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    maxAttempts: 2,
    maxRecoveryAttempts: 1,
    maxSteps: 12,
    investigationActionConstraint: "unconstrained",
    planner: new ContinuePlanner(),
    fetchImpl: async () => {
      llmCalls += 1;
      if (llmCalls <= 4) {
        return legalInvestigationToolResponse(llmCalls, 7, {
          prompt_tokens: 1000 + llmCalls,
          completion_tokens: 10,
          total_tokens: 1010 + llmCalls,
          prompt_tokens_details: { cached_tokens: llmCalls === 5 ? 0 : 100 },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 },
      });
    },
  });

  const fifth = result.llmUsage.calls.find((item) => item.callIndex === 5);
  const sixth = result.llmUsage.calls.find((item) => item.callIndex === 6);
  assert.equal(fifth?.attempt, 1);
  assert.equal(fifth?.agentStep, 5);
  assert.equal(sixth?.attempt, 2);
  assert.equal(sixth?.agentStep, 1);
  assert.notEqual(`${fifth?.attempt}:${fifth?.agentStep}`, `${sixth?.attempt}:${sixth?.agentStep}`);
});

test("Test 6 — fingerprint equality follows request structure", () => {
  const messagesA = [
    { role: "system", content: "stable-system" },
    { role: "user", content: "hello" },
  ];
  const messagesB = [
    { role: "system", content: "stable-system" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "more" },
  ];
  const sameA = profileRequestMessages(messagesA, 1, SAMPLE_TOOLS);
  const sameAAgain = profileRequestMessages(messagesA, 1, SAMPLE_TOOLS);
  const different = profileRequestMessages(messagesB, 2, SAMPLE_TOOLS);
  const sameToolsDifferentMessages = profileRequestMessages(messagesB, 2, SAMPLE_TOOLS);

  assert.equal(sameA.messagesFingerprint, sameAAgain.messagesFingerprint);
  assert.equal(sameA.toolsFingerprint, sameAAgain.toolsFingerprint);
  assert.notEqual(sameA.messagesFingerprint, different.messagesFingerprint);
  assert.equal(sameA.toolsFingerprint, different.toolsFingerprint);
  assert.equal(different.toolsFingerprint, sameToolsDifferentMessages.toolsFingerprint);
  assert.match(sameA.messagesFingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.match(sameA.toolsFingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("Test 7 — Call #4 / Call #5 structural change is observable", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const tools = SAMPLE_TOOLS.map((item) => ({
    name: item.function.name,
    description: item.function.description,
    parameters: item.function.parameters,
  }));
  const usages = [
    {
      prompt_tokens: 7276,
      completion_tokens: 80,
      total_tokens: 7356,
      prompt_tokens_details: { cached_tokens: 4480 },
    },
    {
      prompt_tokens: 8125,
      completion_tokens: 90,
      total_tokens: 8215,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  ];
  let calls = 0;
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    tools,
    usageCollector: collector,
    fetchImpl: async () => {
      const usage = usages[calls] ?? usages[1];
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: "ok" } }], usage });
    },
  });

  const messagesA = [
    { role: "user" as const, content: "prefix-stable" },
    { role: "assistant" as const, content: JSON.stringify({ id: "c1", tool: "github_get_issue", arguments: {} }) },
    {
      role: "tool" as const,
      content: JSON.stringify({ callId: "c1", success: true, output: { n: 1 } }),
    },
  ];
  const messagesC = [
    ...messagesA,
    { role: "assistant" as const, content: JSON.stringify({ id: "c2", tool: "github_get_issue_timeline", arguments: {} }) },
    {
      role: "tool" as const,
      content: JSON.stringify({ callId: "c2", success: true, output: { n: 2 } }),
    },
  ];

  await model.decide({ id: "t", description: "issue" }, messagesA, [], { attempt: 1, agentStep: 4 });
  await model.decide({ id: "t", description: "issue" }, messagesC, [], { attempt: 1, agentStep: 5 });

  const [call4, call5] = collector.getCalls();
  assert.equal(call4?.callIndex, 1);
  assert.equal(call4?.agentStep, 4);
  assert.equal(call4?.usage.inputTokens, 7276);
  assert.equal(call4?.usage.cachedInputTokens, 4480);
  assert.equal(call5?.agentStep, 5);
  assert.equal(call5?.usage.inputTokens, 8125);
  assert.equal(call5?.usage.cachedInputTokens, 0);

  const delta = contextFingerprintDelta(call4!.context!, call5!.context!);
  assert.equal(delta.messagesChanged, true);
  assert.equal(delta.toolsChanged, false);
  assert.notEqual(call4?.context?.messagesFingerprint, call5?.context?.messagesFingerprint);
  assert.equal(call4?.context?.toolsFingerprint, call5?.context?.toolsFingerprint);
  assert.ok((call5?.context?.serializedMessagesChars ?? 0) > (call4?.context?.serializedMessagesChars ?? 0));
  assert.equal(call4?.context?.serializedToolsChars, call5?.context?.serializedToolsChars);
});

test("Test 8 — provider usage and local estimate coexist", async () => {
  const collector = new LlmUsageCollector("qwen-plus");
  const model = new OpenAICompatModel({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid/v1",
    model: "qwen-plus",
    tools: SAMPLE_TOOLS.map((item) => ({
      name: item.function.name,
      description: item.function.description,
      parameters: item.function.parameters,
    })),
    usageCollector: collector,
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 7276,
          completion_tokens: 40,
          total_tokens: 7316,
          prompt_tokens_details: { cached_tokens: 4480 },
        },
      }),
  });
  await model.decide({ id: "t", description: "hello" }, [{ role: "user", content: "hello" }], [], {
    attempt: 1,
    agentStep: 1,
  });
  const call = collector.getCalls()[0];
  assert.equal(call?.usage.inputTokens, 7276);
  assert.equal(call?.usage.cachedInputTokens, 4480);
  assert.equal(call?.usage.outputTokens, 40);
  assert.equal(call?.usage.totalTokens, 7316);
  assert.equal(typeof call?.context?.serializedMessagesChars, "number");
  assert.equal(typeof call?.context?.serializedToolsChars, "number");
  assert.equal(typeof call?.estimatedInputTokens, "number");
  assert.equal(typeof call?.context?.estimatedTotalInputTokens, "number");
  assert.notEqual(call?.estimatedInputTokens, call?.usage.inputTokens);
  assert.equal(call?.context?.estimatedInputTokens, call?.estimatedInputTokens);
  const trace = llmCallTraceData(call!);
  assert.equal((trace.usage as { inputTokens: number }).inputTokens, 7276);
  assert.equal((trace.context as { serializedMessagesChars: number }).serializedMessagesChars, call?.context?.serializedMessagesChars);
  assert.equal("messages" in trace, false);
  assert.equal("prompt" in trace, false);
});

test("Test 9 — Phase 8.7.4 safety still holds", async () => {
  let httpCalls = 0;
  const budgeted = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    maxAttempts: 1,
    maxSteps: 12,
    investigationActionConstraint: "unconstrained",
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 120_000 },
    fetchImpl: async (_input, init) => {
      httpCalls += 1;
      assert.ok(init?.signal);
      return legalInvestigationToolResponse(httpCalls, 42, {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      });
    },
  });
  assert.equal(DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls, 8);
  assert.equal(DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs, 120_000);
  assert.equal(httpCalls, 8);
  assert.equal(budgeted.llmUsage.llmCalls, 8);
  assert.equal(budgeted.run.attempts.at(-1)?.failure?.errorCode, "LLM_CALL_BUDGET_EXCEEDED");

  const timedOut = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    env: LIVE_ENV,
    fetchImpl: hangingFetch,
    llmRuntimeBudget: { maxLlmCalls: 8, maxWallClockMs: 80 },
    maxAttempts: 1,
  });
  assert.equal(timedOut.llmUsage.calls[0]?.errorCategory, "runtime_timeout");
  assert.equal(timedOut.run.attempts.at(-1)?.failure?.type, "runtime_budget_exceeded");
});

test("Test 10 — Snapshot C01 keeps null token fields", async () => {
  const session = await runInvestigation({ caseId: "C01" });
  assert.equal(session.actor, "test_driver");
  assert.equal(session.llmUsage?.llmCalls, 0);
  assert.equal(session.llmUsage?.totalInputTokens, null);
  assert.equal(session.llmUsage?.totalCachedInputTokens, null);
  assert.equal(session.llmUsage?.totalOutputTokens, null);
  assert.equal(session.llmUsage?.totalTokens, null);
  assert.equal(session.llmUsage?.overallCacheHitRate, null);
  assert.equal(session.llmUsage?.calls.length, 0);
  assert.equal(session.llmUsage?.profilingSummary.includes("Input tokens: 0"), false);
  assert.equal(session.llmUsage?.profilingSummary.includes("Cached input tokens: 0"), false);
});

test("Test 11 — snapshot and fake investigation leave no secrets in context profile", async () => {
  const apiKey = "sk-live-OPENAI_API_KEY-secret-value";
  const trace = new TraceCollector();
  let llmCalls = 0;
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
                      arguments: JSON.stringify({ owner: "acme", repo: "box", issueNumber: 42 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 8,
            total_tokens: 88,
            prompt_tokens_details: { cached_tokens: 16 },
          },
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        usage: {
          prompt_tokens: 90,
          completion_tokens: 8,
          total_tokens: 98,
          prompt_tokens_details: { cached_tokens: 16 },
        },
      });
    },
  });
  const completed = trace.getEvents().find((event) => event.type === "model_call_completed");
  const blob = JSON.stringify({
    usage: result.llmUsage,
    summary: formatLlmProfilingSummary(result.llmUsage),
    completed: completed?.data,
  });
  assert.equal(blob.includes(apiKey), false);
  assert.equal(blob.includes(INVESTIGATION_SYSTEM_PROMPT), false);
  assert.equal(/Authorization/i.test(blob), false);
  assert.equal(typeof (completed?.data.context as { messagesFingerprint?: string } | undefined)?.messagesFingerprint, "string");
  assert.ok((result.llmUsage.calls[0]?.context?.serializedToolsChars ?? 0) > 0);
  const firstContributor = largestContextContributor(result.llmUsage.calls[0]!.context!);
  assert.ok(["tools_schema", "system", "user", "tool"].includes(firstContributor));
});
