import assert from "node:assert/strict";
import test from "node:test";
import { createModel } from "../src/agent/create-model.js";
import { describeLlm, readLlmConfig } from "../src/agent/llm-config.js";
import { MockModel } from "../src/agent/mock-model.js";
import {
  OpenAICompatModel,
  buildChatMessages,
  parseChatCompletion,
} from "../src/agent/openai-compat-model.js";

test("默认没有 Key 时走 mock", () => {
  const config = readLlmConfig({});
  assert.equal(config.kind, "mock");
  assert.equal(createModel({ env: {} }) instanceof MockModel, true);
});

test("只有 OPENAI_API_KEY 时工作台走 openai", () => {
  const config = readLlmConfig({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini" });
  assert.equal(config.kind, "openai");
  assert.equal(config.model, "gpt-4o-mini");
});

test("AGENT_MODEL=mock 即使有 Key 也不走真模型", () => {
  const config = readLlmConfig({
    AGENT_MODEL: "mock",
    OPENAI_API_KEY: "sk-test",
  });
  assert.equal(config.kind, "mock");
});

test("describeLlm 缺 Key 时不抛错", () => {
  const status = describeLlm({});
  assert.equal(status.kind, "mock");
  assert.match(status.hint, /OPENAI_API_KEY/);
});

test("AGENT_MODEL=openai 且没有 Key 时直接报错", () => {
  assert.throws(
    () => readLlmConfig({ AGENT_MODEL: "openai" }),
    /OPENAI_API_KEY/,
  );
});

test("parseChatCompletion：tool_call", () => {
  const response = parseChatCompletion({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "calculator",
                arguments: '{"expression":"123 * 456"}',
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(response.type, "tool_call");
  if (response.type === "tool_call") {
    assert.equal(response.call.name, "calculator");
    assert.equal(response.call.arguments.expression, "123 * 456");
  }
});

test("parseChatCompletion：final text", () => {
  const response = parseChatCompletion({
    choices: [{ message: { content: "计算完成：56088" } }],
  });
  assert.equal(response.type, "final");
  if (response.type === "final") {
    assert.match(response.message, /56088/);
  }
});

test("parseChatCompletion：结构化 final 携带 claims 进入 ModelResponse.claims", () => {
  const response = parseChatCompletion({
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "Issue #42 was resolved by PR #123.",
            claims: [
              {
                text: "Issue #42 was resolved by PR #123.",
                polarity: "resolved",
                critical: true,
                evidenceIds: ["ev-issue", "ev-pr"],
                role: "supports",
              },
            ],
          }),
        },
      },
    ],
  });
  assert.equal(response.type, "final");
  if (response.type === "final") {
    assert.equal(response.message, "Issue #42 was resolved by PR #123.");
    assert.equal(response.claims?.length, 1);
    assert.equal(response.claims?.[0]?.text, "Issue #42 was resolved by PR #123.");
    assert.equal(response.claims?.[0]?.polarity, "resolved");
    assert.deepEqual(response.claims?.[0]?.evidenceIds, ["ev-issue", "ev-pr"]);
  }
});

test("parseChatCompletion：纯文本 final 不被解析成 claims", () => {
  const response = parseChatCompletion({
    choices: [
      {
        message: {
          content: "PR #123 was merged and closes the issue, so it is fixed.",
        },
      },
    ],
  });
  assert.equal(response.type, "final");
  if (response.type === "final") {
    assert.equal(response.claims, undefined);
    assert.match(response.message, /closes the issue/);
  }
});

test("buildChatMessages：把 loop 的 tool 历史还原成 OpenAI tool 协议", () => {
  const messages = buildChatMessages(
    { id: "t", description: "算一下" },
    [
      { role: "user", content: "算一下" },
      {
        role: "assistant",
        content: JSON.stringify({
          id: "c1",
          tool: "calculator",
          arguments: { expression: "1+1" },
        }),
      },
      {
        role: "tool",
        content: JSON.stringify({ callId: "c1", success: true, output: 2 }),
      },
    ],
    { attempt: 1 },
  );
  const assistant = messages.find((item) => item.tool_calls?.length);
  const tool = messages.find((item) => item.role === "tool");
  assert.equal(assistant?.tool_calls?.[0]?.id, "c1");
  assert.equal(assistant?.tool_calls?.[0]?.function.name, "calculator");
  assert.equal(tool?.tool_call_id, "c1");
});

test("buildChatMessages：带上失败上下文，不把 recovery.action 写成指令", () => {
  const messages = buildChatMessages(
    { id: "t", description: "算一下" },
    [{ role: "user", content: "算一下" }],
    {
      attempt: 2,
      lastFailure: {
        type: "premature_completion",
        rootCause: "agent_claimed_success_but_outcome_unmet",
        evidence: [],
      },
    },
  );
  const last = messages.at(-1)?.content ?? "";
  assert.match(last, /premature_completion/);
  assert.equal(last.includes("continue_execution"), false);
});

test("OpenAICompatModel：用注入的 fetch，不打真实网络", async () => {
  const model = new OpenAICompatModel({
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    model: "gpt-test",
    tools: [{ name: "calculator", description: "math" }],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "calculator",
                      arguments: '{"expression":"1 + 1"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const response = await model.decide(
    { id: "t", description: "1 + 1" },
    [{ role: "user", content: "1 + 1" }],
    [],
  );
  assert.equal(response.type, "tool_call");
});

test("createModel：openai 配置走 OpenAICompatModel", () => {
  const model = createModel({
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-4o-mini",
    },
  });
  assert.equal(model instanceof OpenAICompatModel, true);
});
