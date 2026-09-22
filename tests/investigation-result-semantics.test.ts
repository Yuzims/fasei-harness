import assert from "node:assert/strict";
import test from "node:test";
import { toInvestigationSessionDTO } from "../src/server/investigation-service.js";
import type { InvestigationAgentReport } from "../src/investigation/investigation-report.js";
import { aggregateLlmUsage } from "../src/agent/llm-usage.js";
import { createInvestigationTask, createInvestigationRun } from "../src/domain/index.js";

function makeReport(overrides: {
  agentOutput?: unknown;
  conclusion: string;
  polarity?: "resolved" | "unresolved" | "partial" | "unknown";
}): InvestigationAgentReport {
  const task = createInvestigationTask({
    target: { owner: "o", repository: "r", issueNumber: 1 },
  });
  const run = createInvestigationRun({ task });
  return {
    task,
    status: "investigated",
    run,
    report: {
      conclusion: overrides.conclusion,
      polarity: overrides.polarity ?? "unknown",
      evidenceChain: [],
      claimIds: [],
      uncertainty: "u",
      openQuestions: [],
    },
    claims: [],
    evidence: [],
    claimEvidence: [],
    resolutionAnalyses: [],
    unresolvedQuestions: [],
    investigationSteps: [],
    actor: "llm",
    agentResult:
      overrides.agentOutput === undefined
        ? undefined
        : { status: "completed", output: overrides.agentOutput as string, steps: 1 },
    llmUsage: aggregateLlmUsage([]),
    retrievalCandidates: [],
    toolCallCount: 0,
    retrievalTopKCandidates: [],
    investigationCandidates: [],
    investigatedCandidates: [],
    promotedCandidates: [],
    recoveryAttempts: [],
  } as unknown as InvestigationAgentReport;
}

test("17-A.1 Test A: DTO.agentOutput === AgentResult.output, not report.conclusion", () => {
  const dto = toInvestigationSessionDTO(
    makeReport({ agentOutput: "real agent answer", conclusion: "structured conclusion" }),
    { mode: "snapshot" },
  );
  assert.equal(dto.agentOutput, "real agent answer");
  assert.equal(dto.rawAgentOutput, "real agent answer");
  assert.equal(dto.report.conclusion, "structured conclusion");
});

test("17-A.1 Test B: missing agent output must not fall back to report.conclusion", () => {
  const dto = toInvestigationSessionDTO(
    makeReport({ agentOutput: undefined, conclusion: "structured conclusion" }),
    { mode: "snapshot" },
  );
  assert.equal(dto.agentOutput, undefined);
  assert.equal(dto.report.conclusion, "structured conclusion");
});

test("17-A.1 Test C/F: harness fallback conclusion is not agent output; polarity is not agent judgment", () => {
  const dto = toInvestigationSessionDTO(
    makeReport({
      agentOutput: undefined,
      conclusion: "Insufficient evidence to explain how issue #1 was resolved.",
      polarity: "unknown",
    }),
    { mode: "snapshot" },
  );
  assert.equal(dto.agentOutput, undefined);
  assert.match(dto.report.conclusion, /Insufficient evidence/);
  assert.equal(dto.report.polarity, "unknown");
});
