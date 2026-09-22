import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationSessionDTO } from "../src/api/dto.ts";
import {
  buildInvestigationFindings,
  buildInvestigationResultView,
  presentAgentConclusionView,
} from "../web/src/lib/investigation-presentation.ts";

function session(overrides: Partial<InvestigationSessionDTO> = {}): InvestigationSessionDTO {
  return {
    mode: "snapshot",
    dataSource: "snapshot",
    actor: "test_driver",
    status: "investigated",
    runStatus: "verified_complete",
    task: { owner: "acme", repository: "box", issueNumber: 42, description: "investigate" },
    issue: { owner: "acme", repository: "box", number: 42, title: "Null pointer", state: "closed" },
    agentOutput: "Looks resolved.",
    verification: {
      status: "verified_complete",
      evidenceCoverage: 1,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [{ id: "issue-identity", name: "issue identity", status: "pass", message: "ok" }],
    },
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted", source: "github" },
    ],
    relations: [],
    claims: [],
    claimEvidence: [],
    steps: [{ step: 1, tool: "get_issue", success: true, evidenceIds: ["ev-issue"] }],
    attempts: [],
    report: {
      conclusion: "Looks resolved.",
      polarity: "resolved",
      uncertainty: "",
      openQuestions: [],
    },
    ...overrides,
  };
}

test("17-B1.1 有真实 AgentResult.output 时 conclusionSource = agent_report", () => {
  const current = session({ agentOutput: "I found a merged PR." });
  const presented = presentAgentConclusionView(current);
  assert.equal(presented.source, "agent_report");
  assert.equal(presented.text, "I found a merged PR.");
  const view = buildInvestigationResultView(current);
  assert.equal(view.agent.conclusionSource, "agent_report");
  assert.equal(view.agent.conclusion, "I found a merged PR.");
});

test("17-B1.2 无真实 AgentResult.output 时不得伪装成 Agent 结论", () => {
  const missing = session({ agentOutput: undefined, rawAgentOutput: undefined });
  const presented = presentAgentConclusionView(missing);
  assert.equal(presented.source, "presentation_fallback");
  assert.equal(presented.text, "本次调查没有产生 Agent 最终回答。");
  const unconfigured = session({ actor: "unconfigured", agentOutput: undefined, rawAgentOutput: undefined });
  assert.equal(presentAgentConclusionView(unconfigured).source, "presentation_fallback");
  const view = buildInvestigationResultView(missing);
  assert.equal(view.agent.conclusionSource, "presentation_fallback");
  // UI（AgentAnswerPanel）以 conclusionSource 决定「Agent 原始回答」/「系统说明」标题，fallback 文本不进入 Agent 结论栏。
  assert.doesNotMatch(JSON.stringify(view.statusLabel + view.summary), /没有产生 Agent 最终回答/);
});

test("17-B1.3 status 唯一来源是 verification.status，不受 session.status / runStatus / Agent 输出影响", () => {
  const current = session({
    status: "investigated",
    runStatus: "verified_complete",
    agentOutput: "This issue is definitely resolved.",
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.33,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr"],
      unsupportedClaimIds: [],
      checks: [],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.equal(view.status, "not_verified");
  assert.equal(view.statusLabel, "暂未确认解决");
  assert.doesNotMatch(view.summary, /没有解决|未解决。$/);
});

test("17-B1.4 report.polarity 变化不改变 result.status / summary", () => {
  const resolved = session({ report: { conclusion: "a", polarity: "resolved", uncertainty: "", openQuestions: [] } });
  const unknown = session({ report: { conclusion: "b", polarity: "unknown", uncertainty: "", openQuestions: [] } });
  const a = buildInvestigationResultView(resolved);
  const b = buildInvestigationResultView(unknown);
  assert.equal(a.status, b.status);
  assert.equal(a.statusLabel, b.statusLabel);
  assert.equal(a.summary, b.summary);
  assert.equal(a.verification.status, b.verification.status);
});

test("17-B1.5 finding 通过 evidenceIds 溯源到真实 Evidence", () => {
  const current = session({
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      { id: "ev-pr", kind: "pull_request", summary: "PR #7 fixes the NPE", trust: "external_untrusted", resource: "pull/7" },
      { id: "ev-commit", kind: "commit", summary: "Commit abcdef: fix npe", trust: "external_untrusted" },
    ],
    relations: [{ fromEvidenceId: "ev-pr", toEvidenceId: "ev-issue", type: "fixes" }],
  });
  const findings = buildInvestigationFindings(current);
  assert.deepEqual(findings.find((item) => item.id === "issue-state")?.evidenceIds, ["ev-issue"]);
  assert.deepEqual(findings.find((item) => item.id === "pr-present")?.evidenceIds, ["ev-pr"]);
  assert.deepEqual(findings.find((item) => item.id === "commit-present")?.evidenceIds, ["ev-commit"]);
  assert.deepEqual(findings.find((item) => item.id === "resolution-chain")?.evidenceIds, ["ev-pr", "ev-issue"]);
  // fixes 只证明解决候选关联 Issue，不证明 PR 已合并
  assert.equal(findings.find((item) => item.id === "pr-present")?.text.includes("已合并"), false);
});

test("17-B1.6 无可证明关联的 finding evidenceIds 为空数组，不虚构", () => {
  const current = session({
    issue: { owner: "acme", repository: "box", number: 42, state: undefined },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #42", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_pull_request", success: true, evidenceIds: [] },
    ],
  });
  const emptyFinding = buildInvestigationFindings(current).find((item) => item.id === "pr-checked-empty");
  assert.ok(emptyFinding);
  assert.deepEqual(emptyFinding?.evidenceIds, []);
  for (const finding of buildInvestigationFindings(current)) {
    for (const id of finding.evidenceIds) {
      assert.ok(current.evidence.some((item) => item.id === id));
    }
  }
});

