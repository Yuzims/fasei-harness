/**
 * Local LLM request context profiling.
 *
 * Counts, sizes, token estimates, and fingerprints only.
 * Never stores prompts, tool results, GitHub bodies, or secrets.
 * Token estimates are local heuristics, not provider usage.
 */

import { createHash } from "node:crypto";

/** Must match ESTIMATED_CHARS_PER_TOKEN in llm-usage.ts. Local heuristic only. */
const CHARS_PER_TOKEN = 4;

function estimateTokens(serializedChars: number): number | null {
  if (!Number.isFinite(serializedChars) || serializedChars < 0) {
    return null;
  }
  return Math.ceil(serializedChars / CHARS_PER_TOKEN);
}

export interface LlmMessageProfile {
  role: string;
  count: number;
  totalChars: number;
}

export interface LlmToolContribution {
  toolName: string;
  invocationCount: number;
  totalChars: number;
  largestResultChars: number;
}

/** Size / estimate breakdown of one OpenAI-compatible request. */
export interface LlmContextBreakdown {
  systemMessageChars: number;
  userMessageChars: number;
  assistantMessageChars: number;
  toolMessageChars: number;
  systemMessageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  messageCount: number;
  serializedMessagesChars: number;
  serializedToolsChars: number;
  /** Local estimate: serializedMessagesChars / 4. Not provider inputTokens. */
  estimatedMessageTokens: number | null;
  /** Local estimate: serializedToolsChars / 4. Not provider inputTokens. */
  estimatedToolsTokens: number | null;
  /** Local estimate: (messages + tools) chars / 4. Not provider inputTokens. */
  estimatedTotalInputTokens: number | null;
}

export interface LlmContextProfile extends LlmContextBreakdown {
  /**
   * Backward-compatible local estimate: serializedRequestChars / 4.
   * serializedRequestChars is messages-only (not tools).
   */
  estimatedInputTokens: number | null;
  historyLength: number;
  serializedRequestChars: number;
  messageRoles: LlmMessageProfile[];
  toolResultCount: number;
  totalToolResultChars: number;
  largestToolResultChars: number;
  toolContributions: LlmToolContribution[];
  messagesFingerprint: string | null;
  toolsFingerprint: string | null;
  messagesPrefixFingerprint: string | null;
  messageSequenceFingerprint: string | null;
}

const SAFE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/;
const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool"]);
const PREFIX_MESSAGE_COUNT = 2;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function safeSerialize(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function sha256Fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function fingerprintOf(value: unknown): string | null {
  const serialized = safeSerialize(value);
  return serialized === null ? null : sha256Fingerprint(serialized);
}

export function normalizeToolName(name: unknown): string {
  if (typeof name === "string" && SAFE_TOOL_NAME.test(name)) {
    return name;
  }
  return "unknown";
}

function normalizeRole(role: unknown): string {
  if (typeof role === "string" && KNOWN_ROLES.has(role)) {
    return role;
  }
  return "other";
}

function contentChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  return safeSerialize(value)?.length ?? 0;
}

function messageChars(message: Record<string, unknown>): number {
  const content = contentChars(message.content);
  if (content > 0) {
    return content;
  }
  if (Array.isArray(message.tool_calls)) {
    return safeSerialize(message.tool_calls)?.length ?? 0;
  }
  return 0;
}

function emptyRoleTotals(): Record<string, { count: number; totalChars: number }> {
  return {
    system: { count: 0, totalChars: 0 },
    user: { count: 0, totalChars: 0 },
    assistant: { count: 0, totalChars: 0 },
    tool: { count: 0, totalChars: 0 },
    other: { count: 0, totalChars: 0 },
  };
}

function collectToolNamesByCallId(messages: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of messages) {
    const message = asRecord(item);
    if (!message) {
      continue;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall);
      const fn = asRecord(call?.function);
      const id = typeof call?.id === "string" ? call.id : undefined;
      if (!id) {
        continue;
      }
      names.set(id, normalizeToolName(fn?.name));
    }
  }
  return names;
}

