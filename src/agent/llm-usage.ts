/**
 * LLM token / cache observability and local context-size profiling.
 *
 * Provider usage (inputTokens / cachedInputTokens / outputTokens / totalTokens)
 * is recorded as returned. estimatedInputTokens is a local heuristic
 * (serialized message characters / 4), not provider token usage.
 * This module does not price requests or alter model behavior.
 */

import { contextTraceData, type LlmContextProfile } from "./llm-context-profile.js";

export const ESTIMATED_CHARS_PER_TOKEN = 4;

export {
  contextFingerprintDelta,
  contextTraceData,
  emptyLlmContextProfile,
  largestContextContributor,
  normalizeToolName,
  profileLlmRequest,
  profileRequestMessages,
  type LlmContextBreakdown,
  type LlmContextProfile,
  type LlmMessageProfile,
  type LlmToolContribution,
} from "./llm-context-profile.js";

export interface LlmUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmCallRecord {
  callId: string;
  callIndex: number;
  model: string;
  usage: LlmUsage;
  durationMs: number;
  ok: boolean;
  errorCategory?: string;
  historyLength?: number;
  attempt?: number;
  agentStep?: number;
  serializedRequestChars?: number;
  estimatedInputTokens?: number | null;
  messageCount?: number;
  context?: LlmContextProfile;
}

export interface LlmUsageAggregate {
  model: string | null;
  llmCalls: number;
  totalInputTokens: number | null;
  totalCachedInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  overallCacheHitRate: number | null;
  averageInputTokensPerCall: number | null;
  averageOutputTokensPerCall: number | null;
  calls: LlmCallRecord[];
}

export function emptyLlmUsage(): LlmUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
}

/**
 * Local estimate only. Not provider inputTokens.
 * estimatedInputTokens ≈ serializedRequestChars / 4.
 */
export function estimateInputTokensFromChars(serializedRequestChars: number): number | null {
  if (!Number.isFinite(serializedRequestChars) || serializedRequestChars < 0) {
    return null;
  }
  return Math.ceil(serializedRequestChars / ESTIMATED_CHARS_PER_TOKEN);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract usage from an OpenAI-compatible chat completion payload.
 * Missing fields stay null. cached_tokens is a subset of input tokens, not added on top.
 */
export function extractLlmUsage(payload: unknown): LlmUsage {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) {
    return emptyLlmUsage();
  }

  const promptDetails = asRecord(usage.prompt_tokens_details);
  const inputDetails = asRecord(usage.input_tokens_details);
  const cachedInputTokens =
    asFiniteNumber(promptDetails?.cached_tokens) ??
    asFiniteNumber(inputDetails?.cached_tokens) ??
    asFiniteNumber(usage.cached_tokens);

  return {
    inputTokens: asFiniteNumber(usage.prompt_tokens) ?? asFiniteNumber(usage.input_tokens),
    cachedInputTokens,
    outputTokens: asFiniteNumber(usage.completion_tokens) ?? asFiniteNumber(usage.output_tokens),
    totalTokens: asFiniteNumber(usage.total_tokens),
  };
}

/** cachedInputTokens / inputTokens. Null when either side cannot form a finite ratio. */
export function cacheHitRate(
  inputTokens: number | null | undefined,
  cachedInputTokens: number | null | undefined,
): number | null {
  if (inputTokens === null || inputTokens === undefined) {
    return null;
  }
  if (cachedInputTokens === null || cachedInputTokens === undefined) {
    return null;
  }
  if (inputTokens <= 0) {
    return null;
  }
  const rate = cachedInputTokens / inputTokens;
  return Number.isFinite(rate) ? rate : null;
}

function sumKnown(values: Array<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value === null) {
      continue;
    }
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function average(total: number | null, count: number): number | null {
  if (total === null || count <= 0) {
    return null;
  }
  const value = total / count;
  return Number.isFinite(value) ? value : null;
}

