import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationSessionDTO } from "../src/api/dto.ts";
import {
  agentHarnessDisagree,
  buildInvestigationSteps,
  buildTraceItems,
  catalogRunRequest,
  checkLabel,
  evidenceCoverageLabel,
  exampleHeading,
  featuredExamples,
  filterEvidence,
  formatMetric,
  investigationErrorTitle,
  investigationMode,
  investigationModeDetail,
  isNotFoundError,
  recoveredFrom,
  repositoryDisplayName,
  requirementLabel,
  toolStepLabel,
  uniqueEvidenceKinds,
  verificationLabel,
  verificationSubtitle,
  verificationTone,
} from "../web/src/lib/workbench.ts";
import {
  buildInvestigationFindings,
  buildInvestigationResultView,
  incidentIsInvestigationFailure,
  investigationIncident,
  isEvidenceInsufficiency,
  isProcessFailure,
  presentAgentConclusion,
  presentAgentJudgment,
  presentResolutionAnalyses,
  presentUnresolvedQuestions,
  rawAgentOutputText,
} from "../web/src/lib/investigation-presentation.ts";

test("UI：verification status 使用中文，不把 insufficient 显示成 FAILED", () => {
  assert.equal(verificationLabel("verified_complete"), "已验证解决");
  assert.equal(verificationLabel("not_verified"), "暂未确认解决");
  assert.equal(verificationLabel("insufficient_evidence"), "证据不足");
  assert.notEqual(verificationLabel("insufficient_evidence"), "FAILED");
  assert.notEqual(verificationLabel("not_verified"), "FAILED");
  assert.equal(verificationTone("verified_complete"), "verified");
  assert.equal(verificationTone("not_verified"), "not_verified");
  assert.equal(verificationTone("insufficient_evidence"), "insufficient");
  assert.notEqual(verificationTone("not_verified"), verificationTone("insufficient_evidence"));
});

test("UI：HTTP 404 显示未找到这次调查；live 404 显示未找到该 Issue", () => {
  assert.equal(isNotFoundError({ status: 404, message: "missing snapshot" }), true);
  assert.equal(investigationErrorTitle({ status: 404, message: "missing snapshot" }), "未找到这次调查");
  assert.equal(investigationErrorTitle({ code: "GITHUB_NOT_FOUND", status: 404 }), "未找到该 Issue");
  assert.equal(investigationErrorTitle({ status: 400, message: "bad request" }), "无法调查这个 Issue。");
  assert.equal(
    investigationErrorTitle({ code: "GITHUB_RATE_LIMITED", status: 429 }),
    "GitHub 接口已达到速率限制。",
  );
});

test("UI：Evidence 过滤只使用实际 kind，不编造数据", () => {
  const items = [
    { id: "e1", kind: "issue", summary: "Issue #1", trust: "external_untrusted" },
    { id: "e2", kind: "pull_request", summary: "PR #2", trust: "external_untrusted" },
  ];
  assert.deepEqual(uniqueEvidenceKinds(items), ["issue", "pull_request"]);
  assert.equal(filterEvidence(items, "issue").length, 1);
  assert.equal(filterEvidence(items, "commit").length, 0);
  assert.equal(filterEvidence(items, "all").length, 2);
});

test("UI：metrics 动态格式化，不硬编码成功率", () => {
  assert.equal(formatMetric("taskSuccessRate", 0.6), "60%");
  assert.equal(formatMetric("averageAttempts", 1), "1");
  assert.equal(formatMetric("averageToolCalls", 7.2), "7.20");
});

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
    claims: [{ id: "c1", text: "Issue is resolved.", polarity: "resolved", critical: true }],
    claimEvidence: [{ claimId: "c1", evidenceId: "ev-issue", role: "supports" }],
    steps: [{ step: 1, tool: "get_issue", success: true, evidenceIds: ["ev-issue"] }],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        status: "failed",
        verificationStatus: "insufficient_evidence",
        checks: [],
        failureType: "tool_failure",
        failureReason: "getIssue timed out",
        recoveryAction: "retry_with_backoff",
        evidenceIds: [],
        claimIds: [],
      },
      {
        id: "attempt-2",
        attempt: 2,
        status: "verified",
        parentAttemptId: "attempt-1",
        verificationStatus: "verified_complete",
        checks: [],
        evidenceIds: ["ev-issue"],
        claimIds: ["c1"],
      },
    ],
    report: {
      conclusion: "Looks resolved.",
      polarity: "resolved",
      uncertainty: "Agent conclusion is not verification.",
      openQuestions: [],
    },
    ...overrides,
  };
}

