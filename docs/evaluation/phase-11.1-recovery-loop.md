# Phase 11.1 — Controlled Recovery Loop

## Evaluation Scope

This run observes whether a **Failure Signal can drive one controlled re-investigation** and produce a measurable information change.

It sits after Phase 11.0 Recovery Intent:

```text
Attempt #1
  → Failure Localization
  → Recovery Intent
  → Recovery Action Selection
  → Controlled Execution
  → Attempt #2
  → Re-analysis
  → Verifier
```

It answers:

> Can a Resolution Gap drive a budgeted Recovery Attempt that only adds Evidence, without overwriting the parent attempt or changing IndependentCompletionVerifier?

It does **not** let the Agent automatically solve the issue. It does **not** let Recovery set success or rewrite the verifier result.

`IndependentCompletionVerifier` remains the only completion authority. All results still pass Evidence → Verifier.

Evaluated:

- Unit / synthetic contracts in `tests/recovery-loop.test.ts`
- Real-v1 `C07`, `C08`, and `C10` via `evaluatePhase111FocusCases()`

Each Real-v1 case used the same Investigation Agent, the same deterministic Fake Model policy (`createStrategyEvaluationModel` / `nextInvestigationAction`), `SnapshotGitHubProvider`, `maxAttempts = 3`, `maxSteps = 12`, and `compactPatchExposure = patch_enabled`. Ground truth / `expectedOutcome` was loaded only by the evaluator after the run. Recovery then ran as a separate controlled loop with `maxRecoveryRounds = 1`.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, completion semantics, Ground Truth, Real-v1 snapshots, retrieval ranking, candidate selection, Resolution Analyzer, Resolution Gap Analyzer detection rules, RecoveryPlanner core logic, and FailureAnalyzer were not modified.

No live LLM was called. RecoveryExecutor is an abstraction and is not bound to the GitHub HTTP client. Runtime auto-trigger is blocking-gap only.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `11.1` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 587 passed, 0 failed |
| Build command | `npm run build` — pass |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |

## Architecture change

Before this phase:

```text
Investigation Attempt
  → Failure
  → Gap
  → Recovery Intent
  → Recovery Action Candidate
```

Candidates were suggestions. They were not executed.

After this phase:

```text
Attempt #1
  → ResolutionGapAnalyzer
  → RecoveryIntent (blocking only auto-triggers)
  → RecoveryBudget check
  → RecoveryActionCandidate selection
  → RecoveryExecutor.execute
  → new InvestigationAttempt
  → ResolutionAnalyzer + GapAnalyzer + IndependentCompletionVerifier
```

Recovery is a **new investigation attempt**. The parent attempt is kept. Evidence may be appended. Claims, verifier internals, and completion status are not written by the executor.

## Attempt lifecycle

1. Attempt 1 finishes and is appended to `InvestigationRun.attempts`.
2. Gaps / intents are derived. Warning gaps are recorded (`recovery_intent`) and not auto-executed.
3. If a blocking gap exists and `RecoveryBudget` allows it, a `RecoveryAttempt` is created with `parentAttemptId = attempt-1`.
4. Selected actions run through `RecoveryExecutor`. Added IDs must already exist on the Evidence graph; unknown IDs are dropped.
5. Attempt 2 is appended. It points at Attempt 1. Attempt 1’s `evidenceIds` / `verification` snapshot is unchanged.
6. Resolution analysis, gap analysis, and IndependentCompletionVerifier re-run on the updated Evidence graph.

Default budget:

```text
maxRecoveryRounds = 1
maxAdditionalActions = 2
maxAdditionalToolCalls = 4
```

Budget is checked in the runtime layer. The Agent does not choose how many times to continue. A second recovery with `maxRecoveryRounds = 1` is rejected as `budget_exhausted`.

## Trace

New event: `recovery_attempt_started`

Payload:

```text
parentAttemptId, recoveryIntentIds, actions
```

New event: `recovery_execution_completed`

Payload:

```text
recoveryAttemptId, addedEvidenceIds, status
```

Observed chain:

```text
Attempt 1
  → Failure / Gap
  → Intent
  → RecoveryAttempt
  → Execution
  → Attempt 2
```

`addedEvidenceIds` are new Evidence IDs only. They are not verification evidence.

## Required contracts

| Contract | Result |
|---|---|
| Test 1 — RecoveryAttempt does not overwrite the original Attempt | pass |
| Test 2 — Budget=0 cannot execute recovery | pass |
| Test 3 — `maxRecoveryRounds=1` cannot start a second recovery | pass |
| Test 4 — Recovery does not change verifier | pass |
| Test 5 — Recovery can only add Evidence | pass |
| Test 6 — `external_untrusted` evidence cannot trigger false completion | pass |

