import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app.js";
import {
  createInvestigationStreamProjector,
  streamInvestigation,
} from "../src/server/investigation-stream.js";
import { TraceCollector, type TraceEvent } from "../src/trace/trace-collector.js";
import type { InvestigationSessionDTO, InvestigationStreamEvent } from "../src/api/dto.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseEvents(text: string): InvestigationStreamEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const payload = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!payload) {
        return [];
      }
      try {
        return [JSON.parse(payload) as InvestigationStreamEvent];
      } catch {
        return [];
      }
    });
}

function eventTypes(events: InvestigationStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

function traceEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    id: "t-1",
    runId: "run-1",
    step: 1,
    timestamp: 1_700_000_000_000,
    type: "agent_step",
    data: {},
    ...overrides,
  };
}

const app = createApp({});

test("SSE：snapshot C01 通过 /api/investigations/stream 推送完整过程事件", async () => {
  const res = await app.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "C01" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseEvents(await res.text());
  const types = eventTypes(events);
  assert.equal(types[0], "investigation_started");
  assert.ok(types.includes("tool_call"), "must include tool_call events");
  assert.ok(types.includes("tool_result"), "must include tool_result events");
  assert.ok(types.includes("evidence_added"), "must include evidence_added events");
  assert.ok(types.includes("verification_started"), "must include verification_started");
  assert.ok(types.includes("verification_check"), "must include verification_check");
  assert.ok(types.includes("verification_completed"), "must include verification_completed");
  assert.ok(types.includes("investigation_completed"), "must include investigation_completed");
  assert.equal(types.at(-1), "done");
  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  const session = done.session as InvestigationSessionDTO;
  assert.equal(session.mode, "snapshot");
  assert.equal(session.catalogId, "C01");
  assert.equal(session.verification?.status, "verified_complete");
  // SSE 与最终 DTO 一致：verification_completed 状态来自同一个 Verifier 结果。
  const lastVerdict = [...events].reverse().find((event) => event.type === "verification_completed");
  assert.ok(lastVerdict && lastVerdict.type === "verification_completed");
  assert.equal(lastVerdict.status, session.verification?.status);
});

test("SSE：恢复场景推送 failure 与 recovery 过程事件", async () => {
  const res = await app.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "tool-failure" }),
  });
  assert.equal(res.status, 200);
  const types = eventTypes(sseEvents(await res.text()));
  assert.ok(types.includes("failure"), "must include failure event");
  assert.ok(types.includes("recovery"), "must include recovery event");
  assert.equal(types.at(-1), "done");
});

test("SSE：真流式 —— investigation_started 在 Investigation 完成前已送达浏览器", async () => {
  let firstChatResolved = false;
  let releaseFirstChat: () => void = () => {};
  const firstChatGate = new Promise<void>((resolve) => {
    releaseFirstChat = resolve;
  });
  let chatCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      chatCalls += 1;
      if (chatCalls === 1) {
        await firstChatGate;
        firstChatResolved = true;
        return jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "github_list_commits",
                      arguments: JSON.stringify({ owner: "acme", repo: "demo" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ message: { content: "Investigation done; I do not claim completion." } }],
      });
    }
    const path = new URL(url).pathname;
    if (path === "/repos/acme/demo/issues/123") {
      return jsonResponse({
        number: 123,
        title: "Streaming issue",
        body: "body",
        state: "closed",
        html_url: "https://github.com/acme/demo/issues/123",
      });
    }
    if (
      path === "/repos/acme/demo/issues/123/comments" ||
      path === "/repos/acme/demo/issues/123/timeline" ||
      path === "/repos/acme/demo/commits"
    ) {
      return jsonResponse([]);
    }
    return jsonResponse({ message: "Not Found" }, 404);
  };
  const live = createApp(
    {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
      OPENAI_BASE_URL: "https://llm.test/v1",
    },
    { fetchImpl },
  );
  const res = await live.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "acme/demo#123", mode: "live" }),
  });
  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  assert.ok(reader, "response body must be readable");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  // 关键断言：Investigation 仍在运行时（首个 LLM 请求被 gate 挂起，done 不可能出现），
  // SSE 已把 investigation_started 送到浏览器。Phase 18-A prescan 运行在首次 chat 之前，
  // 所以不再要求收到帧时 chat 已经开始，只要求 gate 未放行前绝无 done。
  while (!text.includes("investigation_started")) {
    assert.ok(Date.now() < deadline, "timed out waiting for live SSE frames");
    const { done, value } = await reader.read();
    assert.equal(done, false, "stream ended before investigation_started was delivered");
    text += decoder.decode(value, { stream: true });
  }
  assert.equal(firstChatResolved, false, "done must not have been produced yet");
  assert.ok(!text.includes('"type":"done"'), "done must not arrive before the chat gate releases");
  releaseFirstChat();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    if (text.includes('"type":"done"')) {
      break;
    }
  }
  const events = sseEvents(text);
  const types = eventTypes(events);
  assert.equal(types[0], "investigation_started");
  assert.ok(types.includes("tool_call"));
  assert.ok(types.includes("evidence_added"));
  assert.equal(types.at(-1), "done");
  const doneEvent = events.at(-1);
  assert.ok(doneEvent && doneEvent.type === "done");
  assert.equal(doneEvent.session.mode, "live");
  assert.equal(doneEvent.session.actor, "llm");
});

