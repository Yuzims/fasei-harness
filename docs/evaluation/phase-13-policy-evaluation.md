# Phase 13.0 — Recovery Policy Evaluation & Calibration

## Evaluation Scope

This run adds an independent **Evaluation Layer**. It compares:

```text
Naive first-action Recovery Policy
  vs
Phase 12 cost-aware Recovery Policy
```

It sits after Phase 12.0 Recovery Policy Layer. Runtime behavior is unchanged.

It answers:

> Under the same Recovery Budget, does a cost-aware Recovery Policy differ from a naive first-action policy in estimated action cost, unnecessary-action rate, and gap coverage?

**Evaluation measures decision efficiency, not completion improvement.**

It does **not** prove that Policy is smarter. It does **not** prove that Policy raises completion rate. It does **not** pick a winner.

Both policies emit `RecoveryDecision` only. Neither policy executes recovery. Neither policy calls tools, creates Evidence, or modifies IndependentCompletionVerifier.

`IndependentCompletionVerifier` remains the only completion authority.

Evaluated:

- Metric contracts in `tests/recovery-policy-comparison.test.ts`
- Focus cases `C07`, `C08`, and `C10` via `evaluatePhase13FocusCases()`

Focus-case inputs use the same Real-v1 gap types observed in earlier phases (`missing_patch_evidence`, `insufficient_resolution_context`, `missing_candidate`). Evaluation runs the decision layer only. It does not invoke RecoveryExecutor, GitHub HTTP, or a live model.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, completion semantics, Ground Truth, Real-v1 snapshots, retrieval ranking, candidate selection, Resolution Analyzer, Resolution Gap Analyzer detection rules, ControlledRecoveryLoop, RecoveryExecutor, RecoveryIntent generation, RecoveryAttempt, RecoveryBudget, RecoveryPolicy, Evidence Graph schema, and FailureAnalyzer were not modified.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `13.0` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 618 passed, 0 failed |
| Build command | `npm run build` — pass |
| GitHub API | not called |
| OpenAI / DashScope / Qwen | not called |

## 1. Research question

In the same Recovery Budget:

Does a cost-aware Recovery Policy, compared with a naive first-action policy:

- select a lower estimated-cost action
- avoid actions that cover none of the current gaps
- keep gap coverage of the target gaps

This is a measurement of Recovery **decision efficiency**.

It is not a claim that Policy completes more issues. It is not a claim that Policy is a better agent.

## 2. Baseline definition

**Naive first-action policy** (`NaiveRecoveryPolicy` in `src/evaluation/recovery-policy-baseline.ts`).

Input: `RecoveryPolicyInput`

Output: `RecoveryDecision`

Rule: select the first legal candidate in list order.

It does not:

- sort candidates
- compute cost to choose
- read gap severity
- read gap coverage

Example:

```text
Candidates:
[
  search_related_pr,
  fetch_commit_patch,
  inspect_changed_files
]

Baseline selected: search_related_pr
```

## 3. Policy definition

**Phase 12 cost-aware Recovery Policy** (`decideRecoveryPolicy`). Unchanged in this phase.

Input: the same `RecoveryPolicyInput`

Output: `RecoveryDecision`

Rules (existing Phase 12.0):

| Rule | Behavior |
|---|---|
| Blocking gap priority | An action that covers a blocking gap ranks above an action that only covers a warning gap. |
| Gap coverage | An action that resolves more of the uncovered gaps ranks higher. |
| Cost constraint | If `estimatedCost > remaining budget`, reject. Remaining budget is `min(maxAdditionalActions, maxAdditionalToolCalls)` while `maxRecoveryRounds > 0`. |
| Same coverage, lower cost | Equal coverage: choose the lower `estimatedCost`. |
| Stable ordering | Remaining ties keep original candidate order. |

Default remaining budget on these cases: `min(2, 4) = 2` estimatedCost units.

Policy is not reimplemented here. Evaluation only reads its decision.

## 4. Cases

Real-v1 gap types. Candidate lists are evaluation fixtures so that naive first-action and cost-aware selection can be compared on the same input.