test("UI：trace / recovery chain 来自 session 数据", () => {
  const current = session();
  const trace = buildTraceItems(current);
  assert.equal(trace[0]?.label, "调查开始");
  assert.ok(trace.some((item) => item.label === "获取 Issue"));
  assert.ok(trace.some((item) => item.label === "失败" && item.detail === "工具调用失败"));
  assert.ok(trace.some((item) => item.label === "恢复" && item.detail === "稍后重试失败的工具调用"));
  const second = current.attempts[1];
  assert.equal(recoveredFrom(second, current.attempts)?.attempt, 1);
});

test("UI：unknown issue 文案不编造已验证解决", () => {
  assert.equal(investigationErrorTitle({ status: 404 }), "未找到这次调查");
  assert.notEqual(verificationLabel(undefined), "已验证解决");
});

test("UI：example labels 来自 repository / issue，不从 identifier 推导 verification", () => {
  assert.equal(repositoryDisplayName("vscode"), "VS Code");
  assert.equal(repositoryDisplayName("streamlit"), "Streamlit");
  assert.equal(repositoryDisplayName("playwright-mcp"), "Playwright MCP");
  assert.equal(exampleHeading({ repository: "vscode", issueNumber: 258694 }), "VS Code #258694");
  assert.equal(exampleHeading({ repository: "pytest", issueNumber: 14524 }), "Pytest #14524");
  assert.doesNotMatch(
    exampleHeading({ repository: "vscode", issueNumber: 258694 }),
    /已验证解决|已验证完成|暂未确认解决|证据不足|VERIFIED|NOT VERIFIED|INSUFFICIENT/i,
  );
  assert.deepEqual(
    featuredExamples([{ id: "C01" }, { id: "C02" }, { id: "C03" }, { id: "C04" }]).map((item) => item.id),
    ["C01", "C02", "C03"],
  );
  assert.deepEqual(
    catalogRunRequest({
      id: "C01",
      group: "real-v1",
      owner: "microsoft",
      repository: "vscode",
      issueNumber: 258694,
      label: "microsoft/vscode#258694",
      description: "Investigate whether microsoft/vscode#258694 is independently resolved.",
    }),
    { caseId: "C01", mode: "snapshot" },
  );
  assert.deepEqual(
    catalogRunRequest({
      id: "tool-failure",
      group: "recovery",
      owner: "acme",
      repository: "box",
      issueNumber: 42,
      label: "acme/box#42",
      description: "First GitHub getIssue call times out.",
    }),
    { scenarioId: "tool-failure", mode: "snapshot" },
  );
  assert.equal(
    verificationSubtitle("verified_complete"),
    "全部验证项通过，证据齐备：Harness 可以确认这个 Issue 已解决。",
  );
  assert.equal(verificationLabel("insufficient_evidence"), "证据不足");
  assert.equal(investigationMode({ mode: "live" }), "live");
  assert.equal(investigationMode({ dataSource: "snapshot" }), "snapshot");
  assert.equal(investigationModeDetail("live"), "数据来自 GitHub 公开接口。");
  assert.equal(investigationModeDetail("snapshot"), "使用已录制的 GitHub 数据，结果可复现。");
});

test("UI：C01 / C05 / C08 / C09 / C10 结果文案来自 verifier status", () => {
  const cases = [
    ["C01", "verified_complete", "已验证解决"],
    ["C05", "not_verified", "暂未确认解决"],
    ["C08", "verified_complete", "已验证解决"],
    ["C09", "verified_complete", "已验证解决"],
    ["C10", "insufficient_evidence", "证据不足"],
  ] as const;
  for (const [id, status, label] of cases) {
    assert.equal(verificationLabel(status), label, id);
    assert.notEqual(verificationLabel(status), status);
  }
});