test("SSE：Investigation 异常只发 error，绝不伪造 done / investigation_completed", async () => {
  const res = await app.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "no-such-case" }),
  });
  assert.equal(res.status, 200);
  const events = sseEvents(await res.text());
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  const text = JSON.stringify(events);
  assert.equal(text.includes("done"), false, "no done event may follow an error");
  assert.equal(text.includes("investigation_completed"), false);
  assert.equal(text.includes("verified_complete"), false);
});

test("SSE：live GitHub 429 以 error 结束，不产出最终结果", async () => {
  const live = createApp(
    {},
    {
      fetchImpl: async () =>
        new Response("API rate limit exceeded", { status: 429, headers: { "retry-after": "60" } }),
    },
  );
  const res = await live.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "acme/demo#1", mode: "live" }),
  });
  assert.equal(res.status, 200);
  const events = sseEvents(await res.text());
  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
  assert.equal(events[0]?.type === "error" && /rate limit/i.test(events[0].message), true);
});

test("SSE：非法 JSON body 在建立流之前返回 400", async () => {
  const res = await app.request("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-json",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_REQUEST");
});

test("Projection：内部 trace 的 payload 不会越过 public 事件边界", () => {
  const project = createInvestigationStreamProjector();
  const outputs: (InvestigationStreamEvent | null)[] = [
    project(traceEvent({ type: "model_call", data: { messages: ["PROMPT-PAYLOAD"], system: "SYSTEM-PAYLOAD" } })),
    project(traceEvent({ type: "run_started", data: { description: "RUN-PAYLOAD" } })),
    project(traceEvent({ type: "attempt_started", data: { attempt: 1 } })),
    project(
      traceEvent({
        type: "agent_step",
        data: {
          tool: "github_get_issue",
          reason: "THOUGHT-PAYLOAD because I said so",
          arguments: { owner: "ARGS-PAYLOAD" },
          legalTools: ["github_get_issue"],
        },
      }),
    ),
    project(traceEvent({ type: "tool_call", data: { tool: "github_get_commit", arguments: { sha: "ARGS-PAYLOAD" } } })),
    project(traceEvent({ type: "tool_result", data: { success: true, output: "OUTPUT-PAYLOAD", error: undefined } })),
    project(
      traceEvent({
        type: "evidence_added",
        data: { evidenceId: "EV-ID-PAYLOAD", kind: "commit", summary: "EVIDENCE-SUMMARY-PAYLOAD", provenance: { url: "URL-PAYLOAD" } },
      }),
    ),
    project(traceEvent({ type: "claim_created", data: { text: "CLAIM-TEXT-PAYLOAD" } })),
    project(
      traceEvent({
        type: "verification_check",
        data: { id: "pr-merged", name: "resolution landed", status: "pass", message: "CHECK-MESSAGE-PAYLOAD" },
      }),
    ),
    project(
      traceEvent({
        type: "investigation_completed",
        data: { status: "completed", notice: "NOTICE-PAYLOAD", evidenceIds: ["EV-ID-PAYLOAD"], claimIds: ["CLAIM-ID-PAYLOAD"] },
      }),
    ),
    project(traceEvent({ type: "failure_analyzed", data: { primary: "tool_failure", reason: "FAILURE-REASON-PAYLOAD" } })),
    project(traceEvent({ type: "recovery_planned", data: { action: "retry_with_backoff", reason: "RECOVERY-REASON-PAYLOAD" } })),
  ];
  const serialized = JSON.stringify(outputs.filter((item) => item !== null));
  for (const forbidden of [
    "PROMPT-PAYLOAD",
    "SYSTEM-PAYLOAD",
    "RUN-PAYLOAD",
    "THOUGHT-PAYLOAD",
    "ARGS-PAYLOAD",
    "OUTPUT-PAYLOAD",
    "EVIDENCE-SUMMARY-PAYLOAD",
    "EV-ID-PAYLOAD",
    "URL-PAYLOAD",
    "CLAIM-TEXT-PAYLOAD",
    "CLAIM-ID-PAYLOAD",
    "CHECK-MESSAGE-PAYLOAD",
    "NOTICE-PAYLOAD",
    "FAILURE-REASON-PAYLOAD",
    "RECOVERY-REASON-PAYLOAD",
    "legalTools",
    "messages",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public events must not leak ${forbidden}`);
  }
  // model_call / run_started / attempt_started / claim_created 没有安全投影：不发送。
  assert.equal(outputs[0], null);
  assert.equal(outputs[1], null);
  assert.equal(outputs[2], null);
  assert.equal(outputs[7], null, "claim_created must not project");
});

test("Projection：verification 与最终状态只透传 Verifier 结论字段", () => {
  const project = createInvestigationStreamProjector();
  const started = project(traceEvent({ type: "verification_started", data: { evidenceCount: 3 } }));
  assert.ok(started && started.type === "verification_started");
  const check = project(
    traceEvent({ type: "verification_check", data: { id: "issue-identity", status: "pass" } }),
  );
  assert.ok(check && check.type === "verification_check" && check.status === "pass");
  const completed = project(
    traceEvent({ type: "verification_completed", data: { status: "verified_complete", evidenceCoverage: 1 } }),
  );
  assert.ok(completed && completed.type === "verification_completed");
  assert.equal(completed.status, "verified_complete");
  const tool = project(traceEvent({ type: "tool_call", data: { tool: "github_get_issue" } }));
  assert.ok(tool && tool.type === "tool_call" && tool.tool === "github_get_issue");
  assert.match(tool.summary, /^正在/);
  const result = project(traceEvent({ type: "tool_result", data: { success: false } }));
  assert.ok(result && result.type === "tool_result" && result.success === false);
  assert.equal(result.tool, "github_get_issue", "tool_result inherits the last projected tool call");
});

test("streamInvestigation：TraceCollector → 投影 → emit，done 携带最终 InvestigationSessionDTO", async () => {
  const collected: InvestigationStreamEvent[] = [];
  await streamInvestigation({ caseId: "C01" }, (event) => collected.push(event), {});
  const types = eventTypes(collected);
  assert.equal(types[0], "investigation_started");
  assert.equal(types.at(-1), "done");
  const doneEvent = collected.at(-1);
  assert.ok(doneEvent && doneEvent.type === "done");
  assert.equal(doneEvent.session.verification?.status, "verified_complete");
  const completed = collected.find((event) => event.type === "investigation_completed");
  assert.ok(completed && completed.type === "investigation_completed");
  assert.equal(completed.status, doneEvent.session.status);
});
