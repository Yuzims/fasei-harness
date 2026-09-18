/**
 * Context-efficiency view over existing benchmark + LLM usage metrics.
 * Does not reimplement verification, scoring, or evaluators.
 */
import type { LlmUsageAggregate } from "../agent/llm-usage.js";
import type { BenchmarkMetrics, BenchmarkReport, ScenarioResult } from "./types.js";

export type ContextEfficiencyMetrics = {
  llmCalls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  evidenceCoverage: number | null;
  unsupportedClaimRate: number | null;
  falseCompletionRate: number | null;
  verifierFalsePositiveRate: number | null;
  verificationStatus: string;
};

function usageFields(usage?: LlmUsageAggregate): Pick<
  ContextEfficiencyMetrics,
  "llmCalls" | "inputTokens" | "cachedInputTokens" | "outputTokens"
> {
  return {
    llmCalls: usage?.llmCalls ?? 0,
    inputTokens: usage?.totalInputTokens ?? null,
    cachedInputTokens: usage?.totalCachedInputTokens ?? null,
    outputTokens: usage?.totalOutputTokens ?? null,
  };
}

export function contextEfficiencyFromScenario(
  result: Pick<
    ScenarioResult,
    "evidenceCoverage" | "unsupportedClaimRate" | "falseCompletion" | "verificationStatus"
  >,
  usage?: LlmUsageAggregate,
): ContextEfficiencyMetrics {
  return {
    ...usageFields(usage),
    evidenceCoverage: result.evidenceCoverage,
    unsupportedClaimRate: result.unsupportedClaimRate,
    falseCompletionRate: result.falseCompletion ? 1 : 0,
    verifierFalsePositiveRate: null,
    verificationStatus: result.verificationStatus,
  };
}

export function contextEfficiencyFromMetrics(
  metrics: BenchmarkMetrics,
  verificationStatus: string,
  usage?: LlmUsageAggregate,
): ContextEfficiencyMetrics {
  return {
    ...usageFields(usage),
    evidenceCoverage: metrics.evidenceCoverage,
    unsupportedClaimRate: metrics.unsupportedClaimRate,
    falseCompletionRate: metrics.falseCompletionRate,
    verifierFalsePositiveRate: metrics.verifierFalsePositiveRate,
    verificationStatus,
  };
}

export function contextEfficiencyFromReport(
  report: BenchmarkReport,
  usage?: LlmUsageAggregate,
): ContextEfficiencyMetrics {
  return contextEfficiencyFromMetrics(
    report.metrics,
    report.results.map((item) => `${item.scenarioId}:${item.verificationStatus}`).join(","),
    usage,
  );
}