test("UI：内部 requirement id 不作为默认展示", () => {
  assert.equal(requirementLabel("req-pr"), "已合并 Pull Request");
  assert.equal(requirementLabel("req-commit"), "代码 / Commit 证据");
  assert.equal(checkLabel({ id: "issue-identity", name: "issue identity" }), "Issue 身份");
  assert.equal(checkLabel({ id: "pr-merged", name: "resolution landed" }), "已合并 Pull Request");
  assert.equal(checkLabel({ id: "code-commit", name: "resolution code evidence" }), "代码 / Commit 证据");
  assert.equal(toolStepLabel("github_get_issue_timeline"), "查看 Issue Timeline");
  assert.equal(toolStepLabel("get_issue"), "获取 Issue");
});

test("UI：调查过程从现有 steps / evidence 生成，不编造 Runtime 字段", () => {
  const current = session({
    evidence: [
      {
        id: "ev-pr",
        kind: "pull_request",
        summary: "PR #258293",
        trust: "external_untrusted",
        resource: "pull/258293",
      },
    ],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: [] },
      { step: 2, tool: "github_get_pull_request", success: false, evidenceIds: ["ev-pr"] },
    ],
  });
  const steps = buildInvestigationSteps(current);
  assert.equal(steps[0]?.label, "获取 Issue");
  assert.equal(steps[1]?.label, "获取 Pull Request #258293");
  assert.equal(steps[1]?.success, false);
});

test("UI：最终结果来自 verifier，不由 Agent conclusion 决定差异展示", () => {
  const aligned = session({
    report: { conclusion: "Looks resolved.", polarity: "resolved", uncertainty: "", openQuestions: [] },
    verification: {
      status: "verified_complete",
      evidenceCoverage: 1,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
  });
  const disagreed = session({
    report: { conclusion: "I think a PR exists.", polarity: "resolved", uncertainty: "", openQuestions: [] },
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.33,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr", "req-commit"],
      unsupportedClaimIds: [],
      checks: [],
    },
  });
  assert.equal(agentHarnessDisagree(aligned), false);
  assert.equal(agentHarnessDisagree(disagreed), true);
  assert.equal(evidenceCoverageLabel(disagreed), "证据覆盖率：33%");
  assert.equal(verificationLabel(disagreed.verification?.status), "证据不足");
});

test("UI：内部 enum 映射为中文，不把 runtime 术语直接给用户", () => {
  assert.equal(verificationLabel("verified_complete"), "已验证解决");
  assert.equal(verificationLabel("not_verified"), "暂未确认解决");
  assert.equal(verificationLabel("insufficient_evidence"), "证据不足");
  assert.equal(isProcessFailure("tool_failure"), true);
  assert.equal(isProcessFailure("retrieval_failure"), true);
  assert.equal(isProcessFailure("premature_completion"), true);
  assert.equal(isProcessFailure("loop_failure"), true);
  assert.equal(isEvidenceInsufficiency("insufficient_evidence"), true);
  assert.equal(isProcessFailure("insufficient_evidence"), false);
  assert.equal(requirementLabel("req-pr"), "已合并 Pull Request");
  assert.notEqual(requirementLabel("req-pr"), "nextRequirementIds");
});

test("UI：verified_complete 展示已验证解决，不把 Agent 结论当成验证", () => {
  const current = session({
    issue: { owner: "acme", repository: "box", number: 42, title: "Null pointer", state: "closed" },
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" },
      {
        id: "ev-pr",
        kind: "pull_request",
        summary: "PR #7 merged=true",
        trust: "external_untrusted",
        resource: "pull/7",
      },
      { id: "ev-commit", kind: "commit", summary: "Commit abcdef: fix npe", trust: "external_untrusted" },
    ],
    relations: [{ fromEvidenceId: "ev-pr", toEvidenceId: "ev-issue", type: "fixes" }],
    report: { conclusion: "Looks resolved.", polarity: "resolved", uncertainty: "", openQuestions: [] },
    verification: {
      status: "verified_complete",
      evidenceCoverage: 1,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "resolution landed", status: "pass", message: "ok" },
        { id: "code-commit", name: "resolution code evidence", status: "pass", message: "ok" },
      ],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        verificationStatus: "verified_complete",
        checks: [],
        evidenceIds: ["ev-issue", "ev-pr"],
        claimIds: ["c1"],
      },
    ],
  });
  const view = buildInvestigationResultView(current);
  assert.equal(view.statusLabel, "已验证解决");
  assert.equal(view.summary, "全部验证项通过，证据齐备：Harness 可以确认这个 Issue 已解决。");
  assert.equal(view.agent.conclusion, "Looks resolved.");
  assert.equal(view.agent.conclusionSource, "agent_report");
  assert.equal(view.agent.judgment, "调查发现：目前证据指向该 Issue 已经解决。");
  assert.equal(view.verification.satisfiedLabel, "满足 3 / 3 项证据要求");
  assert.equal(view.incident, undefined);
  assert.equal(view.agent.disagreesWithHarness, false);
});

