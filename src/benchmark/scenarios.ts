import { createTarget } from "../domain/index.js";
import type { BenchmarkScenario } from "./types.js";

/**
 * Phase 7.0 regression set: existing recorded GitHub snapshots.
 * Not a representative real-world GitHub benchmark.
 */
export const FASEI_REGRESSION_SCENARIOS: BenchmarkScenario[] = [
  {
    id: "resolved",
    description: "Closed issue with a merged resolution PR and linked code evidence.",
    kind: "normal",
    fixture: "resolved",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 42 }),
    expectedOutcome: { verificationStatus: "verified_complete" },
  },
  {
    id: "closed-unmerged",
    description: "Closed issue linked to a PR that is not merged. Closed is not resolved.",
    kind: "normal",
    fixture: "closed-unmerged",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 99 }),
    expectedOutcome: { verificationStatus: "not_verified" },
  },
  {
    id: "insufficient-evidence",
    description: "Closed issue with no linked PR, commit, or other resolution evidence.",
    kind: "failure",
    failureMode: "insufficient_evidence",
    fixture: "insufficient-evidence",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 7 }),
    expectedOutcome: {
      verificationStatus: "insufficient_evidence",
      failureModes: ["insufficient_evidence"],
    },
  },
];

/**
 * Deterministic failure scenarios. Environment/fixture injection only.
 * Observed failure types come from production FailureAnalyzer.
 */
export const FASEI_FAILURE_SCENARIOS: BenchmarkScenario[] = [
  {
    id: "wrong-target",
    description: "Task points at the wrong issue; snapshot evidence belongs to a different issue.",
    kind: "failure",
    failureMode: "wrong_target",
    fixture: "resolved",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 99 }),
    expectedOutcome: {
      verificationStatus: "not_verified",
      failureModes: ["wrong_target"],
      recovery: { required: true },
    },
  },
  {
    id: "tool-failure",
    description: "First GitHub getIssue call times out; production recovery decides the rest.",
    kind: "failure",
    failureMode: "tool_failure",
    fixture: "resolved",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 42 }),
    expectedOutcome: {
      verificationStatus: "verified_complete",
      failureModes: ["tool_failure"],
      recovery: { required: true },
    },
  },
  {
    id: "premature-completion",
    description: "Agent records a resolved claim before sufficient evidence exists.",
    kind: "failure",
    failureMode: "premature_completion",
    fixture: "insufficient-evidence",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 7 }),
    expectedOutcome: {
      verificationStatus: "insufficient_evidence",
      failureModes: ["premature_completion"],
      recovery: { required: true },
    },
  },
  {
    id: "retrieval-failure",
    description: "First retrieval stops after the issue observation; remaining sources exist.",
    kind: "failure",
    failureMode: "retrieval_failure",
    fixture: "resolved",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 42 }),
    expectedOutcome: {
      verificationStatus: "verified_complete",
      failureModes: ["retrieval_failure"],
      recovery: { required: true },
    },
  },
];

export const FASEI_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  ...FASEI_REGRESSION_SCENARIOS,
  ...FASEI_FAILURE_SCENARIOS,
];