Same budget for both sides: `createRecoveryBudget()` (`maxRecoveryRounds = 1`, `maxAdditionalActions = 2`, `maxAdditionalToolCalls = 4`).

### C07 — `missing_patch_evidence`

Candidates:

| Order | Action | estimatedCost | resolvesGapTypes |
|---|---|---|---|
| 1 | `search_related_pr` | 5 | `missing_patch_evidence` |
| 2 | `fetch_commit_patch` | 1 | `missing_patch_evidence` |
| 3 | `inspect_changed_files` | 1 | `missing_patch_evidence` |

### C08 — `insufficient_resolution_context`

Candidates:

| Order | Action | estimatedCost | resolvesGapTypes |
|---|---|---|---|
| 1 | `create_pull_request` | 1 | (none) |
| 2 | `fetch_commit_patch` | 2 | `insufficient_resolution_context` |
| 3 | `inspect_changed_files` | 2 | `insufficient_resolution_context` |

`create_pull_request` cannot cover the current gap. Selecting it would not be a resolution. Evaluation checks that Policy does not select it.

### C10 — `missing_candidate`

Candidates:

| Order | Action | estimatedCost | resolvesGapTypes |
|---|---|---|---|
| 1 | `fetch_commit_patch` | 1 | `missing_patch_evidence`, `insufficient_resolution_context` |
| 2 | `search_resolution_candidates` | 2 | `missing_candidate` |

`fetch_commit_patch` does not cover `missing_candidate`. unknown != resolved.

## 5. Metrics

### Metric 1 — Average Action Cost

```text
sum(selected action estimatedCost) / number of decisions
```

`estimatedCost` is the Phase 12 policy-input cost. It is not RecoveryExecutor actual cost.

### Metric 2 — Gap Coverage

```text
selected action resolves gap count / target gap count
```

A gap is counted as covered only when a selected action profile lists that gap type.

**unknown != resolved.** A missing profile, an empty `resolvesGapTypes`, or a gap type that is not listed is not treated as resolved.

### Metric 3 — Unnecessary Action Rate

```text
selected actions that cover none of the current gaps / total selected actions
```

### Metric 4 — Budget Compliance

```text
selected cost <= remaining policy budget
```

Remaining policy budget is `remainingPolicyBudget(budget)`. Evaluation records a boolean per decision and a rate across decisions.

Not measured:

- completion rate
- winner
- best policy
- RecoveryExecutor success/failure

## 6. Results

Observation metric is Naive first-action vs Phase 12 Policy on the same Recovery Input. This is not accuracy and not LLM quality.

| Case | Gap | Baseline selected | Baseline cost | Baseline coverage | Baseline unnecessary | Baseline budget | Policy selected | Policy cost | Policy coverage | Policy unnecessary | Policy budget |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C07 | `missing_patch_evidence` | `search_related_pr` | 5 | 1.0 | 0 | false (5 > 2) | `fetch_commit_patch` | 1 | 1.0 | 0 | true (1 ≤ 2) |
| C08 | `insufficient_resolution_context` | `create_pull_request` | 1 | 0 | 1.0 | true | `fetch_commit_patch` | 2 | 1.0 | 0 | true |
| C10 | `missing_candidate` | `fetch_commit_patch` | 1 | 0 | 1.0 | true | `search_resolution_candidates` | 2 | 1.0 | 0 | true |

Aggregate over 3 decisions:

| Metric | Baseline | Policy | Difference (policy − baseline) |
|---|---|---|---|
| Average action cost | 7 / 3 = 2.333 | 5 / 3 = 1.667 | −0.667 |
| Gap coverage | 1 / 3 = 0.333 | 3 / 3 = 1.000 | +0.667 |
| Unnecessary action rate | 2 / 3 = 0.667 | 0 / 3 = 0 | −0.667 |
| Budget compliance rate | 2 / 3 = 0.667 | 3 / 3 = 1.000 | +0.333 |

### C07

Policy selected lower estimated cost actions in C07 (1 vs 5).

Gap coverage was 1.0 on both sides. Unnecessary action rate was 0 on both sides.