test("UI：not_verified 不显示为调查失败", () => {
  const current = session({
    agentOutput: undefined,
    rawAgentOutput: undefined,
    issue: { owner: "cli", repository: "cli", number: 13070, title: "closed not planned", state: "closed" },
    status: "insufficient_evidence",
    runStatus: "not_verified",
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #13070 is closed", trust: "external_untrusted" },
    ],
    report: {
      conclusion: "Insufficient evidence to explain how issue #13070 was resolved.",
      polarity: "unknown",
      uncertainty: "IndependentCompletionVerifier decides VerificationResult",
      openQuestions: ["No merged pull request, commit, or other resolution evidence was found."],
    },
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.33,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr", "req-commit"],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" },
        { id: "code-commit", name: "resolution code evidence", status: "fail", message: "missing" },
      ],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        verificationStatus: "not_verified",
        checks: [],
        evidenceIds: ["ev-issue"],
        claimIds: [],
      },
    ],
  });
  const view = buildInvestigationResultView(current);
  assert.equal(view.statusLabel, "暂未确认解决");
  assert.notEqual(view.statusLabel, "调查失败");
  assert.equal(view.agent.conclusion, "本次调查没有产生 Agent 最终回答。");
  assert.equal(view.agent.conclusionSource, "presentation_fallback");
  assert.doesNotMatch(view.agent.conclusion, /我检查了|我发现|我的判断是/);
  assert.equal(view.findings.find((item) => item.id === "issue-state")?.text, "Issue 当前状态：已关闭");
  assert.equal(view.findings.some((item) => item.id === "pr-absent" || item.id === "commit-absent"), false);
  assert.equal(view.findings.some((item) => item.id === "resolution-chain"), false);
  assert.equal(view.incident, undefined);
  assert.equal(incidentIsInvestigationFailure(view.incident), false);
  assert.equal(JSON.stringify(view).includes("调查失败"), false);
});

test("UI：INSUFFICIENT_EVIDENCE 显示证据不足，不是 Tool Failure", () => {
  const current = session({
    agentOutput: undefined,
    rawAgentOutput: undefined,
    issue: { owner: "facebook", repository: "react", number: 37395, title: "open issue", state: "open" },
    status: "insufficient_evidence",
    runStatus: "insufficient_evidence",
    evidence: [
      { id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" },
    ],
    report: {
      conclusion: "Insufficient evidence to explain how issue #37395 was resolved.",
      polarity: "unknown",
      uncertainty: "IndependentCompletionVerifier decides VerificationResult",
      openQuestions: ["No merged pull request, commit, or other resolution evidence was found."],
    },
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.333,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr", "req-commit"],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" },
        { id: "code-commit", name: "resolution code evidence", status: "fail", message: "missing" },
      ],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        verificationStatus: "insufficient_evidence",
        checks: [],
        failureType: "insufficient_evidence",
        failureReason: "Required evidence is missing; the harness cannot prove completion.",
        recoveryAction: "stop",
        recoveryReason: "Required evidence is missing and no further useful evidence source remains.",
        missingRequirementIds: ["req-pr", "req-commit"],
        recoveryNextRequirementIds: ["req-pr", "req-commit"],
        evidenceIds: ["ev-issue"],
        claimIds: [],
      },
    ],
  });
  const view = buildInvestigationResultView(current);
  assert.equal(view.statusLabel, "证据不足");
  assert.equal(view.incident?.kind, "insufficient");
  assert.equal(view.incident?.title, "证据不足");
  assert.equal(incidentIsInvestigationFailure(view.incident), false);
  assert.notEqual(view.incident?.kind, "process");
  assert.equal(view.incident?.rawFailureType, "insufficient_evidence");
  assert.match(view.agent.conclusion, /本次调查没有产生 Agent 最终回答/);
  assert.deepEqual(view.openQuestions, ["是否存在尚未关联到 Issue 的修复？"]);
  assert.equal(view.verification.satisfiedLabel, "满足 1 / 3 项证据要求");
  assert.deepEqual(view.incident?.nextEvidence, ["已合并 Pull Request", "代码 / Commit 证据"]);
  assert.equal(view.incident?.recoverySummary, "调查已停止，避免重复执行相同的检索。");
  assert.equal(JSON.stringify(view.incident).includes("调查失败"), false);
  assert.equal(JSON.stringify(view.verification).includes("33.3%"), false);
  assert.equal(evidenceCoverageLabel(current), "证据覆盖率：33.3%");
});

