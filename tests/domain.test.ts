import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendAttempt,
  bindClaimEvidence,
  buildVerificationResult,
  createClaim,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
  evidenceCoverage,
  latestAttempt,
  planRecovery,
  recoveryActionFor,
  unsupportedClaims,
} from "../src/domain/index.js";
import type { FailureType, VerificationCheck } from "../src/domain/index.js";

const now = "2026-09-17T00:00:00.000Z";

function issueEvidence() {
  return createEvidence({
    kind: "issue",
    summary: "Issue #42 is closed",
    payload: { number: 42, repository: "acme/box", state: "closed", title: "bug", body: "" },
    provenance: {
      source: "github",
      url: "https://github.com/acme/box/issues/42",
      repository: "acme/box",
      resource: "issues/42",
      retrievedAt: now,
      trust: "external_untrusted",
    },
  });
}

function prEvidence() {
  return createEvidence({
    kind: "pull_request",
    summary: "PR #7 merged",
    payload: { number: 7, repository: "acme/box", merged: true, state: "closed" },
    provenance: {
      source: "github",
      url: "https://github.com/acme/box/pull/7",
      repository: "acme/box",
      resource: "pull/7",
      retrievedAt: now,
      trust: "external_untrusted",
    },
  });
}

function passingChecks(evidenceIds: string[]): VerificationCheck[] {
  return [
    {
      id: "identity",
      name: "issue identity",
      type: "identity",
      status: "pass",
      severity: "critical",
      message: "owner/repo#issue 与任务一致",
      evidenceIds,
    },
    {
      id: "issue-state",
      name: "issue state",
      type: "issue_state",
      status: "pass",
      severity: "required",
      message: "Issue closed",
      evidenceIds,
    },
    {
      id: "pr-merge",
      name: "pr merge",
      type: "pr_merge",
      status: "pass",
      severity: "required",
      message: "关联 PR 已合并",
      evidenceIds,
    },
    {
      id: "claim-coverage",
      name: "claim coverage",
      type: "claim_coverage",
      status: "pass",
      severity: "required",
      message: "关键 Claim 均有 supporting evidence",
      evidenceIds,
    },
  ];
}

test("Domain：任务身份是 owner/repo/issue，不是工具或模型配置", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  assert.equal(task.target.owner, "acme");
  assert.equal(task.target.issueNumber, 42);
  assert.match(task.target.url ?? "", /issues\/42/);
  assert.ok(task.requirements.some((item) => item.kind === "issue"));
});

test("Domain：非法 issueNumber 被拒绝", () => {
  assert.throws(() =>
    createInvestigationTask({
      target: { owner: "acme", repository: "box", issueNumber: 0 },
    }),
  );
});

test("Domain：GitHub 来源证据一律 external_untrusted", () => {
  const evidence = issueEvidence();
  assert.equal(evidence.provenance.trust, "external_untrusted");
  assert.equal(evidence.provenance.source, "github");
  assert.ok(evidence.provenance.url);
  assert.ok(evidence.provenance.repository);
  assert.ok(evidence.provenance.retrievedAt);
});

test("Domain：没有 supporting evidence 的关键 Claim 不能过验证", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const claim = createClaim({
    text: "Issue #42 was resolved by PR #7.",
    polarity: "resolved",
  });
  const result = buildVerificationResult({
    checks: passingChecks([]),
    requirements: task.requirements,
    claims: [claim],
    claimEvidence: [],
    evidence: [],
    task,
    agentClaimedComplete: true,
  });

  assert.equal(result.status, "insufficient_evidence");
  assert.deepEqual(result.unsupportedClaimIds, [claim.id]);
  assert.equal(result.prematureCompletion, true);
});