Test 4 means Recovery does not mutate Attempt 1’s `VerificationResult` and does not carry a verifier field on `RecoveryAttempt`. Attempt 2’s verdict is produced by `IndependentCompletionVerifier.verify()` after Evidence is added.

## Focus-case observation

Observation metric is whether the controlled loop created a new attempt and a measurable evidence/gap change. This is not accuracy and not LLM quality.

| Case | Before | Recovery | New attempt | Patch evidence | Gap reduced | False candidate | Verifier |
|---|---|---|---|---|---|---|---|
| C07 | candidate yes, files yes, patch no; `missing_patch_evidence` (warning) | `collect_resolution_evidence` / `fetch_commit_patch` | yes (1→2) | added | yes (`missing_patch_evidence` removed) | 0 | hold (`insufficient_evidence`) |
| C08 | commit exists; `insufficient_resolution_context` (blocking) | executed; no PR manufactured | yes (1→2) | none | no | 0 | hold (`insufficient_evidence`) |
| C10 | no candidate; `missing_candidate` (blocking) | executed; no candidate forged | yes (1→2) | none | no | 0 | hold (`insufficient_evidence`) |

`verifierInvariant = hold` means Attempt 1’s verification fingerprint is unchanged, Recovery did not assign `VERIFIED_COMPLETE`, and IndependentCompletionVerifier remains the only completion authority.

### C07 — better-auth#4490

Expected: candidate + files, no patch → `missing_patch_evidence` → `collect_resolution_evidence` → `fetch_commit_patch`.

- Attempt 1 kept. Attempt 2 created.
- Controlled executor collected bounded patch Evidence from already-observed files. Original file Evidence was not rewritten.
- Gap set went from `missing_patch_evidence` to empty.
- Verifier stayed `insufficient_evidence`. Parent verification fingerprint held.
- This gap is **warning** under current detection rules, so runtime auto-trigger would not fire. The evaluator invoked the loop to measure information change. Runtime auto-trigger remains blocking-only.

### C08 — bar-lobby#291

Expected: commit exists, context insufficient. Recovery must not manufacture a PR.

- Blocking `insufficient_resolution_context` auto-trigger would fire.
- Recovery executed `collect_resolution_evidence` actions and added no pull-request Evidence.
- `falseCandidateCount = 0`.
- Gap unchanged. Verifier stayed `insufficient_evidence`.

### C10 — playwright-mcp#1495

Expected: no candidate. Recovery must not forge a candidate.

- Blocking `missing_candidate` auto-trigger would fire.
- Recovery executed `expand_candidate_discovery` / `search_resolution_candidates` and added no pull-request or commit Evidence.
- `falseCandidateCount = 0`.
- Gap unchanged. Verifier stayed `insufficient_evidence`.

## Unchanged modules

Confirmed not modified in this phase:

- `src/verification/independent-completion-verifier.ts`
- verifier `RESOLUTION_CHAIN` / completion semantics / `VERIFIED_COMPLETE` rules
- `src/investigation/resolution-chain.ts`
- `src/investigation/resolution-analyzer.ts`
- `src/investigation/resolution-gap-analyzer.ts` detection rules
- `src/investigation/retrieval/ranking.ts`
- `src/investigation/retrieval/selection.ts`
- Ground Truth / Real-v1 snapshot schema
- `src/investigation/recovery-planner.ts`
- `src/investigation/failure-analyzer.ts`
- `src/agent/agent-loop.ts`

## Limitations

- Deterministic Fake Model only. No live LLM sample.
- `maxRecoveryRounds = 1`. Multi-round recovery is out of scope.
- Runtime auto-trigger is blocking-gap only. C07’s `missing_patch_evidence` is warning, so the evaluator invoked recovery; the Agent did not decide to continue.
- C07 patch Evidence was collected by a RecoveryExecutor that adds bounded diffs onto already-observed files. The Real-v1 snapshot still has no native patches. Recovery did not call GitHub HTTP and did not mint a PR.
- RecoveryExecutor cannot judge that an issue is solved and cannot write verifier status.

## Conclusion

Phase 11.1 connects Gap → Intent → Candidate to a budgeted Recovery Execution Loop. Recovery is a new InvestigationAttempt linked to the parent attempt. It can add Evidence and change measured gaps. It cannot overwrite Attempt 1, set success, forge candidates, or bypass IndependentCompletionVerifier.

Phase 11.2 multi-round recovery / self-healing / strategy learning is not started.
