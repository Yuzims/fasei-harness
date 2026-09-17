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

This is a failure-aware recovery foundation, not a fully autonomous self-healing agent.
