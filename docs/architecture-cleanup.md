# Architecture Cleanup — Unify Failure / Recovery

Phase 5 cleanup. No Phase 6 work (no RAG, Multi-Agent, Memory, MCP, or UI).

Product path:

```text
Investigation Domain
        ↓
FailureEvent
        ↓
FailureAnalyzer
        ↓
RecoveryPlan
        ↓
RecoveryPlanner
        ↓
applyRecovery
        ↓
new Attempt
```

```text
Legacy Failure Injection
≠
Investigation Recovery
```

---

## Current Failure Systems

### System A: Workspace Failure Injection

**Location (before):** `src/failure/*`, `src/recovery/*`

**Location (after):** `src/legacy/failure/*`, `src/legacy/recovery/*`

**用途:**

Synthetic workspace harness. Classifies file/count/citation/tool-result failures and picks a workspace recovery (`retry_tool` / `continue_execution` / `change_retrieval_strategy` / `stop`). Powers the original demo Agent Loop, UI `/api/agent/run`, and the 4-case failure-injection benchmark.

**引用:**

| Consumer | Role |
|---|---|
| `src/core/harness.ts` | Workspace `Harness` analyze → plan → apply |
| `src/server/agent-service.ts` | Workbench agent sessions |
| `src/eval/benchmark.ts` | Failure-aware vs generic retry |
| `src/eval/generic-retry-planner.ts` | Blind-retry baseline planner |
| `src/agent/model.ts` | `lastFailure` / `lastRecovery` on `ModelContext` |
| `examples/mainline.ts`, `basic-run.ts`, `live.ts`, `premature-completion.ts` | CLI demos |
| `tests/analyzer.test.ts`, `tests/recovery.test.ts`, `tests/harness-recovery.test.ts`, `tests/benchmark.test.ts` | Synthetic tests |

**Not referenced by:** Investigation Agent, Independent Completion Verifier, GitHub investigation tools.

**Types (legacy, not domain):**

- `FailureType`: `tool_failure` \| `retrieval_failure` \| `premature_completion` \| `loop_failure` \| `unknown`
- `Failure`: `{ type, rootCause, evidence }`
- `RecoveryAction`: `retry_tool` \| `continue_execution` \| `change_retrieval_strategy` \| `stop`
- `RecoveryPlan`: `{ action, reason, resetWorkspace? }`

**Trace (legacy, workspace only):** `failure`, `recovery`

### System B: Investigation Recovery (product)

**Location:** `src/investigation/failure-analyzer.ts`, `src/investigation/recovery-planner.ts`, `src/investigation/apply-recovery.ts`

**Domain:** `src/domain/types.ts` — `FailureType`, `RecoveryAction`, `FailureEvent`, `RecoveryPlan`

**用途:**

GitHub issue investigation. Classify from structured tool metadata / investigation state / independent verifier, then recover by type. Bounded. Append-only new Attempt. Never writes `verified_complete`.

**引用:**

| Consumer | Role |
|---|---|
| `src/investigation/investigation-agent.ts` | Product loop |
| `src/domain/recovery-policy.ts` | Canonical type → action map |
| `tests/investigation-recovery.test.ts` | Product tests |
| `tests/domain.test.ts` | Domain policy tests |

**Types (canonical domain — one set):**

- `FailureType`
- `RecoveryAction`
- `FailureEvent`
- `RecoveryPlan`

Former names `InvestigationFailureType` and `InvestigationRecoveryAction` were removed so interviews do not have to explain two FailureType families.

**Trace (product, investigation only):**

`failure_detected` → `failure_analyzed` → `recovery_planned` → `recovery_started` → `recovery_completed`

---

## Decision

| System | Decision | Why |
|---|---|---|
| System A | **Migrate** to `src/legacy/` | Still required by workspace benchmark, workbench API, and synthetic tests. Not unused. Deleting would drop the 75% vs 25% injection comparison. |
| System B | **Keep** as product path | This is the Investigation Harness mainline. Public `FailureAnalyzer` / `RecoveryPlanner` names now point here. |
| Domain aliases | **Delete** `InvestigationFailureType` / `InvestigationRecoveryAction` | One domain vocabulary: `FailureType`, `RecoveryAction`, `FailureEvent`, `RecoveryPlan`. |
| Public export aliases | **Delete** `InvestigationFailureAnalyzer` / `InvestigationRecoveryPlanner` | Those aliases made System B look secondary. |

Deleted paths: `src/failure/*`, `src/recovery/*` (contents moved, not discarded).

---

## Completion Verifiers

| Class | Path | Role |
|---|---|---|
| `IndependentCompletionVerifier` | `src/verification/independent-completion-verifier.ts` | **Product.** GitHub investigation. Produces domain `VerificationResult` (`verified_complete` / `not_verified` / `insufficient_evidence`). Agent conclusion is not truth. |
| `WorkspaceCompletionVerifier` | `src/verification/completion-verifier.ts` | **Legacy workspace.** File / count / citation / tool-result checks for synthetic demos. Produces workspace `VerificationResult` (`pass` / `fail`). Formerly named `CompletionVerifier`. |

Do not use `WorkspaceCompletionVerifier` on Investigation runs. Do not use `IndependentCompletionVerifier` on workspace file-write demos.

Workspace `src/verification/types.ts` (`pass`/`fail`) is not the investigation domain `VerificationResult`. Same English words, different types, different modules.

---

## Domain Types — one set

Canonical (`src/domain/types.ts`):

```text
FailureType
RecoveryAction
FailureEvent
RecoveryPlan
```

Not present:

```text
InvestigationFailureType
InvestigationRecoveryType
RecoveryFailureType
```

Legacy workspace types stay inside `src/legacy/` and are exported from the package root only as `WorkspaceFailure`, `WorkspaceFailureType`, `WorkspaceRecoveryPlan`, `WorkspaceRecoveryAction`, `WorkspaceFailureAnalyzer`, `WorkspaceRecoveryPlanner`.

---

## Trace

Investigation runs emit only:

```text
failure_detected
failure_analyzed
recovery_planned
recovery_started
recovery_completed
```

Workspace harness runs emit only:

```text
failure
recovery
```

The two sets are never mixed on one run. `TraceEventType` keeps both members because both runtimes still exist; each runtime uses one set.

---

## What was deleted / kept / why

**Deleted (moved off the product tree):**

- `src/failure/`
- `src/recovery/`
- Domain names `InvestigationFailureType`, `InvestigationRecoveryAction`
- Public aliases `InvestigationFailureAnalyzer`, `InvestigationRecoveryPlanner`
- Class name `CompletionVerifier` (renamed to `WorkspaceCompletionVerifier`)

**Kept (product):**

- `src/domain/` Failure / Recovery types
- `src/investigation/failure-analyzer.ts`
- `src/investigation/recovery-planner.ts`
- `src/investigation/apply-recovery.ts`
- `IndependentCompletionVerifier`
- Investigation trace events listed above

**Kept (legacy, still serving benchmark / workbench):**

- `src/legacy/failure/`
- `src/legacy/recovery/`
- `src/core/harness.ts` (workspace harness)
- `WorkspaceCompletionVerifier`
- Workspace trace events `failure` / `recovery`

**Why not delete System A:** it is still referenced by `Harness`, `agent-service`, `eval/benchmark`, and the synthetic tests. Benchmark has not been migrated to Investigation Recovery.
