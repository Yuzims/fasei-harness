import type { InvestigationStreamEvent } from "@dto";

const EVENT_TYPES = new Set([
  "investigation_started",
  "agent_step",
  "tool_call",
  "tool_result",
  "evidence_added",
  "verification_started",
  "verification_check",
  "verification_completed",
  "failure",
  "recovery",
  "investigation_completed",
  "done",
  "error",
]);

export function isInvestigationStreamEvent(value: unknown): value is InvestigationStreamEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) {
    return false;
  }
  if (event.type === "done") {
    return Boolean(event.session) && typeof event.session === "object";
  }
  if (event.type === "error") {
    return typeof event.message === "string";
  }
  if (typeof event.step !== "number") {
    return false;
  }
  switch (event.type) {
    case "investigation_started":
      return typeof event.timestamp === "number";
    case "tool_call":
      return typeof event.summary === "string" && typeof event.tool === "string";
    case "tool_result":
      return typeof event.success === "boolean" && typeof event.summary === "string";
    case "verification_check":
    case "verification_completed":
      return typeof event.status === "string";
    case "verification_started":
      return true;
    default:
      return typeof event.summary === "string";
  }
}

/**
 * Incremental SSE frame parser: complete frames (terminated by a blank line) are
 * decoded and validated; the trailing partial frame is returned for the next chunk.
 */
export function parseSseFrames<T>(
  buffer: string,
  validate: (value: unknown) => value is T,
): { events: T[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: T[] = [];
  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
      continue;
    }
    const payload = dataLines.join("\n");
    if (!payload) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(payload);
      if (validate(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Malformed frames are dropped; the final DTO stays the source of truth.
    }
  }
  return { events, rest };
}

export type LiveItemState = "active" | "pass" | "fail" | "warn";

export interface LiveProcessItem {
  id: string;
  label: string;
  state: LiveItemState;
}

function settleLast(items: LiveProcessItem[], idPrefix: string, state: LiveItemState): LiveProcessItem[] {
  const next = [...items];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].state === "active" && next[index].id.startsWith(idPrefix)) {
      next[index] = { ...next[index], state };
      break;
    }
  }
  return next;
}

function checkState(status: string): LiveItemState {
  if (status === "pass") {
    return "pass";
  }
  if (status === "fail") {
    return "fail";
  }
  return "warn";
}

/**
 * Reduces public SSE process events into presentation rows for the live panel.
 * Labels come verbatim from server-side projections; the client never re-interprets
 * runtime semantics. `done` / `error` are handled by the caller against the final DTO.
 */
export function applyLiveStreamEvent(
  items: LiveProcessItem[],
  event: InvestigationStreamEvent,
): LiveProcessItem[] {
  switch (event.type) {
    case "investigation_started":
      return [...items, { id: `start-${event.step}`, label: "开始调查 Issue", state: "pass" }];
    case "agent_step":
      // The following tool_call carries the user-visible meaning.
      return items;
    case "tool_call":
      return [...items, { id: `tool-${items.length}`, label: event.summary, state: "active" }];
    case "tool_result":
      return settleLast(items, "tool-", event.success ? "pass" : "fail");
    case "evidence_added":
      return [...items, { id: `evidence-${items.length}`, label: event.summary, state: "pass" }];
    case "verification_started":
      return [...items, { id: `verify-${event.step}`, label: "正在进行独立验证……", state: "active" }];
    case "verification_check":
      return [...items, { id: `check-${items.length}`, label: event.summary, state: checkState(event.status) }];
    case "verification_completed":
      return settleLast(
        [...items, { id: `verdict-${event.step}`, label: event.summary, state: "pass" }],
        "verify-",
        event.status === "verified_complete" ? "pass" : "warn",
      );
    case "failure":
      return [...items, { id: `failure-${items.length}`, label: `遇到问题：${event.summary}`, state: "fail" }];
    case "recovery":
      return [...items, { id: `recovery-${items.length}`, label: `恢复策略：${event.summary}`, state: "warn" }];
    case "investigation_completed":
      return [...items, { id: `completed-${event.step}`, label: event.summary, state: "pass" }];
    default:
      return items;
  }
}