test("UI：真正的 tool failure 才显示调查过程中遇到问题", () => {
  const current = session({
    runStatus: "insufficient_evidence",
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        verificationStatus: "insufficient_evidence",
        checks: [],
        failureType: "tool_failure",
        failureReason: "getIssue timed out",
        failureTool: "github_get_issue",
        recoveryAction: "retry_with_backoff",
        recoveryReason: "Retryable GitHub tool failure (timeout / 429 / 5xx / network). Bounded backoff, keep existing evidence.",
        evidenceIds: [],
        claimIds: [],
      },
    ],
  });
  const incident = investigationIncident(current);
  assert.equal(incident?.kind, "process");
  assert.equal(incident?.title, "调查过程中遇到问题");
  assert.match(incident?.summary ?? "", /工具调用未成功/);
  assert.equal(incidentIsInvestigationFailure(incident), true);
  assert.notEqual(incident?.title, "证据不足");
  assert.notEqual(incident?.title, "调查失败");
});

test("UI：recovery stop 展示停止说明，不展示 Attempt budget 原文", () => {
  const current = session({
    verification: {
      status: "not_verified",
      evidenceCoverage: 0.2,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr"],
      unsupportedClaimIds: [],
      checks: [],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        checks: [],
        recoveryAction: "stop",
        recoveryReason: "Attempt budget reached; stopping.",
        missingRequirementIds: ["req-pr"],
        evidenceIds: [],
        claimIds: [],
      },
    ],
  });
  const incident = investigationIncident(current);
  assert.equal(incident?.title, "调查已停止");
  assert.equal(incident?.summary, "调查已停止，避免重复执行相同的检索。");
  assert.equal(incident?.recoverySummary, "调查已停止，避免重复执行相同的检索。");
  assert.equal(incident?.rawRecoveryReason, "Attempt budget reached; stopping.");
  assert.notEqual(incident?.summary, "Attempt budget reached; stopping.");
});

test("UI：resolution analysis 存在时区分观察事实与 Agent 推断", () => {
  const analyses = presentResolutionAnalyses([
    {
      candidateEvidenceId: "ev-pr",
      issueEvidenceId: "ev-issue",
      mergeCommitSha: "abc123def",
      codeRelevance:
        "Observed facts: src/cart.ts modified +12/-3; bounded patch observed. Inference: these observed code changes may relate to the issue evidence. This is a hypothesis, not verification.",
      behavioralAlignment:
        'Observed facts: issue evidence summary is "empty cart". Inference: the observed diff may correspond to the described problem. Runtime behavior remains unproven.',
      testSupport: "insufficient code-change context",
      unresolvedQuestions: ["The observed diff cannot prove runtime behavior."],
      supportingEvidenceIds: ["ev-pr"],
      claimIds: [],
    },
  ]);
  assert.equal(analyses.length, 1);
  assert.match(analyses[0]?.codeRelevance.observed ?? "", /src\/cart\.ts/);
  assert.match(analyses[0]?.codeRelevance.inference ?? "", /hypothesis|may relate/i);
  assert.equal(analyses[0]?.testSupport.observed, "当前没有足够的代码变更上下文。");
  assert.deepEqual(analyses[0]?.unresolvedQuestions, ["观察到的代码差异能否在运行时证明问题已修复？"]);
});