test("Domain：Agent 结论不是真相，检查与证据齐了才 verified_complete", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const issue = issueEvidence();
  const pr = prEvidence();
  const commit = createEvidence({
    kind: "commit",
    summary: "abc123 merges the fix",
    payload: { sha: "abc123", repository: "acme/box" },
    provenance: {
      source: "github",
      url: "https://github.com/acme/box/commit/abc123",
      repository: "acme/box",
      resource: "commit/abc123",
      retrievedAt: now,
      trust: "external_untrusted",
    },
  });
  const claim = createClaim({
    text: "Issue #42 was resolved by PR #7.",
    polarity: "resolved",
  });
  const links = [
    bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" }),
  ];
  const relation = createRelation({
    fromEvidenceId: pr.id,
    toEvidenceId: issue.id,
    type: "fixes",
  });
  const codeLink = createRelation({
    fromEvidenceId: commit.id,
    toEvidenceId: pr.id,
    type: "derived_from",
  });
  assert.equal(relation.type, "fixes");
  const allEvidence = [issue, pr, commit];
  const relations = [relation, codeLink];

  const incomplete = buildVerificationResult({
    checks: passingChecks([issue.id]),
    requirements: task.requirements,
    claims: [claim],
    claimEvidence: links,
    evidence: [issue],
    task,
    relations,
    agentClaimedComplete: true,
  });
  assert.equal(incomplete.status, "insufficient_evidence");
  assert.ok(incomplete.missingRequirementIds.includes("req-pr"));

  const complete = buildVerificationResult({
    checks: passingChecks([issue.id, pr.id, commit.id]),
    requirements: task.requirements,
    claims: [claim],
    claimEvidence: links,
    evidence: allEvidence,
    task,
    relations,
    agentClaimedComplete: true,
  });
  assert.equal(complete.status, "verified_complete");
  assert.equal(complete.prematureCompletion, false);
  assert.equal(complete.evidenceCoverage, 1);
  assert.equal(unsupportedClaims([claim], links, allEvidence).length, 0);
});

test("Domain：空检查列表不能 verified_complete", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 1 },
    requirements: [],
  });
  const result = buildVerificationResult({
    checks: [],
    requirements: [],
    claims: [],
    claimEvidence: [],
    evidence: [],
    task,
    agentClaimedComplete: true,
  });
  assert.equal(result.status, "not_verified");
});

test("Domain：evidenceCoverage 按 requirement 满足比例计算", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  assert.equal(
    evidenceCoverage(task.requirements, {
      task,
      graph: { evidence: [issueEvidence()], relations: [], claims: [], claimEvidence: [] },
    }),
    1 / 3,
  );
});

test("Domain：Failure Type 映射到不同 Recovery，没有统一 retry", () => {
  const types: FailureType[] = [
    "tool_failure",
    "retrieval_failure",
    "premature_completion",
    "loop_failure",
    "insufficient_evidence",
    "invalid_evidence",
    "wrong_target",
    "runtime_budget_exceeded",
    "unknown",
  ];
  const actions = types.map((type) => recoveryActionFor(type));
  assert.ok(new Set(actions).size >= 6);
  assert.equal(planRecovery("tool_failure").action, "retry_with_backoff");
  assert.equal(planRecovery("retrieval_failure").action, "change_retrieval_strategy");
  assert.equal(planRecovery("premature_completion").action, "continue_investigation");
  assert.equal(planRecovery("insufficient_evidence").action, "gather_missing_evidence");
  assert.equal(planRecovery("invalid_evidence").action, "revalidate_evidence");
  assert.equal(planRecovery("wrong_target").action, "recheck_target");
  assert.equal(planRecovery("wrong_target").resetEvidence, true);
  assert.equal(planRecovery("loop_failure").action, "stop");
  assert.equal(planRecovery("runtime_budget_exceeded").action, "stop");
  assert.equal(planRecovery("unknown").action, "stop");
  assert.notEqual(
    planRecovery("tool_failure").action,
    planRecovery("premature_completion").action,
  );
  assert.equal(
    actions.filter((action) => action === "retry_with_backoff").length,
    1,
  );
});

test("Domain：Attempt 只能追加，不能覆盖既有调查轨迹", () => {
  const task = createInvestigationTask({
    id: "task-1",
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  let run = createInvestigationRun({ task, startedAt: now });
  run = appendAttempt(run, {
    evidenceIds: ["e1"],
    claimIds: ["c1"],
    agentConclusion: "resolved",
    startedAt: now,
  });
  run = appendAttempt(run, {
    evidenceIds: ["e1", "e2"],
    claimIds: ["c1"],
    agentConclusion: "resolved by PR",
    startedAt: now,
    recovery: planRecovery("insufficient_evidence"),
  });

  assert.equal(run.attempts.length, 2);
  assert.equal(run.attempts[0]?.attempt, 1);
  assert.equal(run.attempts[1]?.attempt, 2);
  assert.equal(run.attempts[0]?.id, "attempt-1");
  assert.equal(run.attempts[1]?.id, "attempt-2");
  assert.equal(run.attempts[0]?.evidenceIds.length, 1);
  assert.equal(latestAttempt(run)?.recovery?.action, "gather_missing_evidence");
});

test("Domain：源码不依赖 React、Hono、GitHub API、LLM Provider", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/domain");
  const forbidden =
    /from ["'].*(react|hono|octokit|openai|tools\/github|agent\/openai-compat|server\/app)["']/;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(dir, file), "utf8");
    assert.equal(forbidden.test(source), false, file);
  }
});
