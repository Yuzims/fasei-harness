# Phase 12.0 — Recovery Policy Layer

## Evaluation Scope

This run adds a **Recovery Policy Decision Layer** between Recovery Intent / Action Candidates and Recovery Execution.

```text
Failure
  → Resolution Gap
  → Recovery Intent
  → Recovery Action Candidate
  → Recovery Policy     ← this phase
  → Selected Action
  → Recovery Executor
```

It answers:

> Given gaps, intents, candidates, budget, and action profiles, which actions should be selected, which should be rejected, and why?

Phase 12.0 is **not learning**. It is a constrained decision layer. It does not call an LLM, train a model, or run reinforcement learning.

It does **not** execute recovery. It does not call tools. It does not create Evidence. It does not modify IndependentCompletionVerifier. ControlledRecoveryLoop and RecoveryExecutor behavior are unchanged.

`IndependentCompletionVerifier` remains the only completion authority.

Evaluated:

- Unit / synthetic contracts in `tests/recovery-policy.test.ts`
- Focus cases `C07`, `C08`, and `C10` via `evaluatePhase12FocusCases()` in `tests/recovery-policy-evaluation.test.ts`

Focus-case inputs are the same gap types observed on Real-v1 (`missing_patch_evidence`, `insufficient_resolution_context`, `missing_candidate`). Evaluation runs the decision layer only. It does not invoke RecoveryExecutor, GitHub HTTP, or a live model.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, completion semantics, Ground Truth, Real-v1 snapshots, retrieval ranking, candidate selection, Resolution Analyzer, Resolution Gap Analyzer detection rules, ControlledRecoveryLoop, RecoveryExecutor, RecoveryIntent generation, RecoveryAttempt, RecoveryBudget, Evidence Graph schema, and FailureAnalyzer were not modified.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `12.0` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 607 passed, 0 failed |
| Build command | `npm run build` — pass |
| GitHub API | not called |
| OpenAI / DashScope / Qwen | not called |

## 1. Problem definition

Phase 11.1 can turn a Recovery Action Candidate into execution. What it does not have is a separate, inspectable choice:

- which candidate should run
- which candidate should be dropped
- whether estimated cost fits remaining budget
- whether the action can cover the observed gap

Without that layer, selection is implicit in adapter order and runtime slicing. Policy makes the choice explicit and deterministic.

Policy cannot claim that Investigation completed. It cannot raise completion rate. It cannot learn a better strategy from outcomes.

## 2. Architecture change

Before this phase:

```text
RecoveryIntent
  → RecoveryActionCandidate
  → RecoveryExecutor
```

After this phase:

```text
RecoveryIntent
  → RecoveryActionCandidate
  → Recovery Policy
  → RecoveryDecision (selected / rejected / reason)
  → RecoveryExecutor   (unchanged; not invoked by this layer)
```

New files:

- `src/investigation/recovery/policy/recovery-policy-types.ts`
- `src/investigation/recovery/policy/recovery-policy.ts`
- `src/investigation/recovery/policy/recovery-policy-trace.ts`
- `src/investigation/recovery/policy/index.ts`
- `src/evaluation/recovery-policy-evaluation.ts`
- `tests/recovery-policy.test.ts`
- `tests/recovery-policy-evaluation.test.ts`

Runtime modules frozen in this phase:

- `ControlledRecoveryLoop`
- `RecoveryExecutor`
- `RecoveryAttempt`
- `RecoveryBudget`
- RecoveryIntent generation
- `ResolutionGapAnalyzer`
- `ResolutionAnalyzer`
- `IndependentCompletionVerifier`
- Evidence Graph
- Retrieval / Ranking / Selection
- Ground Truth
- Snapshot schema

Policy only reads `RecoveryPolicyInput`. It does not write InvestigationRun, Evidence, claims, or verifier status.

`estimatedCost` is a policy input on `RecoveryActionProfile`. It is not the runtime actual cost recorded by RecoveryExecutor.

## 3. Policy rules

The decision is deterministic. No LLM. No ML. No RL.

| Rule | Behavior |
|---|---|
| 1 Blocking gap priority | An action that covers a blocking gap ranks above an action that only covers a warning gap. |
| 2 Gap coverage | An action that resolves more of the uncovered gaps ranks higher. |
| 3 Cost constraint | If `estimatedCost > remaining budget`, reject. Remaining budget is `min(maxAdditionalActions, maxAdditionalToolCalls)` while `maxRecoveryRounds > 0`. |
| 4 Same coverage, lower cost | Equal coverage: choose the lower `estimatedCost`. |
| 5 Stable ordering | Remaining ties keep original candidate order. No randomness. |

After a pick, covered gap types are removed from the uncovered set. A later action that no longer covers an uncovered gap is rejected as `redundant`. Actions with no profile are `no_profile`. Actions that resolve none of the input gaps are `no_gap_coverage`.

Output:

```text
RecoveryDecision {
  selectedActions
  rejectedActions
  reason
}
```

## 4. Decision examples

### C07 — `missing_patch_evidence`

Candidates from the existing adapter: `fetch_commit_patch`, `inspect_changed_files`.

Default profiles both can cover `missing_patch_evidence` at cost 1. Coverage is equal, cost is equal, so stable order selects `fetch_commit_patch`. `inspect_changed_files` is redundant after the gap is covered.

That is a reasonable patch-evidence action. It is not a claim that the issue is solved.

### C08 — `insufficient_resolution_context`

Adapter candidates collect resolution context. Evaluation also injects `create_pull_request`.

Policy does not select a PR-creating action. `create_pull_request` has no gap coverage for this input, so it is rejected as invalid.

### C10 — `missing_candidate`

The covering action is `search_resolution_candidates`. Distractors `fetch_commit_patch` and `create_pull_request` cannot resolve `missing_candidate` and are rejected.

Policy only selects candidate discovery.

## 5. Evaluation

Evaluation measures the decision, not completion.

| Metric | Meaning |
|---|---|
| Budget compliance | Sum of selected `estimatedCost` ≤ remaining policy budget |
| Gap coverage | Selected actions cover every required gap that some affordable valid candidate could cover |
| Determinism | Same input → same `selectedActions`, `rejectedActions`, and `reason` |
| Invalid action rejection | No selected action has empty coverage of the input gaps |

Not measured:

- completion rate
- winner
- best strategy
- RecoveryExecutor success/failure

Trace event: `recovery_policy_decision`

Payload:

```text
gapTypes, candidateActions, selectedActions, rejectedActions, reason
```

Decision only. No execution result, no added Evidence IDs, no verifier verdict.

## 6. Limitations

- Policy is not wired into `ControlledRecoveryLoop`. Runtime execution still uses the Phase 11.1 selection path.
- `estimatedCost` is declared on profiles. It is not measured tool-call cost.
- Remaining budget is derived from RecoveryBudget caps without runtime usage, because this layer does not execute.
- Default profiles are a first-version capability map, not a learned ranking.
- Focus cases use the observed Real-v1 gap types as Policy inputs. They do not re-run Recovery Execution.

Phase 12.0 is not learning. It is a constrained decision layer.
