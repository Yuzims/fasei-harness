import type { InvestigationStreamEvent, LiveEventPhase } from "@dto";

const EVENT_TYPES = new Set([
  "investigation_started",
  "prescan_completed",
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
    case "prescan_completed":
      return (
        typeof event.summary === "string" &&
        Array.isArray(event.lines) &&
        event.lines.every((line) => typeof line === "string")
      );
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
  phase: LiveEventPhase;
  /** "head" = completed-phase summary row; "agg" = fixed-template aggregate line. */
  kind?: "head" | "agg";
  /** Phase 19-B F2: display-only aggregation of consecutive identical rows (≥2). */
  count?: number;
}

export interface LiveStreamState {
  items: LiveProcessItem[];
  startedAtMs?: number;
  maxLlmCalls?: number;
  thoughtSteps: number;
}

export function emptyLiveStreamState(): LiveStreamState {
  return { items: [], thoughtSteps: 0 };
}

const GENERIC_TOOL_RESULTS = new Set(["工具调用完成", "工具调用未成功"]);

function settleLastActive(
  items: LiveProcessItem[],
  phase: LiveEventPhase,
  idPrefix: string,
  state: LiveItemState,
  appendLabel?: string,
): LiveProcessItem[] {
  const next = [...items];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index];
    if (item.state === "active" && item.phase === phase && item.id.startsWith(idPrefix)) {
      next[index] = {
        ...item,
        state,
        label: appendLabel ? `${item.label} · ${appendLabel}` : item.label,
      };
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
 * F2 pure display-layer aggregation: when the row being appended is a settled
 * row identical (phase + label + state) to the current last settled row, bump
 * its count instead of adding a duplicate. Active rows never merge — settle
 * semantics of tool_call/tool_result pairs are untouched.
 */
function appendSettled(items: LiveProcessItem[], item: LiveProcessItem): LiveProcessItem[] {
  const last = items[items.length - 1];
  if (
    last &&
    last.state !== "active" &&
    last.phase === item.phase &&
    last.state === item.state &&
    last.label === item.label
  ) {
    return [...items.slice(0, -1), { ...last, count: (last.count ?? 1) + 1 }];
  }
  return [...items, item];
}

/**
 * Reduces public SSE process events into phase-grouped rows for the live panel.
 * Labels come verbatim from server-side projections; the client never re-interprets
 * runtime semantics. `done` / `error` are handled by the caller against the final DTO.
 */
export function applyLiveStreamEvent(
  state: LiveStreamState,
  event: InvestigationStreamEvent,
): LiveStreamState {
  const { items } = state;
  switch (event.type) {
    case "investigation_started":
      return {
        ...state,
        startedAtMs: event.timestamp,
        maxLlmCalls: event.maxLlmCalls,
      };
    case "prescan_completed":
      return {
        ...state,
        items: [
          ...items,
          {
            id: `prescan-head-${event.step}`,
            label: event.summary,
            state: event.state === "completed" ? "pass" : "warn",
            phase: "prescan",
            kind: "head",
          },
          ...event.lines.map(
            (line, index): LiveProcessItem => ({
              id: `prescan-agg-${event.step}-${index}`,
              label: line,
              state: "pass",
              phase: "prescan",
              kind: "agg",
            }),
          ),
        ],
      };
    case "agent_step":
      return { ...state, thoughtSteps: state.thoughtSteps + 1 };
    case "tool_call":
      return {
        ...state,
        items: [
          ...items,
          { id: `tool-${items.length}`, label: event.summary, state: "active", phase: event.phase },
        ],
      };
    case "tool_result":
      return {
        ...state,
        items: settleLastActive(
          items,
          event.phase,
          "tool-",
          event.success ? "pass" : "fail",
          GENERIC_TOOL_RESULTS.has(event.summary) ? undefined : event.summary,
        ),
      };
    case "evidence_added":
      return {
        ...state,
        items: appendSettled(items, {
          id: `evidence-${items.length}`,
          label: event.summary,
          state: "pass",
          phase: event.phase,
        }),
      };
    case "verification_started":
      return {
        ...state,
        items: [
          ...items,
          { id: `verify-${event.step}`, label: event.summary, state: "active", phase: "verification" },
        ],
      };
    case "verification_check":
      return {
        ...state,
        items: [
          ...items,
          {
            id: `check-${items.length}`,
            label: event.summary,
            state: checkState(event.status),
            phase: "verification",
          },
        ],
      };
    case "verification_completed":
      return {
        ...state,
        items: settleLastActive(
          [
            ...items,
            {
              id: `verdict-${event.step}`,
              label: event.summary,
              state: "pass",
              phase: "verification",
            },
          ],
          "verification",
          "verify-",
          event.status === "verified_complete" ? "pass" : "warn",
        ),
      };
    case "failure":
      return {
        ...state,
        items: [
          ...items,
          {
            id: `failure-${items.length}`,
            label: `遇到问题：${event.summary}`,
            state: "fail",
            phase: event.phase,
          },
        ],
      };
    case "recovery":
      return {
        ...state,
        items: [
          ...items,
          {
            id: `recovery-${items.length}`,
            label: `恢复策略：${event.summary}`,
            state: "warn",
            phase: event.phase,
          },
        ],
      };
    case "investigation_completed":
      return {
        ...state,
        items: [
          ...items,
          { id: `completed-${event.step}`, label: event.summary, state: "pass", phase: "agent" },
        ],
      };
    default:
      return state;
  }
}