test("17-B1.7 openQuestions 合并去重且保留来源语义", () => {
  const current = session({
    agentOutput: undefined,
    rawAgentOutput: undefined,
    report: {
      conclusion: "x",
      polarity: "unknown",
      uncertainty: "Agent conclusion is not verification.",
      openQuestions: [
        "No merged pull request, commit, or other resolution evidence was found.",
        "The observed diff cannot prove runtime behavior.",
      ],
    },
    resolutionAnalyses: [
      {
        candidateEvidenceId: "ev-pr",
        issueEvidenceId: "ev-issue",
        codeRelevance: "insufficient code-change context",
        behavioralAlignment: "insufficient code-change context",
        testSupport: "insufficient code-change context",
        unresolvedQuestions: [
          "The observed diff cannot prove runtime behavior.",
          "No test execution results were observed.",
        ],
        supportingEvidenceIds: [],
        claimIds: [],
      },
    ],
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.openQuestions, [
    "是否存在尚未关联到 Issue 的修复？",
    "观察到的代码差异能否在运行时证明问题已修复？",
    "是否存在测试执行结果？",
  ]);
  assert.deepEqual(view.uncertainty, ["Agent conclusion is not verification."]);
});

test("17-B1.8 unsupportedClaimIds 直接进入 result.verification，不重算", () => {
  const current = session({
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr"],
      unsupportedClaimIds: ["claim-1", "claim-2"],
      checks: [],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.verification.unsupportedClaimIds, ["claim-1", "claim-2"]);
  assert.deepEqual(view.verification.missingRequirementIds, ["req-pr"]);
});

test("17-B1.9 prematureCompletion 直接进入 result.verification", () => {
  const current = session({
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: true,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
  });
  assert.equal(buildInvestigationResultView(current).verification.prematureCompletion, true);
});

test("17-B1.10 evidenceCoverage 原值直接进入 result.verification", () => {
  const current = session({
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.333,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
  });
  assert.equal(buildInvestigationResultView(current).verification.evidenceCoverage, 0.333);
});

test("17-B1.11 Agent 输出不进入 Evidence 层", () => {
  const current = session({
    agentOutput: "I found PR #99 merged and commit deadbeef fixing everything.",
    rawAgentOutput: "I found PR #99 merged and commit deadbeef fixing everything.",
  });
  const view = buildInvestigationResultView(current);
  const evidenceIds = new Set(current.evidence.map((item) => item.id));
  assert.deepEqual(
    view.evidence.map((item) => item.id),
    [...evidenceIds],
  );
  assert.equal(view.evidence.some((item) => item.summary.includes("PR #99")), false);
  assert.equal(
    view.findings.some((item) => item.text.includes("PR #99")),
    false,
  );
});

test("17-B1.12A fixes relation 单独出现时不得宣称已合并", () => {
  const current = session({
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      { id: "ev-pr", kind: "pull_request", summary: "PR #7 merged=true", trust: "external_untrusted", resource: "pull/7" },
    ],
    relations: [{ fromEvidenceId: "ev-pr", toEvidenceId: "ev-issue", type: "fixes" }],
  });
  const finding = buildInvestigationFindings(current).find((item) => item.id === "pr-present");
  assert.ok(finding);
  assert.equal(finding?.text.includes("已合并"), false);
  assert.equal(finding?.text.includes("未合并"), false);
  assert.equal(finding?.tone, "warn");
});

test("17-B1.12B fixes + merges→PR 时判定已合并且证据可溯源", () => {
  const current = session({
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      { id: "ev-pr", kind: "pull_request", summary: "PR #7 fixes NPE", trust: "external_untrusted", resource: "pull/7" },
      { id: "ev-merge", kind: "pull_request", summary: "merge record for PR #7", trust: "harness_derived", resource: "pull/7" },
    ],
    relations: [
      { fromEvidenceId: "ev-pr", toEvidenceId: "ev-issue", type: "fixes" },
      { fromEvidenceId: "ev-merge", toEvidenceId: "ev-pr", type: "merges" },
    ],
  });
  const finding = buildInvestigationFindings(current).find((item) => item.id === "pr-present");
  assert.equal(finding?.text, "发现关联 Pull Request：#7（已合并）");
  assert.equal(finding?.tone, "pass");
  assert.deepEqual(finding?.evidenceIds, ["ev-pr", "ev-merge"]);
});

test("17-B1.12C merged 只来自结构化 relation，summary 正则不再参与判断", () => {
  // InvestigationEvidenceDTO 没有结构化 merged 字段，因此 merged=true 只能由
  // Evidence Graph 的 merges relation 证明；summary 里写 merged=true 不生效。
  const summaryClaims = session({
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      { id: "ev-pr", kind: "pull_request", summary: "PR #7 merged=true", trust: "external_untrusted", resource: "pull/7" },
    ],
    relations: [],
  });
  assert.equal(
    buildInvestigationFindings(summaryClaims).find((item) => item.id === "pr-present")?.text.includes("已合并"),
    false,
  );
  const relationProves = session({
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      { id: "ev-pr", kind: "pull_request", summary: "PR #7 landed via merge commit", trust: "external_untrusted", resource: "pull/7" },
      { id: "ev-merge", kind: "pull_request", summary: "merge record for PR #7", trust: "harness_derived", resource: "pull/7" },
    ],
    relations: [{ fromEvidenceId: "ev-merge", toEvidenceId: "ev-pr", type: "merges" }],
  });
  const finding = buildInvestigationFindings(relationProves).find((item) => item.id === "pr-present");
  assert.equal(finding?.text.includes("已合并"), true);
  assert.equal(finding?.tone, "pass");
});