test("UI：没有 resolution analysis 时不显示空模块", () => {
  const current = session({ resolutionAnalyses: [] });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.agent.resolutionAnalyses, []);
});

test("UI：有 unresolved questions 才显示尚未确认", () => {
  const present = presentUnresolvedQuestions([
    "No merged pull request, commit, or other resolution evidence was found.",
  ]);
  assert.deepEqual(present, ["是否存在尚未关联到 Issue 的修复？"]);
  assert.deepEqual(presentUnresolvedQuestions([]), []);
  assert.deepEqual(presentUnresolvedQuestions(undefined), []);
});

test("UI：证据 / 原始 Agent 输出 / 高级信息默认折叠，且不把百分比作为主结果", () => {
  const current = session({
    rawAgentOutput: "model raw output",
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.333,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" },
        { id: "code-commit", name: "resolution code evidence", status: "fail", message: "missing" },
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.equal(rawAgentOutputText(current), "model raw output");
  assert.equal(view.verification.satisfiedLabel, "满足 1 / 3 项证据要求");
  assert.equal(evidenceCoverageLabel(current), "证据覆盖率：33.3%");
  assert.equal(view.rawAgentOutput, "model raw output");
});

test("UI：没有 investigation step 时不编造 step，也不把 verifier checks 当成步骤", () => {
  const current = session({
    steps: [],
    verification: {
      status: "not_verified",
      evidenceCoverage: 0,
      prematureCompletion: false,
      missingRequirementIds: [],
      unsupportedClaimIds: [],
      checks: [
        { id: "issue-identity", name: "issue identity", status: "pass", message: "ok" },
        { id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" },
      ],
    },
  });
  const view = buildInvestigationResultView(current);
  assert.deepEqual(view.process.steps, []);
  assert.equal(view.process.emptyMessage, "当前版本未记录该步骤的详细过程。");
  assert.equal(view.process.steps.some((item) => item.label.includes("Issue 身份")), false);
});

test("UI：Agent 调查结论与 Harness 验证分开，即使两者不一致也同时保留", () => {
  const current = session({
    agentOutput: "I think a PR exists.",
    report: { conclusion: "I think a PR exists.", polarity: "resolved", uncertainty: "", openQuestions: [] },
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.33,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr"],
      unsupportedClaimIds: [],
      checks: [{ id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" }],
    },
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        checks: [],
        failureType: "insufficient_evidence",
        evidenceIds: [],
        claimIds: [],
      },
    ],
  });
  const view = buildInvestigationResultView(current);
  assert.equal(view.agent.judgment, "调查发现：目前证据指向该 Issue 已经解决。");
  assert.equal(view.statusLabel, "证据不足");
  assert.equal(view.agent.disagreesWithHarness, true);
  assert.notEqual(view.agent.judgment, view.statusLabel);
  assert.equal(view.incident?.kind, "insufficient");
});

test("UI：调查发现只来自实际调查步骤与结果，不从 Evidence 缺失推断调查过", () => {
  const current = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
  });
  const findings = buildInvestigationFindings(current);
  assert.equal(findings.find((item) => item.id === "issue-state")?.text, "Issue 当前状态：打开");
  assert.equal(findings.find((item) => item.id === "issue-state")?.source, "evidence");
  assert.equal(findings.some((item) => item.id === "pr-absent"), false);
  assert.equal(findings.some((item) => item.id === "pr-checked-empty"), false);
  assert.equal(findings.some((item) => item.id === "commit-absent"), false);
  assert.equal(findings.some((item) => item.id === "commit-checked-empty"), false);
  assert.equal(findings.some((item) => item.id === "resolution-chain"), false);
  assert.equal(JSON.stringify(findings).includes("未发现关联 Pull Request"), false);
  assert.equal(JSON.stringify(findings).includes("没有找到能够证明问题已修复的 Commit"), false);
  assert.equal(JSON.stringify(findings).includes("没有人修复过这个问题"), false);
  assert.equal(JSON.stringify(findings).includes("Issue 没有被解决"), false);
});