export function aggregateLlmUsage(
  calls: readonly LlmCallRecord[],
  model?: string | null,
): LlmUsageAggregate {
  const totalInputTokens = sumKnown(calls.map((item) => item.usage.inputTokens));
  const totalCachedInputTokens = sumKnown(calls.map((item) => item.usage.cachedInputTokens));
  const totalOutputTokens = sumKnown(calls.map((item) => item.usage.outputTokens));
  const totalTokens = sumKnown(calls.map((item) => item.usage.totalTokens));
  const inputCount = calls.filter((item) => item.usage.inputTokens !== null).length;
  const outputCount = calls.filter((item) => item.usage.outputTokens !== null).length;

  return {
    model: model ?? calls.at(-1)?.model ?? null,
    llmCalls: calls.length,
    totalInputTokens,
    totalCachedInputTokens,
    totalOutputTokens,
    totalTokens,
    overallCacheHitRate: cacheHitRate(totalInputTokens, totalCachedInputTokens),
    averageInputTokensPerCall: average(totalInputTokens, inputCount),
    averageOutputTokensPerCall: average(totalOutputTokens, outputCount),
    calls: [...calls],
  };
}

export class LlmUsageCollector {
  private readonly calls: LlmCallRecord[] = [];

  constructor(private readonly model: string | null = null) {}

  record(input: Omit<LlmCallRecord, "callIndex">): LlmCallRecord {
    const record: LlmCallRecord = {
      ...input,
      callIndex: this.calls.length + 1,
    };
    this.calls.push(record);
    return record;
  }

  getCalls(): LlmCallRecord[] {
    return [...this.calls];
  }

  aggregate(): LlmUsageAggregate {
    return aggregateLlmUsage(this.calls, this.model ?? this.calls.at(-1)?.model ?? null);
  }
}

function formatCount(value: number | null): string {
  if (value === null) {
    return "unavailable";
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatRate(value: number | null): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(2)}%`;
}

export function formatLlmUsageSummary(aggregate: LlmUsageAggregate): string {
  const model = aggregate.model ?? "unavailable";
  return [
    "LLM Usage",
    "────────────────────────────",
    `Model                  ${model}`,
    `LLM Calls              ${aggregate.llmCalls}`,
    "",
    `Input Tokens           ${formatCount(aggregate.totalInputTokens)}`,
    `Cached Input Tokens    ${formatCount(aggregate.totalCachedInputTokens)}`,
    `Cache Hit Rate         ${formatRate(aggregate.overallCacheHitRate)}`,
    "",
    `Output Tokens          ${formatCount(aggregate.totalOutputTokens)}`,
    `Total Tokens           ${formatCount(aggregate.totalTokens)}`,
    "",
    `Avg Input / Call       ${formatCount(aggregate.averageInputTokensPerCall)}`,
    `Avg Output / Call      ${formatCount(aggregate.averageOutputTokensPerCall)}`,
  ].join("\n");
}

function formatOptional(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : formatCount(value);
}

function formatCallLine(record: LlmCallRecord): string[] {
  const context = record.context;
  return [
    `Call #${record.callIndex}`,
    `  attempt: ${formatOptional(record.attempt)}`,
    `  step: ${formatOptional(record.agentStep)}`,
    `  history: ${formatOptional(record.historyLength)}`,
    `  input: ${formatOptional(record.usage.inputTokens)}`,
    `  cached: ${formatOptional(record.usage.cachedInputTokens)}`,
    `  output: ${formatOptional(record.usage.outputTokens)}`,
    `  total: ${formatOptional(record.usage.totalTokens)}`,
    `  duration: ${record.durationMs}ms`,
    `  estimatedInputTokens: ${formatOptional(record.estimatedInputTokens)}`,
    `  serializedRequestChars: ${formatOptional(record.serializedRequestChars)}`,
    `  serializedMessagesChars: ${formatOptional(context?.serializedMessagesChars)}`,
    `  serializedToolsChars: ${formatOptional(context?.serializedToolsChars)}`,
    `  estimatedMessageTokens: ${formatOptional(context?.estimatedMessageTokens)}`,
    `  estimatedToolsTokens: ${formatOptional(context?.estimatedToolsTokens)}`,
    `  estimatedTotalInputTokens: ${formatOptional(context?.estimatedTotalInputTokens)}`,
    `  toolResultChars: ${formatOptional(context?.totalToolResultChars)}`,
    `  messagesFingerprint: ${context?.messagesFingerprint ?? "unavailable"}`,
    `  toolsFingerprint: ${context?.toolsFingerprint ?? "unavailable"}`,
  ];
}

