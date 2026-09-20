/**
 * Phase 14.3 Failure Localization tests.
 *
 * The classifier consumes VerificationResult only and produces FailureEvent[]
 * diagnosis. Tests assert categories, reference fields, severity, fallback,
 * trace emission (references only), and the no-action-bearing-fields boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationCheck, VerificationResult } from "../src/domain/types.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import { investigate } from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import {
  FAILURE_LOCALIZED_TRACE_TYPE,
  classifyVerificationFailures,
  localizeVerificationFailures,
  type FailureCategory,
  type FailureEvent,
} from "../src/failure/index.js";

const ALL_CATEGORIES: FailureCategory[] = [
  "missing_evidence",
  "unsupported_claim",
  "contradicted_claim",
  "resolution_gap",
  "verification_incomplete",
];

function check(
  overrides: Partial<VerificationCheck> & { id: string; status: VerificationCheck["status"] },
): VerificationCheck {
  return {
    name: overrides.id,
    type: "other",
    severity: "required",
    message: "check message",
    evidenceIds: [],
    ...overrides,
  };
}

function verificationResult(
  checks: VerificationCheck[],
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    status: "insufficient_evidence",
    checks,
    evidenceCoverage: 0,
    unsupportedClaimIds: [],
    missingRequirementIds: [],
    prematureCompletion: false,
    ...overrides,
  };
}

function onlyEvent(events: FailureEvent[]): FailureEvent {
  assert.equal(events.length, 1);
  return events[0] as FailureEvent;
}

test("missing_evidence：failed requirement resolution_code_evidence → missing_evidence", () => {
  const result = verificationResult([
    check({
      id: "evidence-requirements",
      status: "unknown",
      message: "Required evidence missing: resolution_code_evidence.",
      actual: ["resolution_code_evidence"],
    }),
  ]);
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "missing_evidence");
  assert.equal(event.requirementId, "resolution_code_evidence");
  assert.equal(event.source, "verification");
  assert.equal(event.investigationId, "run-1");
  assert.equal(event.severity, "blocking");
});

test("missing_evidence：code-commit chain check unknown without evidence", () => {
  const result = verificationResult([
    check({ id: "code-commit", status: "unknown", message: "Required commit/file/code evidence is missing.", evidenceIds: [] }),
  ]);
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "missing_evidence");
  assert.equal(event.resolutionStage, "resolution_code_evidence");
});

test("unsupported_claim：claims-supported unknown → unsupported_claim with claimIds", () => {
  const result = verificationResult(
    [check({ id: "claims-supported", status: "unknown", message: "Claim support is not established." })],
    { unsupportedClaimIds: ["claim-1"] },
  );
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "unsupported_claim");
  assert.deepEqual(event.claimIds, ["claim-1"]);
});

test("contradicted_claim：claims-supported fail → contradicted_claim", () => {
  const result = verificationResult([
    check({
      id: "claims-supported",
      status: "fail",
      message: "Completion-relevant critical claim is contradicted.",
      actual: ["claim-9"],
    }),
  ]);
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "contradicted_claim");
  assert.deepEqual(event.claimIds, ["claim-9"]);
});

test("resolution_gap：pr-merged fail (candidate exists but not landed)", () => {
  const result = verificationResult([
    check({
      id: "pr-merged",
      status: "fail",
      message: "Candidate PR exists but merged=false.",
      evidenceIds: ["ev-pr-1"],
    }),
  ]);
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "resolution_gap");
  assert.equal(event.resolutionStage, "resolution_merged");
});

test("resolution_gap：resolution-effect unknown with observed candidate evidence", () => {
  const result = verificationResult([
    check({
      id: "resolution-effect",
      status: "unknown",
      message: "Resolution does not align with the issue description.",
      evidenceIds: ["ev-pr-1", "ev-commit-1"],
    }),
  ]);
  const event = onlyEvent(classifyVerificationFailures(result, "run-1"));
  assert.equal(event.category, "resolution_gap");
  assert.equal(event.resolutionStage, "resolution_effect");
});

test("fallback：verification failed without a classifiable check → verification_incomplete", () => {
  const empty = onlyEvent(
    classifyVerificationFailures(verificationResult([], { status: "not_verified" }), "run-1"),
  );
  assert.equal(empty.category, "verification_incomplete");
  assert.equal(empty.severity, "blocking");

  const unrecognized = onlyEvent(
    classifyVerificationFailures(
      verificationResult([check({ id: "some-legacy-check", status: "fail" })], { status: "not_verified" }),
      "run-1",
    ),
  );
  assert.equal(unrecognized.category, "verification_incomplete");
});

test("trace：每个 FailureEvent 发出 failure_localized 引用事件", () => {
  const trace = new TraceCollector();
  const result = verificationResult([
    check({ id: "code-commit", status: "unknown", evidenceIds: [] }),
    check({ id: "claims-supported", status: "fail", actual: ["claim-9"] }),
  ]);
  const events = localizeVerificationFailures(result, { investigationId: "run-9", step: 2, trace });
  assert.equal(events.length, 2);

  const localized = trace.getEvents().filter((event) => event.type === FAILURE_LOCALIZED_TRACE_TYPE);
  assert.equal(localized.length, 2);
  assert.deepEqual(
    localized.map((event) => event.data.failureId),
    events.map((event) => event.id),
  );
  for (const event of localized) {
    assert.equal(event.runId, "run-9");
    assert.equal(event.step, 2);
    // References only: the FailureEvent payload must not be stored in trace.
    assert.deepEqual(Object.keys(event.data), ["failureId"]);
  }
});

test("verified_complete：不产生 FailureEvent，也不发出 trace", () => {
  const trace = new TraceCollector();
  const result = verificationResult(
    [check({ id: "code-commit", status: "pass" }), check({ id: "claims-supported", status: "pass" })],
    { status: "verified_complete" },
  );
  const events = localizeVerificationFailures(result, { investigationId: "run-ok", trace });
  assert.deepEqual(events, []);
  assert.deepEqual(trace.getEvents(), []);
});

test("boundary：FailureEvent 只携带诊断字段，不携带 recovery 语义", () => {
  const result = verificationResult([
    check({ id: "code-commit", status: "unknown", evidenceIds: [] }),
    check({ id: "claims-supported", status: "unknown", severity: "optional", message: "optional claim check" }),
  ]);
  const events = classifyVerificationFailures(result, "run-b");
  const allowedKeys = new Set([
    "id",
    "investigationId",
    "category",
    "source",
    "requirementId",
    "claimIds",
    "resolutionStage",
    "severity",
    "explanation",
  ]);
  for (const event of events) {
    for (const key of Object.keys(event)) {
      assert.equal(allowedKeys.has(key), true, `unexpected field ${key}`);
    }
    assert.equal(ALL_CATEGORIES.includes(event.category), true);
    assert.equal(event.source, "verification");
  }
  const warning = events.find((event) => event.severity === "warning");
  assert.ok(warning, "optional-severity check should localize as warning");
});

test("regression：真实 verifier 的 insufficient_evidence 结果可被分类且不被修改", async () => {
  const investigation = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    useTestDriver: true,
  });
  const verification = investigation.verification as VerificationResult;
  assert.equal(verification.status, "insufficient_evidence");
  const snapshot = JSON.stringify(verification);

  const events = classifyVerificationFailures(verification, investigation.run.id);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(ALL_CATEGORIES.includes(event.category), true);
    assert.equal(event.source, "verification");
    assert.equal(event.investigationId, investigation.run.id);
  }
  // Localization is read-only diagnosis: the verdict object is untouched.
  assert.equal(JSON.stringify(verification), snapshot);
});
