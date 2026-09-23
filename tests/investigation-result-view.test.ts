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

test("19-B.12 F3 待确认事项：harness 英文问句映射为固定中文模板句", () => {
  const current = session({
    agentOutput: undefined,
    rawAgentOutput: undefined,
    report: {
      conclusion: "x",
      polarity: "unknown",
      uncertainty: "",
      openQuestions: [
        "PR #37626 is related but not merged; issue closed is not sufficient resolution evidence.",
        "LLM is not configured; investigation did not run.",
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.openQuestions, [
    "#37626 相关但未合并；仅靠 Issue 关闭不足以证明已解决",
    "LLM 未配置，调查未执行。",
  ]);
  // 允许内部术语（Issue/PR/LLM），但不允许成句英文残留。
  assert.doesNotMatch(view.openQuestions.join(" "), /resolution evidence|not merged|did not run/i);
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

test("17-B2.1 verified_complete 时 verdict 汇总通过项且没有缺口", () => {
  const current = session({
    verification: {
      status: "verified_complete",
      evidenceCoverage: 1,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "issue-state", name: "issue state", status: "pass", message: "closed" },
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.verdict.counts, { pass: 2, fail: 0, unknown: 0 });
  assert.deepEqual(view.verdict.gaps, []);
  assert.match(view.verdict.why, /^全部验证项通过/);
});

test("17-B2.2 not_verified 时 verdict 缺口只列 fail 项并带人话解释", () => {
  const current = session({
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "issue-state", name: "issue state", status: "fail", message: "issue still open" },
        { id: "resolution-effect", name: "resolution effect", status: "unknown", message: "unknown" },
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.verdict.gaps.map((item) => item.id), ["issue-state"]);
  assert.match(view.verdict.gaps[0].explanation, /Issue 目前仍是打开的/);
  assert.match(view.verdict.why, /已验证到的部分/);
  assert.deepEqual(view.verdict.counts, { pass: 1, fail: 1, unknown: 1 });
});

test("17-B2.3 insufficient_evidence 时 verdict 缺口列未知检查与缺失证据要求", () => {
  const current = session({
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.2,
      prematureCompletion: false,
      missingRequirementIds: ["resolution-evidence"],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "resolution-effect", name: "resolution effect", status: "unknown", message: "unknown" },
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.verdict.gaps.map((item) => item.id), [
    "resolution-effect",
    "resolution-evidence",
  ]);
  assert.equal(view.verdict.gaps.every((item) => item.mark === "?"), true);
});

test("17-B2.4 Agent claims 的 supported 只来自 unsupportedClaimIds，不重算", () => {
  const current = session({
    claims: [
      { id: "claim-1", text: "PR #7 fixes the NPE", polarity: "resolved", critical: true },
      { id: "claim-2", text: "Tests cover the fix", polarity: "resolved", critical: false },
    ],
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: ["claim-2"],
      checks: [],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.agent.claims, [
    { id: "claim-1", text: "PR #7 fixes the NPE", critical: true, supported: true },
    { id: "claim-2", text: "Tests cover the fix", critical: false, supported: false },
  ]);
});

test("17-B2.5 harness 检查项带 explanation，供验证明细展示人话", () => {
  const current = session({
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.2,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [{ id: "resolution-effect", name: "resolution effect", status: "unknown", message: "unknown" }],
    },
  });
  const check = buildInvestigationResultView(current).verification.checks[0];
  assert.equal(typeof check.explanation, "string");
  assert.ok(check.explanation && check.explanation.length > 0);
});

const notVerifiedCheckSession = (extra: Partial<InvestigationSessionDTO> = {}): InvestigationSessionDTO =>
  session({
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.5,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "pr merged", status: "fail", message: "refuted" },
      ],
    },
    ...extra,
  });

test("18-C.1 mid_run + 预算耗尽：hero 标记与「还差什么」首行，checks 不变", () => {
  const base = buildInvestigationResultView(notVerifiedCheckSession());
  const view = buildInvestigationResultView(
    notVerifiedCheckSession({
      attributionCoverage: {
        state: "mid_run",
        prescanState: "incomplete",
        candidatesEnumerated: 10,
        candidatesAdjudicated: 8,
        unadjudicatedCandidates: [11, 12],
        unenumeratedCandidates: 0,
        budgetExhausted: true,
      },
    }),
  );
  assert.equal(view.coverage?.marker, "中间结论 · 预算耗尽");
  assert.equal(view.coverage?.unadjudicatedCount, 2);
  assert.equal(view.verdict.gaps[0]?.id, "attribution-coverage");
  assert.match(view.verdict.gaps[0]?.label ?? "", /还有 2 个解决候选未完成机器裁决/);
  // 呈现层只加文案：状态、缺口尾部、checks 与无 coverage 的基线完全一致。
  assert.deepEqual(view.verdict.gaps.slice(1), base.verdict.gaps);
  assert.deepEqual(view.verification.checks, base.verification.checks);
  assert.equal(view.status, base.status);
});

test("18-C.2 mid_run 但候选已全部裁决（扫描源失败）：未穷尽文案", () => {
  const view = buildInvestigationResultView(
    notVerifiedCheckSession({
      attributionCoverage: {
        state: "mid_run",
        prescanState: "incomplete",
        candidatesEnumerated: 3,
        candidatesAdjudicated: 3,
        unadjudicatedCandidates: [],
        unenumeratedCandidates: 0,
        budgetExhausted: false,
      },
    }),
  );
  assert.equal(view.coverage?.marker, "中间结论 · 未穷尽");
  assert.match(view.verdict.gaps[0]?.label ?? "", /候选扫描未穷尽/);
});

test("18-C.3 exhausted：已收敛不加噪", () => {
  const base = buildInvestigationResultView(notVerifiedCheckSession());
  const view = buildInvestigationResultView(
    notVerifiedCheckSession({
      attributionCoverage: {
        state: "exhausted",
        prescanState: "completed",
        candidatesEnumerated: 10,
        candidatesAdjudicated: 10,
        unadjudicatedCandidates: [],
        unenumeratedCandidates: 0,
        budgetExhausted: false,
      },
    }),
  );
  assert.equal(view.coverage?.marker, undefined);
  assert.deepEqual(view.verdict.gaps, base.verdict.gaps);
});

test("18-C.4 无 coverage 字段（旧快照）：呈现与基线完全一致", () => {
  const base = buildInvestigationResultView(notVerifiedCheckSession());
  const view = buildInvestigationResultView(
    notVerifiedCheckSession({ attributionCoverage: undefined }),
  );
  assert.equal(view.coverage, undefined);
  assert.deepEqual(view.verdict, base.verdict);
});
