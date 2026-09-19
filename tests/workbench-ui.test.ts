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

test("UI：verification status 使用中文，不把 insufficient 显示成 FAILED", () => {
  assert.equal(verificationLabel("verified_complete"), "已验证完成");
  assert.equal(verificationLabel("not_verified"), "未验证完成");
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

test("UI：unknown issue 文案不编造已验证完成", () => {
  assert.equal(investigationErrorTitle({ status: 404 }), "未找到这次调查");
  assert.notEqual(verificationLabel(undefined), "已验证完成");
});

test("UI：example labels 来自 repository / issue，不从 identifier 推导 verification", () => {
  assert.equal(repositoryDisplayName("vscode"), "VS Code");
  assert.equal(repositoryDisplayName("streamlit"), "Streamlit");
  assert.equal(repositoryDisplayName("playwright-mcp"), "Playwright MCP");
  assert.equal(exampleHeading({ repository: "vscode", issueNumber: 258694 }), "VS Code #258694");
  assert.equal(exampleHeading({ repository: "pytest", issueNumber: 14524 }), "Pytest #14524");
  assert.doesNotMatch(
    exampleHeading({ repository: "vscode", issueNumber: 258694 }),
    /已验证完成|未验证完成|证据不足|VERIFIED|NOT VERIFIED|INSUFFICIENT/i,
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
  assert.equal(verificationSubtitle("verified_complete"), "目前已有足够证据确认该 Issue 的解决链路。");
  assert.equal(verificationLabel("insufficient_evidence"), "证据不足");
  assert.equal(investigationMode({ mode: "live" }), "live");
  assert.equal(investigationMode({ dataSource: "snapshot" }), "snapshot");
  assert.equal(investigationModeDetail("live"), "数据来自 GitHub 公开接口。");
  assert.equal(investigationModeDetail("snapshot"), "使用已录制的 GitHub 数据，结果可复现。");
});

test("UI：C01 / C05 / C08 / C09 / C10 结果文案来自 verifier status", () => {
  const cases = [
    ["C01", "verified_complete", "已验证完成"],
    ["C05", "not_verified", "未验证完成"],
    ["C08", "verified_complete", "已验证完成"],
    ["C09", "verified_complete", "已验证完成"],
    ["C10", "insufficient_evidence", "证据不足"],
  ] as const;
  for (const [id, status, label] of cases) {
    assert.equal(verificationLabel(status), label, id);
    assert.notEqual(verificationLabel(status), status);
  }
});

test("UI：内部 requirement id 不作为默认展示", () => {
  assert.equal(requirementLabel("req-pr"), "已合并的 Pull Request");
  assert.equal(requirementLabel("req-commit"), "代码 / Commit 证据");
  assert.equal(checkLabel({ id: "issue-identity", name: "issue identity" }), "Issue 身份");
  assert.equal(checkLabel({ id: "pr-merged", name: "resolution landed" }), "PR 已合并");
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
