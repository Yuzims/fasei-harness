# Phase 11.2 — Recovery Evaluation Framework

## Evaluation Scope

This run adds an independent **Evaluation Layer**. It compares:

```text
Baseline Investigation
  vs
Recovery Enabled Investigation
```

It sits after Phase 11.1 Controlled Recovery Loop. Runtime behavior is unchanged.

It answers:

> When Investigation reports a Failure, can a Controlled Recovery Loop add Evidence and improve the measured investigation state, and under which Failure types?

It does **not** prove that Recovery is always better. It does **not** optimize for completion rate. It does **not** pick a winner.

`IndependentCompletionVerifier` remains the only completion authority. Evaluation only reads results. It does not write InvestigationRun, Evidence, claims, or verifier status.

Evaluated:

- Metric contracts in `tests/recovery-evaluation.test.ts`
- Real-v1 `C07`, `C08`, and `C10` via `evaluateRecoveryLoopFocusCases()`

Each Real-v1 case used the same Investigation Agent, the same deterministic Fake Model policy (`createStrategyEvaluationModel` / `nextInvestigationAction`), `SnapshotGitHubProvider`, `maxAttempts = 3`, `maxSteps = 12`, and `compactPatchExposure = patch_enabled`. Ground truth / `expectedOutcome` was loaded only by the evaluator after the run.

Baseline is Attempt 1 **without** a RecoveryExecutor. Recovery is the existing Phase 11.1 loop (`maxRecoveryRounds = 1`) invoked by the evaluator. C07's `missing_patch_evidence` is warning, so runtime auto-trigger would not fire; the evaluator invokes the loop to measure information change. Runtime auto-trigger remains blocking-only.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, completion semantics, Ground Truth, Real-v1 snapshots, retrieval ranking, candidate selection, Resolution Analyzer, Resolution Gap Analyzer detection rules, ControlledRecoveryLoop, RecoveryExecutor, RecoveryIntent, RecoveryAttempt, RecoveryBudget, Evidence Graph schema, and FailureAnalyzer were not modified.

No live LLM was called. RecoveryExecutor remains an evaluation-time abstraction and is not bound to the GitHub HTTP client.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `11.2` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 593 passed, 0 failed |
| Build command | `npm run build` — pass |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |

## 1. Experiment question

When Investigation produces a Failure / Resolution Gap, does a Controlled Recovery Loop improve investigation state by adding Evidence?

This is a measurement question:

- Does Recovery reduce observed gaps?
- Does Recovery increase evidence count?
- Does Verification status change?
- What additional tool calls / attempts / actions does that cost?
- For which gap types is Recovery effective on this fixture?

This is not a claim that Recovery always raises completion rate.

## 2. Baseline definition

**Baseline Investigation** = Phase 11.1 Attempt 1 with Recovery **not** executed.

In this harness that means `investigate()` without `recoveryExecutor`. The Investigation Agent records Attempt 1, Resolution Gaps, IndependentCompletionVerifier status, and evidence count. No RecoveryAttempt is created.

## 3. Recovery definition

**Recovery Enabled Investigation** = the same Baseline run, then the existing Phase 11.1 Controlled Recovery Loop:

```text
Attempt #1
  → ResolutionGapAnalyzer
  → RecoveryIntent
  → RecoveryBudget
  → RecoveryActionCandidate
  → RecoveryExecutor
  → Attempt #2
  → Re-analysis
  → IndependentCompletionVerifier
```

Default budget remains:

```text
maxRecoveryRounds = 1
maxAdditionalActions = 2
maxAdditionalToolCalls = 4
```

Evaluation does not change that budget, does not add a second round, and does not alter Recovery Policy.

## 4. Evaluation architecture

```text
Baseline result (read)
Recovery result (read)
        │
        ▼
evaluateRecoveryImpact()
        │
        ▼
RecoveryEvaluationResult
        │
        ▼
analyzeRecoveryEffectivenessByGapType()
```

New files:

- `src/evaluation/recovery-evaluation-types.ts` — `RecoveryEvaluationResult` and related views
- `src/evaluation/recovery-loop-evaluation.ts` — `evaluateRecoveryImpact()` plus Real-v1 case runner
- `tests/recovery-evaluation.test.ts`
- `docs/evaluation/phase-11.2-recovery-evaluation.md`

`evaluateRecoveryImpact()` copies input snapshots. It does not mutate caller arrays, InvestigationRun, Evidence Graph, or verifier internals.

## 5. Metrics

### Gap Reduction

```text
removed gaps / initial gaps
```

Example:

```text
Before: [missing_patch_evidence, missing_validation_evidence]
After:  [missing_validation_evidence]
Result: 0.5
```

Empty baseline gaps yield `0`. A removed gap is an information-hole change only.

**unknown != resolved.** Evaluation must not infer that the issue is solved because a gap list got shorter.

### Evidence Gain

```text
afterEvidenceCount - beforeEvidenceCount
```

This is a count delta only. It is not evidence quality and not completion.

### Verification Delta

Records Baseline verifier status and After-Recovery verifier status.

Allowed labels:

- `unchanged`
- `improved`
- `worse`

`verificationChanged` is the boolean form of that pair. Evaluation does not emit a winner.

Observed rank used only to label `improved` / `worse`:

```text
insufficient_evidence < not_verified < verified_complete
```

That rank is not a completion policy. IndependentCompletionVerifier still owns completion.

### Recovery Cost

Observed, not estimated:

| Cost | Source |
|---|---|
| additional tool calls | trace `tool_call` after `recovery_attempt_started`, else selected actions on that event / budget usage |
| additional attempts | trace `recovery_attempt_started` count, else RecoveryAttempts |
| additional actions | trace `actions` on `recovery_attempt_started`, else budget usage |