function toolCallIdOf(message: Record<string, unknown>): string | undefined {
  if (typeof message.tool_call_id === "string" && message.tool_call_id) {
    return message.tool_call_id;
  }
  const parsed = typeof message.content === "string" ? asRecord(safeParseJson(message.content)) : undefined;
  if (typeof parsed?.callId === "string" && parsed.callId) {
    return parsed.callId;
  }
  return undefined;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function emptyLlmContextProfile(historyLength = 0): LlmContextProfile {
  return {
    systemMessageChars: 0,
    userMessageChars: 0,
    assistantMessageChars: 0,
    toolMessageChars: 0,
    systemMessageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolMessageCount: 0,
    messageCount: 0,
    serializedMessagesChars: 0,
    serializedToolsChars: 0,
    estimatedMessageTokens: null,
    estimatedToolsTokens: null,
    estimatedTotalInputTokens: null,
    estimatedInputTokens: null,
    historyLength,
    serializedRequestChars: 0,
    messageRoles: [
      { role: "system", count: 0, totalChars: 0 },
      { role: "user", count: 0, totalChars: 0 },
      { role: "assistant", count: 0, totalChars: 0 },
      { role: "tool", count: 0, totalChars: 0 },
    ],
    toolResultCount: 0,
    totalToolResultChars: 0,
    largestToolResultChars: 0,
    toolContributions: [],
    messagesFingerprint: null,
    toolsFingerprint: null,
    messagesPrefixFingerprint: null,
    messageSequenceFingerprint: null,
  };
}

export function profileLlmRequest(input: {
  messages: unknown;
  tools?: unknown;
  historyLength: number;
}): LlmContextProfile {
  const profile = emptyLlmContextProfile(input.historyLength);
  const messagesSerialized = safeSerialize(input.messages);
  if (messagesSerialized === null) {
    return profile;
  }

  const toolsValue = input.tools === undefined ? [] : input.tools;
  const toolsSerialized = safeSerialize(toolsValue);
  if (toolsSerialized === null) {
    return profile;
  }

  const messages = Array.isArray(input.messages) ? input.messages : [];
  const roles = emptyRoleTotals();
  const toolNames = collectToolNamesByCallId(messages);
  const contributions = new Map<string, LlmToolContribution>();
  let toolResultCount = 0;
  let totalToolResultChars = 0;
  let largestToolResultChars = 0;
  const sequence: string[] = [];

  for (const item of messages) {
    const message = asRecord(item);
    if (!message) {
      continue;
    }
    const role = normalizeRole(message.role);
    sequence.push(role);
    const chars = messageChars(message);
    const bucket = roles[role] ?? roles.other;
    bucket.count += 1;
    bucket.totalChars += chars;

    if (role !== "tool") {
      continue;
    }
    const resultChars = contentChars(message.content);
    toolResultCount += 1;
    totalToolResultChars += resultChars;
    if (resultChars > largestToolResultChars) {
      largestToolResultChars = resultChars;
    }
    const callId = toolCallIdOf(message);
    const toolName = callId ? (toolNames.get(callId) ?? "unknown") : "unknown";
    const existing = contributions.get(toolName);
    if (existing) {
      existing.invocationCount += 1;
      existing.totalChars += resultChars;
      if (resultChars > existing.largestResultChars) {
        existing.largestResultChars = resultChars;
      }
    } else {
      contributions.set(toolName, {
        toolName,
        invocationCount: 1,
        totalChars: resultChars,
        largestResultChars: resultChars,
      });
    }
  }

  const messageRoles: LlmMessageProfile[] = ["system", "user", "assistant", "tool"]
    .filter((role) => roles[role].count > 0 || role !== "other")
    .map((role) => ({
      role,
      count: roles[role].count,
      totalChars: roles[role].totalChars,
    }));
  if (roles.other.count > 0) {
    messageRoles.push({
      role: "other",
      count: roles.other.count,
      totalChars: roles.other.totalChars,
    });
  }

  const serializedMessagesChars = messagesSerialized.length;
  const serializedToolsChars = toolsSerialized.length;
  const prefix = messages.slice(0, Math.min(PREFIX_MESSAGE_COUNT, messages.length));

  return {
    systemMessageChars: roles.system.totalChars,
    userMessageChars: roles.user.totalChars,
    assistantMessageChars: roles.assistant.totalChars,
    toolMessageChars: roles.tool.totalChars,
    systemMessageCount: roles.system.count,
    userMessageCount: roles.user.count,
    assistantMessageCount: roles.assistant.count,
    toolMessageCount: roles.tool.count,
    messageCount: messages.length,
    serializedMessagesChars,
    serializedToolsChars,
    estimatedMessageTokens: estimateTokens(serializedMessagesChars),
    estimatedToolsTokens: estimateTokens(serializedToolsChars),
    estimatedTotalInputTokens: estimateTokens(serializedMessagesChars + serializedToolsChars),
    estimatedInputTokens: estimateTokens(serializedMessagesChars),
    historyLength: input.historyLength,
    serializedRequestChars: serializedMessagesChars,
    messageRoles,
    toolResultCount,
    totalToolResultChars,
    largestToolResultChars,
    toolContributions: [...contributions.values()].sort((a, b) =>
      a.toolName.localeCompare(b.toolName),
    ),
    messagesFingerprint: sha256Fingerprint(messagesSerialized),
    toolsFingerprint: sha256Fingerprint(toolsSerialized),
    messagesPrefixFingerprint: fingerprintOf(prefix),
    messageSequenceFingerprint: sequence.length > 0 ? sha256Fingerprint(sequence.join(",")) : null,
  };
}

/**
 * Local context-size proxy. estimatedInputTokens remains messages-only:
 * estimatedInputTokens ≈ serializedRequestChars / 4.
 * Tools are profiled separately and do not change that heuristic.
 */
export function profileRequestMessages(
  messages: unknown,
  historyLength: number,
  tools: unknown = [],
): LlmContextProfile {
  return profileLlmRequest({ messages, tools, historyLength });
}

export function contextFingerprintDelta(
  previous: Pick<LlmContextProfile, "messagesFingerprint" | "toolsFingerprint">,
  next: Pick<LlmContextProfile, "messagesFingerprint" | "toolsFingerprint">,
): { messagesChanged: boolean; toolsChanged: boolean } {
  return {
    messagesChanged: previous.messagesFingerprint !== next.messagesFingerprint,
    toolsChanged: previous.toolsFingerprint !== next.toolsFingerprint,
  };
}

export function largestContextContributor(
  profile: LlmContextProfile,
): "system" | "user" | "assistant" | "tool" | "tools_schema" | "unknown" {
  const buckets: Array<
    ["system" | "user" | "assistant" | "tool" | "tools_schema", number]
  > = [
    ["system", profile.systemMessageChars],
    ["user", profile.userMessageChars],
    ["assistant", profile.assistantMessageChars],
    ["tool", profile.toolMessageChars],
    ["tools_schema", profile.serializedToolsChars],
  ];
  let winner: "system" | "user" | "assistant" | "tool" | "tools_schema" | "unknown" = "unknown";
  let peak = 0;
  for (const [name, chars] of buckets) {
    if (chars > peak) {
      peak = chars;
      winner = name;
    }
  }
  return peak > 0 ? winner : "unknown";
}

export function contextTraceData(profile: LlmContextProfile): Record<string, unknown> {
  return {
    messageCount: profile.messageCount,
    systemChars: profile.systemMessageChars,
    userChars: profile.userMessageChars,
    assistantChars: profile.assistantMessageChars,
    toolChars: profile.toolMessageChars,
    systemMessageCount: profile.systemMessageCount,
    userMessageCount: profile.userMessageCount,
    assistantMessageCount: profile.assistantMessageCount,
    toolMessageCount: profile.toolMessageCount,
    serializedMessagesChars: profile.serializedMessagesChars,
    serializedToolsChars: profile.serializedToolsChars,
    estimatedMessageTokens: profile.estimatedMessageTokens,
    estimatedToolsTokens: profile.estimatedToolsTokens,
    estimatedTotalInputTokens: profile.estimatedTotalInputTokens,
    estimatedInputTokens: profile.estimatedInputTokens,
    historyLength: profile.historyLength,
    serializedRequestChars: profile.serializedRequestChars,
    toolResultCount: profile.toolResultCount,
    totalToolResultChars: profile.totalToolResultChars,
    largestToolResultChars: profile.largestToolResultChars,
    toolContributions: profile.toolContributions,
    messageRoles: profile.messageRoles,
    messagesFingerprint: profile.messagesFingerprint,
    toolsFingerprint: profile.toolsFingerprint,
    messagesPrefixFingerprint: profile.messagesPrefixFingerprint,
    messageSequenceFingerprint: profile.messageSequenceFingerprint,
  };
}