Baseline selected cost 5, which exceeds remaining budget 2. Policy selected cost 1, which is within remaining budget 2.

### C08

Baseline selected `create_pull_request`. That action covers none of the current gaps, so unnecessary action rate = 1.0 and gap coverage = 0.

Policy rejected `create_pull_request` (`no_gap_coverage`) and selected `fetch_commit_patch`. Gap coverage = 1.0. Unnecessary action rate = 0.

Policy selected higher estimated cost actions in C08 (2 vs 1). The lower baseline cost is the cost of an action that does not cover the gap.

Policy did not select a PR-creating action. Evaluation output does not contain a completion verdict.

### C10

Baseline selected `fetch_commit_patch`. That action does not list `missing_candidate`, so gap coverage = 0 and unnecessary action rate = 1.0.

Policy selected `search_resolution_candidates`. Gap coverage = 1.0. Unnecessary action rate = 0.

Policy selected higher estimated cost actions in C10 (2 vs 1). The lower baseline cost is the cost of an action that does not cover `missing_candidate`.

## 7. Limitations

- Evaluation measures decision efficiency, not completion improvement.
- Policies produce decisions only. Recovery is not executed.
- `estimatedCost` is declared on evaluation / policy profiles. It is not measured tool-call cost.
- Remaining budget is derived from RecoveryBudget caps without runtime usage, because this layer does not execute.
- Focus cases use Real-v1 gap types and fixed candidate lists. They do not re-run Investigation or Recovery Execution.
- C08 / C10 show that a lower selected cost can coincide with zero gap coverage. Cost is not a completion signal.
- Policy is still not wired into `ControlledRecoveryLoop`. Runtime execution still uses the Phase 11.1 selection path.
- No LLM / ML / RL. No policy learning. No adaptive cost model.

## Unchanged modules

Confirmed not modified in this phase:

- `src/investigation/recovery/policy/recovery-policy.ts`
- `src/investigation/recovery/policy/recovery-policy-types.ts`
- `src/investigation/controlled-recovery-loop.ts`
- `src/investigation/recovery/recovery-executor.ts`
- `src/investigation/recovery/recovery-attempt.ts`
- `src/investigation/recovery/recovery-budget.ts`
- `src/investigation/recovery/recovery-intent.ts`
- `src/investigation/resolution-gap-analyzer.ts`
- `src/investigation/resolution-analyzer.ts`
- `src/verification/independent-completion-verifier.ts`
- Evidence Graph / retrieval ranking / selection
- Ground Truth / Real-v1 snapshot schema

New files:

- `src/evaluation/recovery-policy-baseline.ts`
- `src/evaluation/recovery-policy-comparison.ts`
- `src/evaluation/recovery-policy-metrics.ts`
- `tests/recovery-policy-comparison.test.ts`
- `docs/evaluation/phase-13-policy-evaluation.md`

## Required contracts

| Contract | Result |
|---|---|
| Test 1 — Baseline deterministic | pass |
| Test 2 — Policy comparison deterministic | pass |
| Test 3 — Cost calculation correct | pass |
| Test 4 — Gap coverage calculation correct | pass |
| Test 5 — Budget compliance | pass |
| Test 6 — Evaluation does not modify runtime state | pass |

## Conclusion

Phase 13.0 adds a read-only Evaluation Layer that compares Naive first-action decisions with Phase 12 cost-aware Recovery Policy decisions.

On these three cases, the metric differences were:

- C07: Policy selected lower estimated cost actions (1 vs 5); gap coverage stayed 1.0.
- C08: Baseline selected `create_pull_request` with gap coverage 0; Policy selected `fetch_commit_patch` with gap coverage 1.0.
- C10: Baseline selected `fetch_commit_patch` with gap coverage 0; Policy selected `search_resolution_candidates` with gap coverage 1.0.

This does not prove that Policy solves more issues. IndependentCompletionVerifier remains the only completion authority.

Phase 13.1 policy learning / adaptive cost model / reinforcement learning / self-healing / multi-round recovery / semantic retrieval / runtime optimization are not started.
