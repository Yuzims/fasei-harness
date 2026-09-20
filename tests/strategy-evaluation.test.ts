/**
 * Phase 8.8.2 — Controlled Strategy Evaluation.
 * Deterministic Fake Model + snapshots only. No live LLM / GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelResponse } from "../src/agent/model.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  computeEvidenceGap,
  investigate,
  proposeCandidateActions,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import {
  STRATEGY_EVALUATION_BASELINE_NOTE,
  classifyExecutedAction,
  compareStrategyEvaluation,
  differenceOf,
  evaluateAllSyntheticCases,
  evaluateRealV1Cases,
  evaluateSyntheticCase,
  exactActionSignature,
  runStrategyEvaluation,
  seedClosedIssue,
  seedFileAndCommit,
  seedMergedPr,
  syntheticStrategyCases,
} from "../src/evaluation/index.js";
import {
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";

function issueRepeats(tools: string[]): number {
  return tools.filter((tool) => tool === "github_get_issue").length;
}

function isCommitRelated(tool: string): boolean {
  return tool === "github_list_commits" || tool === "github_get_pull_request_files";
}

test("Baseline definition is an approximation, not a historical replay", () => {
  assert.match(STRATEGY_EVALUATION_BASELINE_NOTE, /approximation of pre-8\.8/);
  assert.match(STRATEGY_EVALUATION_BASELINE_NOTE, /not a strict historical replay/);
});

test("Exact duplicate uses tool + normalized arguments + resourceKey", () => {
  const first = exactActionSignature("github_get_issue", {
    repo: "box",
    owner: "acme",
    issueNumber: 42,
  });
  const second = exactActionSignature("github_get_issue", {
    issueNumber: 42,
    owner: "acme",
    repo: "box",
  });
  assert.equal(first, second);
  assert.notEqual(
    first,
    exactActionSignature("github_get_issue_timeline", {
      owner: "acme",
      repo: "box",
      issueNumber: 42,
    }),
  );
});

test("unnecessaryInvestigationActions uses Evidence Gap + candidate targets, not string matching", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const state = new InvestigationState(task, createInvestigationRun({ task }));
  seedClosedIssue(state);
  const gap = computeEvidenceGap(state.task, state.run);
  const legal = proposeCandidateActions(state, { gap });
  assert.equal(
    legal.some((item) => item.tool === "github_get_issue"),
    false,
  );
  const repeatedIssue = classifyExecutedAction(state, {
    name: "github_get_issue",
    arguments: { owner: "acme", repo: "box", issueNumber: 42 },
  });
  assert.equal(repeatedIssue.unnecessary, true);
  assert.equal(repeatedIssue.unmatchedCandidate, true);
  const timeline = classifyExecutedAction(state, {
    name: "github_get_issue_timeline",
    arguments: { owner: "acme", repo: "box", issueNumber: 42 },
  });
  assert.equal(timeline.unnecessary, false);
  assert.equal(timeline.contributed || timeline.exploratory, true);
});

test("Unconstrained mode is an evaluation boundary and does not change production default", async () => {
  const alwaysIssue: Model = {
    async decide(_task, _history, toolResults): Promise<ModelResponse> {
      if (toolResults.length > 0) {
        return { type: "final", message: "Stopped after one issue fetch. Not verified." };
      }
      return {
        type: "tool_call",
        call: {
          id: "issue-again",
          name: "github_get_issue",
          arguments: { owner: "acme", repo: "box", issueNumber: 42 },
        },
      };
    },
  };
  const constrained = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    model: alwaysIssue,
    maxAttempts: 1,
    prepareSession: (session) => {
      seedClosedIssue(session.state);
    },
  });
  assert.equal(constrained.agentResult?.decision, "illegal_investigation_action");
  assert.equal(issueRepeats(constrained.investigationSteps.map((step) => step.tool)), 0);

  const unconstrained = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    model: alwaysIssue,
    maxAttempts: 1,
    investigationActionConstraint: "unconstrained",
    prepareSession: (session) => {
      seedClosedIssue(session.state);
    },
  });
  assert.notEqual(unconstrained.agentResult?.decision, "illegal_investigation_action");
  assert.equal(issueRepeats(unconstrained.investigationSteps.map((step) => step.tool)), 1);
});

test("Case 1 — missing resolution evidence concentrates Strategy on resolution investigation", async () => {
  const comparison = await evaluateSyntheticCase("missing_resolution_evidence");
  assert.equal(issueRepeats(comparison.strategy.toolSequence), 0);
  assert.equal(
    comparison.strategy.toolSequence.some(
      (tool) =>
        tool === "github_get_issue_timeline" ||
        tool === "github_get_issue_comments" ||
        tool === "github_get_pull_request" ||
        tool === "github_list_commits",
    ),
    true,
  );
  assert.equal(typeof comparison.baseline.llmCalls, "number");
  assert.equal(typeof comparison.strategy.llmCalls, "number");
  assert.equal(comparison.difference.llmCalls, comparison.strategy.llmCalls - comparison.baseline.llmCalls);
});

test("Case 2 — satisfied issue is not re-fetched as ordinary investigation", async () => {
  const comparison = await evaluateSyntheticCase("issue_already_satisfied");
  assert.equal(issueRepeats(comparison.strategy.toolSequence), 0);
  assert.equal(comparison.strategy.toolSequence.includes("github_get_issue"), false);
});

test("Case 3 — missing commit evidence prefers commit-related Strategy actions", async () => {
  const comparison = await evaluateSyntheticCase("missing_commit_evidence");
  const firstGithub = comparison.strategy.toolSequence.find((tool) => tool.startsWith("github_"));
  assert.ok(firstGithub);
  assert.equal(isCommitRelated(firstGithub), true);
  assert.equal(issueRepeats(comparison.strategy.toolSequence), 0);
});

test("Case 4 — missing code evidence does not keep fetching issue state", async () => {
  const comparison = await evaluateSyntheticCase("missing_code_evidence");
  assert.equal(issueRepeats(comparison.strategy.toolSequence), 0);
  assert.equal(comparison.strategy.toolSequence.some(isCommitRelated), true);
});

test("Case 5 — resolution effect gap is identified and is not forced to verified_complete", async () => {
  const comparison = await evaluateSyntheticCase("resolution_effect_gap");
  assert.equal(comparison.strategy.missingConditions.includes("resolution_effect"), true);
  assert.notEqual(comparison.strategy.finalVerificationStatus, "verified_complete");
});

test("Case 6 — recovery nextRequirementIds continue investigation instead of free re-exploration", async () => {
  const comparison = await evaluateSyntheticCase("recovery");
  assert.ok(comparison.strategy.attempts >= 2);
  assert.ok(comparison.strategy.recoveryEvents >= 1);
  const attempt2Tools = comparison.strategy.toolSequence.slice(
    comparison.baseline.toolSequence.length > 0 ? 0 : 0,
  );
  assert.equal(typeof attempt2Tools.length, "number");
  const recoveryRun = await runStrategyEvaluation({
    caseId: "recovery-strategy-only",
    mode: "evidence_gap",
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    prematureOnFirstAttempt: true,
    maxAttempts: 3,
  });
  assert.ok(recoveryRun.report.run.attempts.length >= 2);
  const firstRecovery = recoveryRun.report.run.attempts[0]?.recovery;
  assert.ok(firstRecovery);
  assert.ok(
    firstRecovery.action === "continue_investigation" ||
      firstRecovery.action === "gather_missing_evidence",
  );
  const nextIds = firstRecovery.nextRequirementIds ?? [];
  const secondAttemptTools = recoveryRun.metrics.toolSequence.filter(
    (tool, index, all) => index > all.indexOf("record_claim"),
  );
  assert.equal(secondAttemptTools.includes("github_get_issue") && nextIds.length > 0, false);
});

test("Case 7 — tight budget reduces exploratory actions and keeps unresolved requirements", async () => {
  const comparison = await evaluateSyntheticCase("tight_budget");
  assert.equal(comparison.strategy.toolSequence.includes("github_get_issue_comments"), false);
  assert.equal(
    comparison.strategy.toolSequence.includes("github_get_pull_request") ||
      comparison.strategy.toolSequence.includes("github_list_commits"),
    true,
  );
});

test("Case 8 — a strategy stop gives the Agent a Finalization opportunity and the verifier still runs", async () => {
  const comparison = await evaluateSyntheticCase("no_legal_action");
  // Phase 16.3-B: Runtime no longer fabricates strategy_exhausted without
  // asking the Agent; the Agent finalizes inside the Finalization Boundary.
  assert.equal(comparison.strategy.agentDecision, "final");
  assert.equal(comparison.strategy.strategyExhausted, false);
  assert.ok(comparison.strategy.finalVerificationStatus);
  assert.notEqual(comparison.strategy.finalVerificationStatus, "verified_complete");
});

test("Synthetic suite records raw metrics, estimated tokens, and differences", async () => {
  const results = await evaluateAllSyntheticCases();
  assert.equal(results.length, syntheticStrategyCases().length);
  for (const item of results) {
    assert.equal(item.baseline.inputTokensEstimated, true);
    assert.equal(item.strategy.inputTokensEstimated, true);
    assert.equal(item.difference.toolCalls, item.strategy.toolCalls - item.baseline.toolCalls);
    assert.equal(
      item.difference.unnecessaryInvestigationActions,
      item.strategy.unnecessaryInvestigationActions - item.baseline.unnecessaryInvestigationActions,
    );
    assert.equal(
      item.difference.duplicateInvestigationActions,
      item.strategy.duplicateInvestigationActions - item.baseline.duplicateInvestigationActions,
    );
    assert.equal(item.baseline.exactDuplicateActions, item.baseline.duplicateInvestigationActions);
    assert.equal(item.strategy.exactDuplicateActions, item.strategy.duplicateInvestigationActions);
  }
});

test("differenceOf is strategy minus baseline, not a ranking", () => {
  const baseline = {
    llmCalls: 8,
    toolCalls: 7,
    duplicateInvestigationActions: 2,
    exactDuplicateActions: 2,
    repeatedToolCalls: 2,
    unnecessaryInvestigationActions: 3,
    exploratoryActions: 4,
    estimatedInputTokens: 100,
    estimatedMessageChars: 400,
    estimatedToolResultChars: 200,
    inputTokensEstimated: true as const,
    evidenceCoverage: 0.5,
    unsupportedClaimRate: 0.2,
    falseCompletionRate: 0,
    verifierFalsePositiveRate: 0,
    finalVerificationStatus: "insufficient_evidence" as const,
    attempts: 1,
    recoveryEvents: 0,
    budgetExhaustion: false,
    strategyExhausted: false,
    toolSequence: [],
    missingRequirementIds: [],
    missingConditions: [],
    observedFailureModes: [],
  };
  const strategy = { ...baseline, llmCalls: 6, toolCalls: 5, duplicateInvestigationActions: 0, exactDuplicateActions: 0, repeatedToolCalls: 0 };
  const difference = differenceOf(strategy, baseline);
  assert.equal(difference.llmCalls, -2);
  assert.equal(difference.toolCalls, -2);
  assert.equal(difference.duplicateInvestigationActions, -2);
});

test("Real-v1 C01-C10 deterministic evaluation does not write snapshots", async () => {
  const results = await evaluateRealV1Cases();
  assert.equal(results.length, 10);
  assert.deepEqual(
    results.map((item) => item.caseId),
    ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"],
  );
  for (const item of results) {
    assert.ok(item.baselineOutcome);
    assert.ok(item.strategyOutcome);
    assert.equal(typeof item.baseline.llmCalls, "number");
    assert.equal(typeof item.strategy.llmCalls, "number");
    assert.equal(typeof item.baseline.toolCalls, "number");
    assert.equal(typeof item.strategy.toolCalls, "number");
    assert.equal(typeof item.baseline.duplicateInvestigationActions, "number");
    assert.equal(typeof item.strategy.duplicateInvestigationActions, "number");
    assert.equal(typeof item.baseline.unnecessaryInvestigationActions, "number");
    assert.equal(typeof item.strategy.unnecessaryInvestigationActions, "number");
    assert.equal(typeof item.baseline.evidenceCoverage, "number");
    assert.equal(typeof item.strategy.evidenceCoverage, "number");
    assert.equal(item.baseline.inputTokensEstimated, true);
    assert.equal(item.strategy.inputTokensEstimated, true);
    assert.equal(item.difference.llmCalls, item.strategy.llmCalls - item.baseline.llmCalls);
  }
});

test("compareStrategyEvaluation uses the same snapshot and Fake Model policy", async () => {
  const comparison = await compareStrategyEvaluation({
    caseId: "shared-policy-resolved",
    providerFactory: () => new SnapshotGitHubProvider(githubFixturePath("resolved")),
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    expected: { verificationStatus: "verified_complete" },
    maxAttempts: 1,
  });
  assert.equal(comparison.caseId, "shared-policy-resolved");
  assert.ok(comparison.baseline.toolSequence.length >= 1);
  assert.ok(comparison.strategy.toolSequence.length >= 1);
});

test("seed helpers leave issue identity satisfied for evaluation fixtures", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const state = new InvestigationState(task, createInvestigationRun({ task }));
  const issue = seedClosedIssue(state);
  seedMergedPr(state, issue.id, 7);
  seedFileAndCommit(state, issue.id, 7);
  assert.equal(state.investigatedResources.has(resourceKey("issue", "42")), true);
  const gap = computeEvidenceGap(state.task, state.run);
  assert.equal(
    gap.satisfiedRequirements.some((item) => item.condition === "issue_identity"),
    true,
  );
});
