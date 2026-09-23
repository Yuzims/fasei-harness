import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationStreamEvent } from "../src/api/dto.ts";
import {
  applyLiveStreamEvent,
  emptyLiveStreamState,
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
    phase: "agent",
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
    frame({ type: "evidence_added", step: 2, phase: "agent", summary: "获得Commit证据" });
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

test("Stream：prescan_completed 校验要求 lines 字符串数组", () => {
  assert.equal(
    isInvestigationStreamEvent({
      type: "prescan_completed",
      step: 1,
      phase: "prescan",
      state: "completed",
      summary: "0 次 AI 调用",
      lines: ["读取 Issue 正文与评论"],
    }),
    true,
  );
  assert.equal(
    isInvestigationStreamEvent({
      type: "prescan_completed",
      step: 1,
      summary: "0 次 AI 调用",
      lines: [404],
    }),
    false,
  );
  assert.equal(
    isInvestigationStreamEvent({ type: "prescan_completed", step: 1, summary: "x" }),
    false,
  );
});

test("Stream：tool_call 先进入进行中，tool_result 收敛同一行状态", () => {
  let state = applyLiveStreamEvent(emptyLiveStreamState(), {
    type: "investigation_started",
    step: 0,
    timestamp: 1,
  });
  assert.equal(state.startedAtMs, 1);
  state = applyLiveStreamEvent(state, {
    type: "tool_call",
    step: 1,
    phase: "agent",
    tool: "github_get_issue",
    summary: "正在获取 Issue…",
  });
  assert.equal(state.items.at(-1)?.state, "active");
  state = applyLiveStreamEvent(state, {
    type: "tool_result",
    step: 1,
    phase: "agent",
    tool: "github_get_issue",
    success: true,
    summary: "工具调用完成",
  });
  assert.equal(state.items.at(-1)?.state, "pass");
  assert.equal(state.items.at(-1)?.label, "正在获取 Issue…");
});

test("Stream：tool_result 的非通用小结追加到同一行", () => {
  let state = applyLiveStreamEvent(emptyLiveStreamState(), {
    type: "tool_call",
    step: 1,
    phase: "agent",
    tool: "github_get_pull_request_files",
    summary: "正在查看 PR 文件变更 · PR #37626…",
  });
  state = applyLiveStreamEvent(state, {
    type: "tool_result",
    step: 1,
    phase: "agent",
    tool: "github_get_pull_request_files",
    success: true,
    summary: "4 项结果",
  });
  assert.equal(
    state.items.at(-1)?.label,
    "正在查看 PR 文件变更 · PR #37626… · 4 项结果",
  );
  assert.equal(state.items.at(-1)?.state, "pass");
});

test("Stream：agent_step 只计思考步数；证据/验证/恢复事件按服务端 summary 展示", () => {
  let state = applyLiveStreamEvent(emptyLiveStreamState(), {
    type: "agent_step",
    step: 1,
    phase: "agent",
    summary: "规划下一步调查",
  });
  assert.equal(state.items.length, 0);
  assert.equal(state.thoughtSteps, 1);
  state = applyLiveStreamEvent(state, {
    type: "evidence_added",
    step: 2,
    phase: "agent",
    summary: "获得Commit证据",
  });
  assert.equal(state.items.at(-1)?.label, "获得Commit证据");
  state = applyLiveStreamEvent(state, {
    type: "verification_started",
    step: 3,
    phase: "verification",
    summary: "开始独立验证",
  });
  state = applyLiveStreamEvent(state, {
    type: "verification_check",
    step: 3,
    phase: "verification",
    summary: "检查 Issue 身份：pass",
    status: "pass",
  });
  state = applyLiveStreamEvent(state, {
    type: "verification_completed",
    step: 3,
    phase: "verification",
    status: "verified_complete",
    summary: "独立验证完成：verified_complete",
  });
  const verify = state.items.find((item) => item.id === "verify-3");
  assert.equal(verify?.state, "pass");
  assert.equal(verify?.phase, "verification");
  state = applyLiveStreamEvent(state, {
    type: "failure",
    step: 4,
    phase: "agent",
    summary: "工具调用失败",
  });
  assert.equal(state.items.at(-1)?.state, "fail");
  assert.equal(state.items.at(-1)?.phase, "agent");
  state = applyLiveStreamEvent(state, {
    type: "recovery",
    step: 4,
    phase: "agent",
    summary: "稍后重试失败的工具调用",
  });
  assert.equal(state.items.at(-1)?.state, "warn");
});

test("Stream：预扫描事件归入 prescan 阶段，prescan_completed 折叠为头行 + 聚合明细", () => {
  let state = applyLiveStreamEvent(emptyLiveStreamState(), {
    type: "evidence_added",
    step: 1,
    phase: "prescan",
    summary: "获得PR #37626 详情证据",
  });
  assert.equal(state.items.at(-1)?.phase, "prescan");
  state = applyLiveStreamEvent(state, {
    type: "prescan_completed",
    step: 2,
    phase: "prescan",
    state: "completed",
    summary: "0 次 AI 调用 · 找到 1 个相关 PR · 全部核对",
    lines: ["读取 Issue 正文与评论，提取被引用的编号 → 找到相关 PR #37626"],
  });
  const head = state.items.find((item) => item.kind === "head");
  assert.ok(head);
  assert.equal(head.label, "0 次 AI 调用 · 找到 1 个相关 PR · 全部核对");
  assert.equal(head.phase, "prescan");
  const aggs = state.items.filter((item) => item.kind === "agg");
  assert.equal(aggs.length, 1);
  assert.match(aggs[0].label, /找到相关 PR #37626/);
  // 原始明细行保留（面板将其收进「点击展开 N 条明细」）。
  assert.equal(state.items.filter((item) => item.phase === "prescan" && !item.kind).length, 1);
});

test("Stream：done / error 不改变实时行（终态由调用方对照最终 DTO 处理）", () => {
  const state = applyLiveStreamEvent(emptyLiveStreamState(), {
    type: "investigation_started",
    step: 0,
    timestamp: 1,
  });
  const before = structuredClone(state);
  assert.deepEqual(
    applyLiveStreamEvent(state, {
      type: "done",
      session: {} as never,
    } satisfies InvestigationStreamEvent),
    before,
  );
  assert.deepEqual(
    applyLiveStreamEvent(state, { type: "error", message: "boom" } satisfies InvestigationStreamEvent),
    before,
  );
});