test("UI：查过 PR 且结果为空才展示未找到关联 PR，没查过则不展示", () => {
  const checkedEmpty = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_pull_request", success: true, evidenceIds: [] },
    ],
  });
  const checkedFindings = buildInvestigationFindings(checkedEmpty);
  const emptyPr = checkedFindings.find((item) => item.id === "pr-checked-empty");
  assert.equal(emptyPr?.text, "已检查关联 Pull Request，目前没有找到可用的关联 PR。");
  assert.equal(emptyPr?.source, "investigation_step");
  assert.equal(checkedFindings.some((item) => item.id === "pr-absent"), false);

  const neverChecked = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [{ step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] }],
  });
  const neverFindings = buildInvestigationFindings(neverChecked);
  assert.equal(neverFindings.some((item) => item.id === "pr-checked-empty" || item.id === "pr-absent"), false);
});

test("UI：Timeline / Comments 不是 PR 调查，不能据此生成未找到 PR", () => {
  const timelineOnly = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_issue_timeline", success: true, evidenceIds: [] },
    ],
  });
  const commentsOnly = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_issue_comments", success: true, evidenceIds: [] },
    ],
  });
  const filesOnly = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_pull_request_files", success: true, evidenceIds: [] },
    ],
  });
  for (const current of [timelineOnly, commentsOnly, filesOnly]) {
    const findings = buildInvestigationFindings(current);
    assert.equal(findings.some((item) => item.id === "pr-checked-empty" || item.id === "pr-absent"), false);
    assert.equal(JSON.stringify(findings).includes("未发现关联 Pull Request"), false);
    assert.equal(JSON.stringify(findings).includes("没有找到可用的关联 PR"), false);
  }
});

test("UI：PR 检索失败不写成未发现 PR，而由 Failure 区域说明", () => {
  const current = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_pull_request", success: false, evidenceIds: [] },
    ],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        checks: [],
        failureType: "tool_failure",
        failureTool: "github_get_pull_request",
        failureReason: "getPullRequest timed out",
        evidenceIds: ["ev-issue"],
        claimIds: [],
      },
    ],
  });
  const findings = buildInvestigationFindings(current);
  assert.equal(findings.some((item) => item.id === "pr-absent" || item.id === "pr-checked-empty"), false);
  assert.equal(JSON.stringify(findings).includes("未发现关联 Pull Request"), false);
  const timelineThenFailedPr = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_get_issue_timeline", success: true, evidenceIds: [] },
      { step: 3, tool: "github_get_pull_request", success: false, evidenceIds: [] },
    ],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        checks: [],
        failureType: "tool_failure",
        failureTool: "github_get_pull_request",
        failureReason: "getPullRequest timed out",
        evidenceIds: ["ev-issue"],
        claimIds: [],
      },
    ],
  });
  assert.equal(
    buildInvestigationFindings(timelineThenFailedPr).some(
      (item) => item.id === "pr-checked-empty" || item.id === "pr-absent",
    ),
    false,
  );
  const incident = investigationIncident(current);
  assert.equal(incident?.kind, "process");
  assert.equal(incident?.summary, "关联 Pull Request 的检索未成功。");
});

