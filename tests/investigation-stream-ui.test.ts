import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationStreamEvent } from "../src/api/dto.ts";
import {
  applyLiveStreamEvent,
  isInvestigationStreamEvent,
  parseSseFrames,
} from "../web/src/lib/investigation-stream.ts";

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

test("Stream：SSE 帧解析支持分块到达与残留缓冲", () => {
  const first = { type: "investigation_started", step: 0, timestamp: 1 };
  const secondPayload = JSON.stringify({
    type: "agent_step",
    step: 1,
    summary: "规划下一步调查",
  });
  const split = 12;
  const parsed = parseSseFrames(
    `${frame(first)}data: ${secondPayload.slice(0, split)}`,
    isInvestigationStreamEvent,
  );
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ["investigation_started"],
  );
  assert.match(parsed.rest, /^data: /);
  const rest = parseSseFrames(
    `${parsed.rest}${secondPayload.slice(split)}\n\n`,
    isInvestigationStreamEvent,
  );
  assert.deepEqual(
    rest.events.map((event) => event.type),
    ["agent_step"],
  );
});

test("Stream：坏帧与非事件 JSON 被丢弃，不打断解析", () => {
  const text =
    'data: {"type":"not-a-real-event"}\n\n' +
    "data: not-json\n\n" +
    ":\n\n" +
    frame({ type: "evidence_added", step: 2, summary: "获得Commit证据" });
  const parsed = parseSseFrames(text, isInvestigationStreamEvent);
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ["evidence_added"],
  );
});

test("Stream：done 校验要求 session 对象，error 校验要求 message", () => {
  assert.equal(isInvestigationStreamEvent({ type: "done", session: { mode: "live" } }), true);
  assert.equal(isInvestigationStreamEvent({ type: "done" }), false);
  assert.equal(isInvestigationStreamEvent({ type: "error", message: "boom" }), true);
  assert.equal(isInvestigationStreamEvent({ type: "error" }), false);
  assert.equal(isInvestigationStreamEvent({ type: "tool_call", step: 1 }), false);
  assert.equal(isInvestigationStreamEvent(null), false);
});

test("Stream：tool_call 先进入进行中，tool_result 收敛同一行状态", () => {
  let items = applyLiveStreamEvent([], {
    type: "investigation_started",
    step: 0,
    timestamp: 1,
  });
  items = applyLiveStreamEvent(items, {
    type: "tool_call",
    step: 1,
    tool: "github_get_issue",
    summary: "正在获取 Issue…",
  });
  assert.equal(items.at(-1)?.state, "active");
  items = applyLiveStreamEvent(items, {
    type: "tool_result",
    step: 1,
    tool: "github_get_issue",
    success: true,
    summary: "工具调用完成",
  });
  assert.equal(items.at(-1)?.state, "pass");
  assert.equal(items.at(-1)?.label, "正在获取 Issue…");
});

test("Stream：agent_step 不单独成行；证据/验证/恢复事件按服务端 summary 展示", () => {
  let items = applyLiveStreamEvent([], {
    type: "agent_step",
    step: 1,
    summary: "规划下一步调查",
  });
  assert.equal(items.length, 0);
  items = applyLiveStreamEvent(items, { type: "evidence_added", step: 2, summary: "获得Commit证据" });
  assert.equal(items.at(-1)?.label, "获得Commit证据");
  items = applyLiveStreamEvent(items, { type: "verification_started", step: 3, summary: "开始独立验证" });
  items = applyLiveStreamEvent(items, {
    type: "verification_check",
    step: 3,
    summary: "检查 Issue 身份：pass",
    status: "pass",
  });
  items = applyLiveStreamEvent(items, {
    type: "verification_completed",
    step: 3,
    status: "verified_complete",
    summary: "独立验证完成：verified_complete",
  });
  const verify = items.find((item) => item.id === "verify-3");
  assert.equal(verify?.state, "pass");
  items = applyLiveStreamEvent(items, { type: "failure", step: 4, summary: "工具调用失败" });
  assert.equal(items.at(-1)?.state, "fail");
  items = applyLiveStreamEvent(items, { type: "recovery", step: 4, summary: "稍后重试失败的工具调用" });
  assert.equal(items.at(-1)?.state, "warn");
});

test("Stream：done / error 不改变实时行（终态由调用方对照最终 DTO 处理）", () => {
  const items = applyLiveStreamEvent([], {
    type: "investigation_started",
    step: 0,
    timestamp: 1,
  });
  const before = [...items];
  assert.deepEqual(
    applyLiveStreamEvent(items, {
      type: "done",
      session: {} as never,
    } satisfies InvestigationStreamEvent),
    before,
  );
  assert.deepEqual(
    applyLiveStreamEvent(items, { type: "error", message: "boom" } satisfies InvestigationStreamEvent),
    before,
  );
});
