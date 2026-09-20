/**
 * Phase 14.4 Failure Reporting tests.
 *
 * The builder consumes FailureEvent[] and produces the FailureReport
 * aggregation artifact. Tests assert single/multi-event conversion, the
 * empty-events case (no report), the no-action-leakage boundary, and the
 * InvestigationAgentReport integration (reference by id, never embedded).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationCheck, VerificationResult } from "../src/domain/types.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import { investigate } from "../src/investigation/index.js";
import type { InvestigationAgentReport } from "../src/investigation/investigation-report.js";
import {
  FailureReportBuilder,
  classifyVerificationFailures,
  createFailureEvent,
  type FailureEvent,
  type FailureReport,
} from "../src/failure/index.js";

const FORBIDDEN_KEY_WORDS = ["action", "tool", "retry", "recovery", "plan"];

function walkKeys(value: unknown, keys: string[] = []): string[] {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walkKeys(child, keys);
    }
  }
  return keys;
}

function buildOnly(events: FailureEvent[]): FailureReport {
  const report = new FailureReportBuilder().build(events, {
    id: "report-1",
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  assert.ok(report, "expected a FailureReport for non-empty events");
  return report;
}

test("单事件转换：missing_evidence → 一份含单个 summary 的 FailureReport", () => {
  const event = createFailureEvent({
    investigationId: "run-1",
    category: "missing_evidence",
    severity: "blocking",
    requirementId: "resolution_code_evidence",
    explanation: "Required evidence for resolution_code_evidence is missing.",
  });
  const report = buildOnly([event]);
  assert.equal(report.id, "report-1");
  assert.equal(report.investigationId, "run-1");
  assert.equal(report.status, "failed");
  assert.equal(report.createdAt, "2026-09-20T00:00:00.000Z");
  assert.equal(report.failures.length, 1);
  const summary = report.failures[0] as FailureReport["failures"][number];
  assert.equal(summary.category, event.category);
  assert.equal(summary.severity, event.severity);
  assert.equal(summary.description, event.explanation);
  assert.deepEqual(summary.relatedRequirementIds, ["resolution_code_evidence"]);
  assert.equal(summary.relatedClaimIds, undefined);
});

test("多失败聚合：unsupported_claim + missing_evidence → 两个 summary", () => {
  const events: FailureEvent[] = [
    createFailureEvent({
      investigationId: "run-2",
      category: "unsupported_claim",
      severity: "blocking",
      claimIds: ["claim-1", "claim-2"],
      explanation: "Claim support is not established.",
    }),
    createFailureEvent({
      investigationId: "run-2",
      category: "missing_evidence",
      severity: "blocking",
      requirementId: "resolution_code_evidence",
      explanation: "Required evidence is missing.",
    }),
  ];
  const report = buildOnly(events);
  assert.equal(report.failures.length, 2);
  assert.deepEqual(
    report.failures.map((failure) => failure.category),
    ["unsupported_claim", "missing_evidence"],
  );
  assert.deepEqual(report.failures[0]?.relatedClaimIds, ["claim-1", "claim-2"]);
  assert.deepEqual(report.failures[1]?.relatedRequirementIds, ["resolution_code_evidence"]);
});

test("同类别聚合：多个 missing_evidence 事件合并为一个 summary 并去重引用", () => {
  const events: FailureEvent[] = [
    createFailureEvent({
      investigationId: "run-3",
      category: "missing_evidence",
      severity: "warning",
      requirementId: "req-a",
      explanation: "Evidence A missing.",
    }),
    createFailureEvent({
      investigationId: "run-3",
      category: "missing_evidence",
      severity: "blocking",
      requirementId: "req-a",
      explanation: "Evidence A still missing.",
    }),
    createFailureEvent({
      investigationId: "run-3",
      category: "missing_evidence",
      severity: "blocking",
      requirementId: "req-b",
      explanation: "Evidence B missing.",
    }),
  ];
  const report = buildOnly(events);
  assert.equal(report.failures.length, 1);
  const summary = report.failures[0] as FailureReport["failures"][number];
  assert.equal(summary.severity, "blocking");
  assert.deepEqual(summary.relatedRequirementIds, ["req-a", "req-b"]);
  assert.equal(report.status, "failed");
});

test("无失败：空 FailureEvent[] 不生成 FailureReport", () => {
  assert.equal(new FailureReportBuilder().build([]), undefined);
});

test("状态：仅 warning 级失败聚合为 incomplete，含 blocking 则为 failed", () => {
  const warningOnly = buildOnly([
    createFailureEvent({
      investigationId: "run-w",
      category: "unsupported_claim",
      severity: "warning",
      explanation: "Optional claim support is not established.",
    }),
  ]);
  assert.equal(warningOnly.status, "incomplete");
});

test("边界：FailureReport 不含任何 action / tool / retry / recovery 字段", () => {
  const report = buildOnly([
    createFailureEvent({
      investigationId: "run-4",
      category: "resolution_gap",
      severity: "blocking",
      resolutionStage: "resolution_merged",
      claimIds: ["claim-1"],
      explanation: "The resolution chain is broken at resolution_merged.",
    }),
  ]);
  const allowedReportKeys = new Set(["id", "investigationId", "status", "failures", "createdAt"]);
  const allowedSummaryKeys = new Set([
    "category",
    "severity",
    "description",
    "relatedClaimIds",
    "relatedRequirementIds",
  ]);
  assert.deepEqual(
    Object.keys(report).filter((key) => !allowedReportKeys.has(key)),
    [],
  );
  for (const summary of report.failures) {
    assert.deepEqual(
      Object.keys(summary).filter((key) => !allowedSummaryKeys.has(key)),
      [],
    );
  }
  for (const key of walkKeys(report)) {
    for (const word of FORBIDDEN_KEY_WORDS) {
      assert.equal(
        key.toLowerCase().includes(word),
        false,
        `forbidden action-bearing key ${key}`,
      );
    }
  }
});

test("集成：InvestigationAgentReport 只以 failureReportId 引用，不内嵌 FailureReport", async () => {
  const investigation = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    useTestDriver: true,
  });
  const verification = investigation.verification as VerificationResult;
  const events = classifyVerificationFailures(verification, investigation.run.id);
  assert.ok(events.length > 0);
  const report = buildOnly(events);

  const agentReport: InvestigationAgentReport = investigation;
  assert.equal(agentReport.failureReportId, undefined);
  agentReport.failureReportId = report.id;
  assert.equal(agentReport.failureReportId, "report-1");

  const serialized = JSON.stringify(agentReport);
  assert.equal(serialized.includes(`"failureReportId":"${report.id}"`), true);
  // The artifact stays independent: only the id crosses the boundary.
  assert.equal(serialized.includes('"failureReport"'), false);
  assert.equal(serialized.includes('"failures"'), false);
});
