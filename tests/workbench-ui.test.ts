import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationSessionDTO } from "../src/api/dto.ts";
import {
  buildTraceItems,
  filterEvidence,
  formatMetric,
  investigationErrorTitle,
  isNotFoundError,
  recoveredFrom,
  uniqueEvidenceKinds,
  verificationLabel,
  verificationTone,
} from "../web/src/lib/workbench.ts";

test("UI：verification status 使用明确文案，不把 insufficient 显示成 FAILED", () => {
  assert.equal(verificationLabel("verified_complete"), "VERIFIED COMPLETE");
  assert.equal(verificationLabel("not_verified"), "NOT VERIFIED");
  assert.equal(verificationLabel("insufficient_evidence"), "INSUFFICIENT EVIDENCE");
  assert.notEqual(verificationLabel("insufficient_evidence"), "FAILED");
  assert.notEqual(verificationLabel("not_verified"), "FAILED");
  assert.equal(verificationTone("verified_complete"), "verified");
  assert.equal(verificationTone("not_verified"), "not_verified");
  assert.equal(verificationTone("insufficient_evidence"), "insufficient");
  assert.notEqual(verificationTone("not_verified"), verificationTone("insufficient_evidence"));
});

test("UI：HTTP 404 显示 Investigation not found", () => {
  assert.equal(isNotFoundError({ status: 404, message: "missing snapshot" }), true);
  assert.equal(investigationErrorTitle({ status: 404, message: "missing snapshot" }), "Investigation not found");
  assert.equal(investigationErrorTitle({ status: 400, message: "bad request" }), "Investigation failed");
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
    dataSource: "snapshot",
    actor: "test_driver",
    status: "investigated",
    runStatus: "verified_complete",
    task: { owner: "acme", repository: "box", issueNumber: 42, description: "investigate" },
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
  assert.equal(trace[0]?.label, "Investigation started");
  assert.ok(trace.some((item) => item.label === "get_issue"));
  assert.ok(trace.some((item) => item.label === "Failure" && item.detail === "tool_failure"));
  assert.ok(trace.some((item) => item.label === "Recovery" && item.detail === "retry_with_backoff"));
  const second = current.attempts[1];
  assert.equal(recoveredFrom(second, current.attempts)?.attempt, 1);
});

test("UI：unknown issue 文案不编造 verified_complete", () => {
  assert.equal(investigationErrorTitle({ status: 404 }), "Investigation not found");
  assert.notEqual(verificationLabel(undefined), "VERIFIED COMPLETE");
});