export function formatLlmProfilingSummary(aggregate: LlmUsageAggregate): string {
  const model = aggregate.model ?? "unavailable";
  const lines = [
    "LLM Profiling",
    "",
    `Model: ${model}`,
    "",
    `Calls: ${aggregate.llmCalls}`,
    "",
    `Input tokens: ${formatCount(aggregate.totalInputTokens)}`,
    `Cached input tokens: ${formatCount(aggregate.totalCachedInputTokens)}`,
    `Cache hit rate: ${formatRate(aggregate.overallCacheHitRate)}`,
    "",
    `Output tokens: ${formatCount(aggregate.totalOutputTokens)}`,
    `Total tokens: ${formatCount(aggregate.totalTokens)}`,
    "",
    `Avg input / call: ${formatCount(aggregate.averageInputTokensPerCall)}`,
    `Avg output / call: ${formatCount(aggregate.averageOutputTokensPerCall)}`,
  ];
  if (aggregate.calls.length > 0) {
    lines.push("");
    for (const [index, call] of aggregate.calls.entries()) {
      if (index > 0) {
        lines.push("");
      }
      lines.push(...formatCallLine(call));
    }
  }
  return lines.join("\n");
}

export function llmCallTraceData(
  record: LlmCallRecord,
  context: {
    investigationRunId?: string;
    attempt?: number;
    agentStep?: number;
  } = {},
): Record<string, unknown> {
  const profile = record.context;
  return {
    investigationRunId: context.investigationRunId,
    attempt: context.attempt ?? record.attempt,
    agentStep: context.agentStep ?? record.agentStep,
    callId: record.callId,
    callIndex: record.callIndex,
    model: record.model,
    inputTokens: record.usage.inputTokens,
    cachedInputTokens: record.usage.cachedInputTokens,
    outputTokens: record.usage.outputTokens,
    totalTokens: record.usage.totalTokens,
    usage: {
      inputTokens: record.usage.inputTokens,
      cachedInputTokens: record.usage.cachedInputTokens,
      outputTokens: record.usage.outputTokens,
      totalTokens: record.usage.totalTokens,
    },
    durationMs: record.durationMs,
    historyLength: record.historyLength,
    serializedRequestChars: record.serializedRequestChars,
    estimatedInputTokens: record.estimatedInputTokens,
    messageCount: record.messageCount,
    context: profile ? contextTraceData(profile) : undefined,
    ok: record.ok,
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  };
}

export function llmErrorCategory(error: unknown, httpStatus?: number): string {
  if (typeof httpStatus === "number") {
    if (httpStatus >= 500) {
      return "http_5xx";
    }
    if (httpStatus >= 400) {
      return "http_4xx";
    }
    return "http_error";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("空 choices")) {
    return "empty_choices";
  }
  if (message.includes("不是 JSON")) {
    return "invalid_json";
  }
  if (message.includes("既没有 tool_call")) {
    return "empty_completion";
  }
  if (message.includes("工具参数不是 JSON")) {
    return "invalid_tool_arguments";
  }
  if (message.includes("没有 body")) {
    return "empty_stream";
  }
  if (message.includes("fetch failed")) {
    return "network_error";
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "runtime_timeout";
  }
  if (message.includes("aborted") || message.includes("wall-clock exceeded")) {
    return "runtime_timeout";
  }
  if (message.includes("call budget exceeded")) {
    return "call_budget_exceeded";
  }
  return "llm_error";
}
