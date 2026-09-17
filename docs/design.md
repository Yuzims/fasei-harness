# Design notes

The full implementation specification lives at [`../design.md`](../design.md). This file records architecture that has been implemented.

## Phase 4 — Independent Completion Verifier — DONE

Agent conclusion is not truth. The Harness independently verifies completion.

```text
Investigation Agent
        |
        | observations / evidence / claims
        v
    Harness State
        |
        v
Independent Completion Verifier
        |
        +--> deterministic checks
        |
        +--> evidence requirements
        |
        +--> claim/evidence consistency
        |
        v
VerificationResult
```

`VerificationResult` is produced by `IndependentCompletionVerifier` after the Investigation Agent finishes. The agent cannot set `verified_complete`. Final-answer prose is ignored.

See [`implementation-status.md`](implementation-status.md) for check list, statuses, and fixture results.

## Phase 5 — Failure Analyzer + Failure-Specific Recovery Planner — DONE

Failure is not a blind retry. The Harness classifies the failure, then chooses a bounded recovery.

```text
Failure Event
     ↓
FailureAnalyzer
     ↓
Failure Classification
     ↓
RecoveryPlanner
     ↓
Failure-specific Recovery Plan
     ↓
Harness executes plan (new append-only attempt)
     ↓
Investigation Agent continues
     ↓
IndependentCompletionVerifier (again)
```

Failure is classified before recovery. Recovery strategy depends on failure type. Recovery is bounded (`maxInvestigationAttempts`, `maxRecoveryAttempts`, `maxToolRetries`). Recovery creates a new append-only attempt; previous failures and plans stay on the old attempt. Completion is re-verified after recovery. Only the independent verifier can produce `verified_complete`.

## Phase 6 — Evidence Graph & Verification Formalization — DONE

Evidence relationships are explicit domain data. The Independent Completion Verifier reads the Evidence Graph; it does not reconstruct Issue→PR→Commit links by inspecting arbitrary payload fields.

```text
GitHub Observation
        ↓
Evidence
        ↓
Evidence Relation
        ↓
Claim
        ↓
Claim Evidence
        ↓
Evidence Requirement
        ↓
Independent Verification
```

```text
Investigation Agent
        |
        | Evidence + EvidenceRelation + Claim + ClaimEvidence
        v
    Harness State
        |
        v
Independent Completion Verifier
        |
        +--> issue identity / issue closed
        |
        +--> resolution candidate (graph edge)
        |
        +--> PR merged / code evidence (graph edge)
        |
        +--> claim support / evidence requirements
        |
        v
VerificationResult
```

`createEvidenceRelation` validates source/target evidence IDs, relation type, and rejects self-edges. Duplicate `(from, to, type)` is reused. `ClaimEvidence` is the only claim→evidence support; Agent prose is not evidence.

A merged PR alone is not a complete resolution chain. Commit/file evidence must be linked with `derived_from` (or `parents` / `merges`). Contradictory evidence cannot yield `verified_complete`. Optional requirements do not block completion.

This verifies the GitHub Issue investigation evidence chain. It does not prove arbitrary software defects are fixed.

See [`implementation-status.md`](implementation-status.md).
