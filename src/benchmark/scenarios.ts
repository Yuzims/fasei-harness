import { createTarget } from "../domain/index.js";
import type { BenchmarkScenario } from "./types.js";

/**
 * Phase 7.0 regression set: existing recorded GitHub snapshots.
 * Not a representative real-world GitHub benchmark.
 */
export const FASEI_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: "resolved",
    description: "Closed issue with a merged resolution PR and linked code evidence.",
    fixture: "resolved",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 42 }),
    expectedOutcome: { verificationStatus: "verified_complete" },
  },
  {
    id: "closed-unmerged",
    description: "Closed issue linked to a PR that is not merged. Closed is not resolved.",
    fixture: "closed-unmerged",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 99 }),
    expectedOutcome: { verificationStatus: "not_verified" },
  },
  {
    id: "insufficient-evidence",
    description: "Closed issue with no linked PR, commit, or other resolution evidence.",
    fixture: "insufficient-evidence",
    target: createTarget({ owner: "acme", repository: "box", issueNumber: 7 }),
    expectedOutcome: {
      verificationStatus: "insufficient_evidence",
      failureTypes: ["insufficient_evidence"],
    },
  },
];
