# Phase 11.0 — Recovery Intent Layer

## Evaluation Scope

This run observes the **Recovery Intent** abstraction on:

1. Synthetic Gap → Intent contracts in `tests/recovery-intent.test.ts`
2. Real-v1 focus cases `C01`, `C07`, and `C08` via `evaluatePhase110FocusCases()`

The new layer sits after Resolution Gap Analyzer and before Recovery execution:

```text
Failure Localization
  → Recovery Intent
  → Recovery Action Candidate
```

It answers:

> What capability is missing, and what candidate actions could collect it?

It does **not** execute recovery. It does not call tools. It does not retry. It does not change investigation state. It cannot produce `VERIFIED_COMPLETE`.

`IndependentCompletionVerifier` remains the only completion authority.

Evaluated:

- Unit / synthetic contracts in `tests/recovery-intent.test.ts`
- Real-v1 `C01`, `C07`, `C08` via `evaluatePhase110FocusCases()` (reuses Phase 10.2 gap observations, then maps them)

Each Real-v1 case used the same Investigation Agent, the same deterministic Fake Model policy (`createStrategyEvaluationModel` / `nextInvestigationAction`), `SnapshotGitHubProvider`, `maxAttempts = 3`, `maxSteps = 12`, and `compactPatchExposure = patch_enabled`. Ground truth / `expectedOutcome` was loaded only by the evaluator after the run.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, Ground Truth, Real-v1 snapshots, retrieval ranking, discovery, Evidence-Gap Strategy, RecoveryPlanner core logic, FailureAnalyzer, Resolution Analyzer, Resolution Gap Analyzer detection rules, and Agent Loop were not modified.

No live LLM was called. Gap → Intent mapping is deterministic. Adapter candidates have `autoExecute = false`.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `11.0` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 576 passed, 0 failed |
| Build command | `npm run build` — pass |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |

## What Intent can and cannot claim

Recovery Intent can produce:

| Objective | Meaning |
|---|---|
| `collect_resolution_evidence` | File / patch / resolution context is missing |
| `collect_validation_evidence` | Validation evidence was not observed |
| `expand_candidate_discovery` | No resolution candidate was observed |
| `improve_issue_change_alignment` | Issue/change overlap is weak |

It cannot produce:

- a tool name or GitHub API call
- an execution result
- `VERIFIED_COMPLETE`
- a change to verifier status
- an automatic retry

Intent describes **what capability is missing**, not **which tool to call**.

## Gap → Intent mapping

| Gap | Objective |
|---|---|
| `missing_patch_evidence` | `collect_resolution_evidence` |
| `missing_file_evidence` | `collect_resolution_evidence` |
| `insufficient_resolution_context` | `collect_resolution_evidence` |
| `missing_validation_evidence` | `collect_validation_evidence` |
| `missing_candidate` | `expand_candidate_discovery` |
| `weak_issue_change_alignment` | `improve_issue_change_alignment` |

Same objective merges. `missing_patch_evidence` + `missing_file_evidence` yields one `collect_resolution_evidence` intent whose `triggerGapTypes` retains both gap types.

## Adapter behavior

`toRecoveryActionCandidatesFromIntents(intents)` emits capability candidates only.

| Intent | Candidate actions (examples) |
|---|---|
| `collect_resolution_evidence` | `fetch_commit_patch`, `inspect_changed_files` |
| `collect_validation_evidence` | `search_regression_tests` |
| `expand_candidate_discovery` | `search_resolution_candidates` |
| `improve_issue_change_alignment` | `inspect_issue_change_alignment`, `inspect_changed_files` |

`autoExecute` is always `false`. RecoveryPlanner.plan() is not called by this layer. Agent Loop is not modified.

## Trace

New event type: `recovery_intent`.

Payload (`RecoveryIntentEvent`):

```text
failureId, gapTypes, intent
```

Decision only. No tool result, no API call, no execution success/failure.

This phase records the event through `recordRecoveryIntentDecisions()`. It is not wired into Agent Loop.

## Required contracts

| Contract | Result |
|---|---|
| Test 1 — `missing_patch_evidence` → `collect_resolution_evidence` | pass |
| Test 2 — patch + file gaps merge into one intent | pass |
| Test 3 — Intent contains no tool call / API call / execution | pass |
| Test 4 — Intent does not change verifier result | pass |
| Test 5 — `external_untrusted` evidence cannot change Intent classification | pass |

## Focus-case observation

Observation metric is whether the Gap → Intent contract holds, not resolution success.

| Case | Phase 10.2 gap | Intent | Verifier invariant |
|---|---|---|---|
| C01 | `missing_patch_evidence` | `collect_resolution_evidence` | hold |
| C07 | `missing_patch_evidence` | `collect_resolution_evidence` | hold |
| C08 | `insufficient_resolution_context` | one `collect_resolution_evidence` | hold |

`verifierInvariant = hold` means Independent Completion Verifier status and check ids are unchanged when Recovery Intent / adapter run.

## Unchanged modules

Confirmed not modified in this phase:

- `src/verification/independent-completion-verifier.ts`
- verifier `RESOLUTION_CHAIN` / completion semantics
- `src/investigation/resolution-chain.ts`
- `src/investigation/resolution-analyzer.ts`
- `src/investigation/resolution-gap-analyzer.ts` detection rules
- `src/investigation/retrieval/ranking.ts`
- `src/investigation/retrieval/discovery.ts`
- `src/investigation/retrieval/selection.ts`
- `src/investigation/evidence-gap.ts`
- `src/investigation/recovery-planner.ts`
- `src/investigation/failure-analyzer.ts`
- `src/agent/agent-loop.ts`
- `src/investigation/investigation-agent.ts`
- `fixtures/benchmark/dataset/real-v1/**`
- `fixtures/benchmark/dataset/real-v1/ground-truth.json`

## Limitations

- Deterministic Fake Model only. No live LLM sample.
- Recovery Intent is an intermediate abstraction. Candidates are not executed in this phase.
- Trace events are recorded by helper, not by the investigation Agent Loop.
- Real-v1 observation reuses Phase 10.2 primary-chain gaps; it does not re-decide gap type.

## Conclusion

Phase 11.0 adds a code-constrained Recovery Intent layer. Gaps map deterministically onto intents. Multiple resolution-evidence gaps merge. Intent objects do not contain tool execution. Independent Completion Verifier remains the only completion authority.

Phase 11.1 Recovery Execution is not started.