No token estimate. No reconstructed LLM spend.

## 6. Case results

Observation metric is Baseline vs Recovery on Real-v1. This is not accuracy and not LLM quality.

| Case | Baseline gaps | Recovery executed | Actions | After gaps | Gap reduction | Evidence gain | Verification | Cost (calls / attempts / actions) | False candidate |
|---|---|---|---|---|---|---|---|---|---|
| C07 | `missing_patch_evidence` (16 evidence, `insufficient_evidence`) | yes | `fetch_commit_patch`, `inspect_changed_files` | none (18 evidence, `insufficient_evidence`) | 1.0 | +2 | unchanged | 2 / 1 / 2 | 0 |
| C08 | `insufficient_resolution_context` (4 evidence, `insufficient_evidence`) | yes | `fetch_commit_patch`, `inspect_changed_files` | same (4 evidence, `insufficient_evidence`) | 0 | 0 | unchanged | 2 / 1 / 2 | 0 |
| C10 | `missing_candidate` (3 evidence, `insufficient_evidence`) | yes | `search_resolution_candidates` | same (3 evidence, `insufficient_evidence`) | 0 | 0 | unchanged | 1 / 1 / 1 | 0 |

Verifier stayed `insufficient_evidence` on every case. Recovery did not assign `VERIFIED_COMPLETE`. Parent Attempt 1 verification fingerprint held.

### C07 — better-auth#4490

Scene: candidate exists, file evidence exists, patch missing.

- Baseline gap: `missing_patch_evidence`
- Recovery intent path: `collect_resolution_evidence` → `fetch_commit_patch` / `inspect_changed_files`
- After: gap set empty, evidence 16 → 18
- Verifier stayed `insufficient_evidence`
- Recovery added Evidence. It did not write verifier status and did not bypass IndependentCompletionVerifier.

Gap reduction = 1.0 does **not** mean the issue is resolved. unknown != resolved.

### C08 — bar-lobby#291

Scene: commit exists, PR/files missing / resolution context insufficient.

- Recovery executed `collect_resolution_evidence` actions
- No pull-request Evidence was manufactured
- `falseCandidateCount = 0`
- Gap and evidence count unchanged on this snapshot executor

### C10 — playwright-mcp#1495

Scene: no candidate.

- Recovery executed `expand_candidate_discovery` / `search_resolution_candidates`
- Recovery did not create a candidate
- `falseCandidateCount = 0`
- Gap and evidence count unchanged

## 7. Failure type analysis

Recovery effectiveness by baseline gap type. This is an observation table. It is not a best-strategy ranking and not a winner.

| Gap type | Cases | avgGapReduction |
|---|---|---|
| `missing_patch_evidence` | C07 | 1.0 |
| `insufficient_resolution_context` | C08 | 0 |
| `missing_candidate` | C10 | 0 |

On this Fake Model + snapshot RecoveryExecutor, Recovery reduced `missing_patch_evidence` and did not reduce `insufficient_resolution_context` or `missing_candidate`. That is a Failure-type measurement, not a policy change.

## 8. Limitations

- Evaluation does **not** prove Recovery always improves completion rate.
- Deterministic Fake Model only. No live LLM sample.
- `maxRecoveryRounds = 1`. Multi-round recovery, self-healing, and strategy learning are out of scope.
- Runtime auto-trigger is still blocking-gap only. C07 is evaluator-invoked.
- C07 patch Evidence is collected by the evaluation RecoveryExecutor from already-observed files. The Real-v1 snapshot still has no native patches. Recovery did not call GitHub HTTP and did not mint a PR.
- Evidence gain is a count. Quality is not scored.
- Gap reduction is not resolution. A missing gap is unknown, not verified complete.
- C08 / C10 show that Recovery can run at non-zero cost and still leave gaps unchanged.
- Cost is read from Phase 11.1 recovery trace / budget usage. It is not re-estimated.

## Unchanged modules

Confirmed not modified in this phase:

- `src/investigation/controlled-recovery-loop.ts`
- `src/investigation/recovery/recovery-executor.ts`
- `src/investigation/recovery/recovery-intent.ts`
- `src/investigation/recovery/recovery-attempt.ts`
- `src/investigation/recovery/recovery-budget.ts`
- `src/investigation/resolution-gap-analyzer.ts`
- `src/investigation/resolution-analyzer.ts`
- `src/verification/independent-completion-verifier.ts`
- Evidence Graph / retrieval ranking / selection
- Ground Truth / Real-v1 snapshot schema

## Required contracts

| Contract | Result |
|---|---|
| Test 1 — Baseline and Recovery can be compared independently | pass |
| Test 2 — Gap reduction is removed gaps / initial gaps | pass |
| Test 3 — Evidence gain does not represent completion | pass |
| Test 4 — Verifier invariant holds; no winner | pass |
| Test 5 — False candidate count does not increase | pass |
| Test 6 — Evaluation does not modify runtime state | pass |

## Conclusion

Phase 11.2 adds a read-only Evaluation Layer that compares Baseline Investigation with Recovery Enabled Investigation. On Real-v1 C07, Recovery reduced `missing_patch_evidence` and added Evidence without changing verifier status. On C08 and C10, Recovery executed, added no false candidates, and did not reduce the baseline gap.

This does not prove Recovery always improves completion rate. IndependentCompletionVerifier remains the only completion authority.

Phase 11.3 Recovery Policy changes / multi-round recovery / self-healing / strategy learning / semantic retrieval / runtime optimization are not started.