test("UI：查过 Commit 且结果为空才展示未找到修复 Commit", () => {
  const checkedEmpty = session({
    issue: { owner: "acme", repository: "box", number: 42, state: "closed" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "github_get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_list_commits", success: true, evidenceIds: [] },
    ],
  });
  const findings = buildInvestigationFindings(checkedEmpty);
  assert.equal(
    findings.find((item) => item.id === "commit-checked-empty")?.text,
    "已检查 Commit，目前没有找到能够确认修复的 Commit。",
  );
  assert.equal(findings.find((item) => item.id === "commit-checked-empty")?.source, "investigation_step");
  assert.equal(findings.some((item) => item.id === "commit-absent"), false);

  const neverChecked = session({
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" }],
    steps: [{ step: 1, tool: "get_issue", success: true, evidenceIds: ["ev-issue"] }],
  });
  assert.equal(
    buildInvestigationFindings(neverChecked).some(
      (item) => item.id === "commit-checked-empty" || item.id === "commit-absent",
    ),
    false,
  );

  const failedCommit = session({
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #42 is closed", trust: "external_untrusted" }],
    steps: [
      { step: 1, tool: "get_issue", success: true, evidenceIds: ["ev-issue"] },
      { step: 2, tool: "github_list_commits", success: false, evidenceIds: [] },
    ],
    attempts: [
      {
        id: "attempt-1",
        attempt: 1,
        checks: [],
        failureType: "tool_failure",
        failureTool: "github_list_commits",
        failureReason: "listCommits timed out",
        evidenceIds: ["ev-issue"],
        claimIds: [],
      },
    ],
  });
  assert.equal(
    buildInvestigationFindings(failedCommit).some(
      (item) => item.id === "commit-checked-empty" || item.id === "commit-absent",
    ),
    false,
  );
  assert.equal(investigationIncident(failedCommit)?.summary, "Commit 的检索未成功。");
});

test("UI：缺失 Agent 结论时不伪造第一人称调查结论", () => {
  const current = session({
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    evidence: [{ id: "ev-issue", kind: "issue", summary: "Issue #37395 is open", trust: "external_untrusted" }],
    agentOutput: undefined,
    rawAgentOutput: undefined,
    report: {
      conclusion: "Insufficient evidence to explain how issue #37395 was resolved.",
      polarity: "unknown",
      uncertainty: "",
      openQuestions: [],
    },
  });
  const conclusion = presentAgentConclusion(current);
  assert.equal(conclusion, "本次调查没有产生 Agent 最终回答。");
  assert.doesNotMatch(conclusion, /我检查了|我发现|我的判断是/);
  const view = buildInvestigationResultView(current);
  assert.equal(view.agent.conclusionSource, "presentation_fallback");
  assert.equal(view.agent.originalConclusion, "Insufficient evidence to explain how issue #37395 was resolved.");
  assert.equal(presentAgentJudgment(current), "调查发现：目前无法确认该 Issue 已经解决。");
});

test("UI：真实英文 Agent 结论原样展示，不翻译也不伪装成前端生成的 Agent 原话", () => {
  const current = session({
    agentOutput: "The related PR is merged, but runtime proof is still missing.",
    issue: { owner: "facebook", repository: "react", number: 37395, state: "open" },
    report: {
      conclusion: "The related PR is merged, but runtime proof is still missing.",
      polarity: "partial",
      uncertainty: "",
      openQuestions: [],
    },
  });
  const conclusion = presentAgentConclusion(current);
  assert.equal(conclusion, "The related PR is merged, but runtime proof is still missing.");
  assert.doesNotMatch(conclusion, /我检查了|我发现|我的判断是/);
  const view = buildInvestigationResultView(current);
  assert.equal(view.agent.conclusionSource, "agent_report");
  assert.equal(view.agent.judgment, "调查发现：目前证据指向该 Issue 仅部分解决。");
});

test("UI：真实中文 Agent 结论原样展示，不覆盖也不改写成 Harness 判断", () => {
  const current = session({
    agentOutput: "根据已收集的证据，我认为相关修复可能已经合并。",
    report: {
      conclusion: "根据已收集的证据，我认为相关修复可能已经合并。",
      polarity: "resolved",
      uncertainty: "",
      openQuestions: [],
    },
    verification: {
      status: "insufficient_evidence",
      evidenceCoverage: 0.33,
      prematureCompletion: false,
      missingRequirementIds: ["req-pr"],
      unsupportedClaimIds: [],
      checks: [{ id: "pr-merged", name: "resolution landed", status: "fail", message: "missing" }],
    },
  });
  assert.equal(presentAgentConclusion(current), "根据已收集的证据，我认为相关修复可能已经合并。");
  const view = buildInvestigationResultView(current);
  assert.equal(view.agent.conclusionSource, "agent_report");
  assert.equal(view.agent.judgment, "调查发现：目前证据指向该 Issue 已经解决。");
  assert.equal(view.statusLabel, "证据不足");
  assert.equal(view.agent.disagreesWithHarness, true);
});
