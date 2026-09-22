/**
 * Phase 18-C: attributionCoverage machine record. Pure field derivation over
 * the 18-A prescan record + runtime budget counters; verdict metadata that no
 * verifier condition may read. Fully offline.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { aggregateLlmUsage } from "../src/agent/llm-usage.js";
import {
  createInvestigationRun,
  createInvestigationTask,
  deriveAttributionCoverage,
  type ResolutionPrescanCandidate,
  type ResolutionPrescanRecord,
} from "../src/domain/index.js";
import type { ClosingReferenceFacts } from "../src/github/index.js";
import { SnapshotGitHubProvider, githubFixturePath } from "../src/github/index.js";
import { investigate } from "../src/investigation/index.js";
import type { InvestigationAgentReport } from "../src/investigation/investigation-report.js";
import { toInvestigationSessionDTO } from "../src/server/investigation-service.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";

function closingRefsFixture(): { repositoryNameWithOwner?: string; facts: ClosingReferenceFacts[] } {
  const url = new URL("../fixtures/github/react-37610-closing-refs.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as {
    repositoryNameWithOwner?: string;
    facts: ClosingReferenceFacts[];
  };
}

function fixtureGraphQl() {
  const fixture = closingRefsFixture();
  return {
    async getClosingReferences({ pullNumbers }: { pullNumbers: number[] }) {
      return {
        repositoryNameWithOwner: fixture.repositoryNameWithOwner,
        facts: fixture.facts.filter((fact) => pullNumbers.includes(fact.pullNumber)),
      };
    },
  };
}

function prescanRecord(
  overrides: Partial<ResolutionPrescanRecord> & {
    candidates?: Array<Partial<ResolutionPrescanCandidate> & { pullNumber: number }>;
  } = {},
): ResolutionPrescanRecord {
  const { candidates: candidateInputs, ...rest } = overrides;
  const candidates: ResolutionPrescanCandidate[] = (candidateInputs ?? []).map((item) => ({
    enumeratedBy: ["comment_mention"],
    detailState: "completed",
    ...item,
  }));
  return {
    state: "completed",
    startedAt: "2026-09-22T00:00:00.000Z",
    llmCalls: 0,
    sources: [],
    candidates,
    candidatesEnumerated: candidates.length,
    candidatesTruncated: false,
    commitCandidates: [],
    ...rest,
    ...(candidateInputs ? { candidates } : {}),
  };
}

test("无 prescan：not_assertable，零计数，绝不声称穷尽", () => {
  const coverage = deriveAttributionCoverage({ llmCallsSent: 2, maxLlmCalls: 8 });
  assert.equal(coverage.state, "not_assertable");
  assert.equal(coverage.prescanState, "absent");
  assert.equal(coverage.candidatesEnumerated, 0);
  assert.equal(coverage.candidatesAdjudicated, 0);
  assert.deepEqual(coverage.unadjudicatedCandidates, []);
  assert.equal(coverage.budgetExhausted, false);
});

test("预算字段纯数值比较：calls 用尽或 wall-clock 失败都置 budgetExhausted", () => {
  assert.equal(deriveAttributionCoverage({ llmCallsSent: 8, maxLlmCalls: 8 }).budgetExhausted, true);
  assert.equal(
    deriveAttributionCoverage({ llmCallsSent: 1, maxLlmCalls: 8, runtimeBudgetFailure: true }).budgetExhausted,
    true,
  );
  assert.equal(
    deriveAttributionCoverage({ llmCallsSent: 1, maxLlmCalls: 8, runtimeBudgetFailure: false }).budgetExhausted,
    false,
  );
});

test("prescan completed 且全部裁决（含 not_a_pull_request）→ exhausted", () => {
  const coverage = deriveAttributionCoverage({
    prescan: prescanRecord({
      candidates: [
        { pullNumber: 1, detailState: "completed", structuredClosingReference: true },
        { pullNumber: 2, detailState: "not_a_pull_request" },
        { pullNumber: 3, detailState: "completed", merged: true },
      ],
    }),
    llmCallsSent: 0,
    maxLlmCalls: 8,
  });
  assert.equal(coverage.state, "exhausted");
  assert.equal(coverage.candidatesEnumerated, 3);
  assert.equal(coverage.candidatesAdjudicated, 3);
  assert.deepEqual(coverage.unadjudicatedCandidates, []);
});

test("prescan incomplete 即使候选全部裁决，也不得出现 exhausted", () => {
  const coverage = deriveAttributionCoverage({
    prescan: prescanRecord({
      state: "incomplete",
      candidates: [{ pullNumber: 1, detailState: "completed", structuredClosingReference: true }],
    }),
    llmCallsSent: 0,
    maxLlmCalls: 8,
  });
  assert.equal(coverage.state, "mid_run");
  assert.equal(coverage.candidatesAdjudicated, 1);
  assert.deepEqual(coverage.unadjudicatedCandidates, []);
});

test("detail 拉取失败的候选列入未裁决清单（resume 输入）", () => {
  const coverage = deriveAttributionCoverage({
    prescan: prescanRecord({
      state: "incomplete",
      candidates: [
        { pullNumber: 10, detailState: "completed" },
        { pullNumber: 11, detailState: "failed" },
        { pullNumber: 12, detailState: "skipped" },
      ],
      candidatesEnumerated: 3,
    }),
    llmCallsSent: 0,
    maxLlmCalls: 8,
  });
  assert.equal(coverage.state, "mid_run");
  assert.equal(coverage.candidatesAdjudicated, 1);
  assert.deepEqual(coverage.unadjudicatedCandidates, [11, 12]);
});

test("候选上限截断：被截掉的余量计入 unenumeratedCandidates 并阻断 exhausted", () => {
  const coverage = deriveAttributionCoverage({
    prescan: prescanRecord({
      candidates: [
        { pullNumber: 100, detailState: "completed" },
        { pullNumber: 101, detailState: "completed" },
      ],
      candidatesEnumerated: 15,
      candidatesTruncated: true,
    }),
    llmCallsSent: 0,
    maxLlmCalls: 8,
  });
  assert.equal(coverage.state, "mid_run");
  assert.equal(coverage.unenumeratedCandidates, 13);
  assert.equal(coverage.candidatesAdjudicated, 2);
});

test("预算耗尽且存在未裁决候选 ⇒ mid_run（18-C 核心拒绝伪装）", () => {
  const coverage = deriveAttributionCoverage({
    prescan: prescanRecord({
      candidates: [{ pullNumber: 5, detailState: "failed" }],
      candidatesEnumerated: 1,
    }),
    llmCallsSent: 8,
    maxLlmCalls: 8,
  });
  assert.equal(coverage.state, "mid_run");
  assert.equal(coverage.budgetExhausted, true);
  assert.deepEqual(coverage.unadjudicatedCandidates, [5]);
});

async function replayInvestigate(options: { withPrescan?: boolean; maxCandidates?: number } = {}) {
  return investigate({
    task: { owner: "facebook", repository: "react", issueNumber: 37610 },
    provider: new SnapshotGitHubProvider(githubFixturePath("react-37610")),
    model: {
      async decide() {
        return { type: "final" as const, message: "Prescan already gave me the candidate set." };
      },
    },
    ...(options.withPrescan === false
      ? {}
      : {
          resolutionPrescan: {
            enabled: true as const,
            graphQl: fixtureGraphQl(),
            maxCandidates: options.maxCandidates,
          },
        }),
    maxAttempts: 1,
  });
}

test("react#37610 重放：coverage 记录 enumerated=10 / adjudicated=10 / 无未裁决候选", async () => {
  const result = await replayInvestigate();

  assert.ok(result.run.resolutionPrescan, "prescan record must exist first");
  const coverage = result.run.attributionCoverage;
  assert.ok(coverage, "investigate() must attach attributionCoverage to the run");
  assert.equal(coverage.state, "exhausted");
  assert.equal(coverage.prescanState, "completed");
  assert.equal(coverage.candidatesEnumerated, 10);
  assert.equal(coverage.candidatesAdjudicated, 10);
  assert.deepEqual(coverage.unadjudicatedCandidates, []);
  assert.equal(coverage.unenumeratedCandidates, 0);
  assert.equal(coverage.budgetExhausted, false);
});

test("coverage=exhausted 不翻转 verdict：18-B 语义原样保留", async () => {
  const result = await replayInvestigate();
  assert.equal(result.run.attributionCoverage?.state, "exhausted");
  assert.equal(result.run.status, "not_verified", "structured exhaustion must not certify a fix");
  assert.equal(result.verification?.status, "not_verified");
});

test("verifier 回归：attributionCoverage 存在与否不改变任何 check 判定", async () => {
  const result = await replayInvestigate();
  const verifier = new IndependentCompletionVerifier();
  const input = { task: result.task, run: result.run };
  const withCoverage = verifier.verify(input);

  // Remove coverage and re-verify the same run: byte-identical verdicts.
  const saved = result.run.attributionCoverage;
  result.run.attributionCoverage = undefined;
  const withoutCoverage = verifier.verify(input);
  assert.deepEqual(withCoverage, withoutCoverage);

  // Adversarial input: a fabricated exhausted-with-truncated record changes nothing.
  result.run.attributionCoverage = {
    state: "exhausted",
    prescanState: "completed",
    candidatesEnumerated: 0,
    candidatesAdjudicated: 0,
    unadjudicatedCandidates: [],
    unenumeratedCandidates: 0,
    budgetExhausted: true,
  };
  assert.deepEqual(verifier.verify(input), withoutCoverage);
  result.run.attributionCoverage = saved;
});

test("无 prescan 旧链路：coverage 为 not_assertable，verdict 照常产出", async () => {
  const result = await replayInvestigate({ withPrescan: false });
  assert.equal(result.run.resolutionPrescan, undefined);
  assert.equal(result.run.attributionCoverage?.state, "not_assertable");
  assert.ok(
    result.run.status === "not_verified" ||
      result.run.status === "insufficient_evidence" ||
      result.verification?.status === "not_verified" ||
      result.verification?.status === "insufficient_evidence",
    "legacy verdict semantics untouched",
  );
});

test("prescan 截断链路（maxCandidates 小于枚举数）→ mid_run", async () => {
  const result = await replayInvestigate({ maxCandidates: 4 });
  const coverage = result.run.attributionCoverage;
  assert.ok(coverage);
  assert.equal(coverage.candidatesEnumerated, 10);
  assert.equal(coverage.unenumeratedCandidates, 6);
  assert.equal(coverage.state, "mid_run");
});

function makeReport(
  run: ReturnType<typeof createInvestigationRun>,
  task: ReturnType<typeof createInvestigationTask>,
): InvestigationAgentReport {
  return {
    task,
    status: "investigated",
    run,
    report: {
      conclusion: "c",
      polarity: "unknown",
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

test("DTO 投影：attributionCoverage 原样进入 session，缺记录时为 undefined", () => {
  const task = createInvestigationTask({
    target: { owner: "facebook", repository: "react", issueNumber: 37610 },
  });
  const run = createInvestigationRun({ task });
  assert.equal(toInvestigationSessionDTO(makeReport(run, task), { mode: "live" }).attributionCoverage, undefined);

  run.attributionCoverage = {
    state: "mid_run",
    prescanState: "incomplete",
    candidatesEnumerated: 10,
    candidatesAdjudicated: 7,
    unadjudicatedCandidates: [11, 12, 13],
    unenumeratedCandidates: 0,
    budgetExhausted: true,
  };
  const dto = toInvestigationSessionDTO(makeReport(run, task), { mode: "live" });
  assert.deepEqual(dto.attributionCoverage, {
    state: "mid_run",
    prescanState: "incomplete",
    candidatesEnumerated: 10,
    candidatesAdjudicated: 7,
    unadjudicatedCandidates: [11, 12, 13],
    unenumeratedCandidates: 0,
    budgetExhausted: true,
  });
  run.attributionCoverage.unadjudicatedCandidates.push(14);
  assert.deepEqual(dto.attributionCoverage.unadjudicatedCandidates, [11, 12, 13], "DTO must not alias the live array");
});
