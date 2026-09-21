# Phase 10.2 — Resolution Gap Analyzer

## Evaluation Scope

This run observes **Resolution Gap Analyzer** on Real-v1 focus cases `C01`, `C07`, and `C08`.

The analyzer sits after Resolution Analyzer / Resolution Chain and before Recovery Planner. It answers:

> Why is the current Resolution Explanation still insufficient for further verification?

It is **not** a Verifier. It does not decide that an issue is solved. It does not decide that a PR is valid. It only performs Failure Localization + Recovery Signal.

```text
Issue
  → Investigation Agent
  → Evidence Graph
  → Resolution Analyzer
  → Resolution Chain
  → Resolution Gap Analyzer
  → Recovery Planner   (adapter only; suggestions are not executed)
```

`IndependentCompletionVerifier` remains the only completion authority.

Evaluated:

- Unit / synthetic contracts in `tests/resolution-gap-analyzer.test.ts`
- Real-v1 `C01`, `C07`, `C08` via `evaluatePhase102FocusCases()`

Each Real-v1 case used the same Investigation Agent, the same deterministic Fake Model policy (`createStrategyEvaluationModel` / `nextInvestigationAction`), `SnapshotGitHubProvider`, `maxAttempts = 3`, `maxSteps = 12`, and `compactPatchExposure = patch_enabled`. Ground truth / `expectedOutcome` was loaded only by the evaluator after the run. Observation is on the **primary** Resolution Chain (strongest file/patch/test provenance), matching Phase 10.0.

Independent Completion Verifier, verifier `RESOLUTION_CHAIN`, Ground Truth, Real-v1 snapshots, retrieval ranking, discovery, Evidence-Gap Strategy, RecoveryPlanner core logic, and FailureAnalyzer were not modified.

No live LLM was called. Gap type is assigned by deterministic rules. Explanations are template text, not completion evidence. Recovery suggestions are not executed.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `10.2` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 566 passed, 0 failed |
| Build command | `npx tsc --noEmit` |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |

## What the analyzer can and cannot claim

Resolution Gap Analyzer can produce:

| Gap type | Meaning |
|---|---|
| `missing_candidate` | Issue exists; no resolution candidate was observed |
| `missing_file_evidence` | File-change evidence was not observed |
| `missing_patch_evidence` | Bounded patch / code-change evidence is unavailable (`unknown`, not absent) |
| `missing_validation_evidence` | Validation evidence was not observed |
| `insufficient_resolution_context` | Issue + candidate exist, but file and patch were not observed |
| `weak_issue_change_alignment` | Weak issue/change overlap and no behavior hypothesis |

It cannot produce:

- `issue fixed` / `PR valid`
- `No code change happened` (unknown ≠ absent)
- `No tests exist` (unknown ≠ absent)
- `code_change unsupported` from missing patch
- `VERIFIED_COMPLETE`

Gaps must cite existing Evidence IDs. Fake evidence is not created. `external_untrusted` trust does not change gap classification.

## Focus-case results

Observation metric is whether the information hole is exposed, not accuracy.

| Case | Candidate | File | Patch | Resolution overall | Gap | Severity | Verifier | Invariant |
|---|---|---|---|---|---|---|---|---|
| C01 | yes | yes | no | partial | `missing_patch_evidence` | warning | verified_complete | hold |
| C07 | yes | yes | no | partial | `missing_patch_evidence` | warning | insufficient_evidence | hold |
| C08 | commit | no | no | unknown | `insufficient_resolution_context` | blocking | insufficient_evidence | hold |

`verifierInvariant = hold` means Independent Completion Verifier status and check ids are unchanged when Resolution Gap Analyzer runs, and unchanged when `resolutionAnalyses` are stripped.

### C01 — vscode#258694

Expected: Resolution `supported` / `partial`; Gap none or warning.

- Primary chain is a merged PR with file metadata (`terminalSuggestAddon.ts` / `simpleSuggestWidget.ts`) and no bounded patch.
- `overall = partial` from Phase 10.0 file-scope alignment.
- Gap: `missing_patch_evidence` at **warning**. File evidence exists, so the missing patch is an information hole, not an “absent code change” claim.
- Recommended actions: `fetch_commit_patch`, `inspect_changed_files` (suggestion only).
- Verifier remains `verified_complete`. Gap Analyzer did not create that verdict.

### C07 — better-auth#4490

Expected: candidate exists, file exists, patch missing → `missing_patch_evidence`.

- Primary chain has PR/file evidence (`multi-session` paths) and no bounded patch.
- Gap: `missing_patch_evidence`. This is why the current explanation cannot support further verification: file-scope overlap is not patch-level analysis.
- Verifier remains `insufficient_evidence`.

### C08 — bar-lobby#291

Expected: commit exists; PR/file/patch missing → `insufficient_resolution_context`.

- Snapshot has commits and no pull-request file/patch rows.
- Gap: `insufficient_resolution_context` (blocking). Issue + candidate exist; file and patch were not observed. Rule 1 / Rule 3 are not emitted separately; they are subsumed by this context gap.
- Verifier remains `insufficient_evidence`.

## Required contracts (unit)

| Contract | Result |
|---|---|
| Gap Analyzer does not change verifier result | pass |
| Unknown evidence cannot generate an absent claim | pass |
| Missing patch cannot generate `code_change unsupported` | pass |
| Every gap cites existing Evidence IDs | pass |
| Recovery suggestion is not auto-executed | pass |
| `external_untrusted` evidence cannot change gap classification | pass |

## Recovery signal mapping

| Gap | `recommendedActions` |
|---|---|
| `missing_patch_evidence` | `fetch_commit_patch`, `inspect_changed_files` |
| `missing_validation_evidence` | `search_regression_tests` |
| `missing_file_evidence` | `inspect_changed_files` |
| `insufficient_resolution_context` | `inspect_changed_files`, `fetch_commit_patch` |
| `missing_candidate` | `search_resolution_candidates` |
| `weak_issue_change_alignment` | `inspect_issue_change_alignment`, `inspect_changed_files` |

Adapter: `toRecoveryActionCandidates(gaps)` maps a gap to a Recovery Action Candidate (`gather_missing_evidence` / `change_retrieval_strategy`). `autoExecute` is always `false`. RecoveryPlanner.plan() is not called and is unchanged.

## Unchanged modules

Confirmed not modified in this phase:

- `src/verification/independent-completion-verifier.ts`
- verifier `RESOLUTION_CHAIN` / completion semantics
- `src/investigation/retrieval/ranking.ts`
- `src/investigation/retrieval/discovery.ts`
- `src/investigation/retrieval/selection.ts`
- `src/investigation/evidence-gap.ts`
- `src/investigation/recovery-planner.ts`
- `src/investigation/failure-analyzer.ts`
- `src/domain/resolution-alignment.ts`
- `fixtures/benchmark/dataset/real-v1/**`
- `fixtures/benchmark/dataset/real-v1/ground-truth.json`

## Limitations

- Deterministic Fake Model only. No live LLM sample.
- Resolution Chain is derived from Phase 10.0 Resolution Analyzer signals + Evidence Graph. Gap rules read those statuses; they do not invent evidence.
- Real-v1 snapshots still have file metadata and almost no bounded diffs. C01 and C07 therefore expose the same patch hole; C01 is warning because resolution explanation is already `partial`.
- Recovery suggestions are not executed and do not change investigation trajectory in this phase.

## Conclusion

Phase 10.2 adds a code-constrained Resolution Gap Analyzer that localizes why a Resolution Explanation cannot support further verification. C01 shows a warning-level patch hole on an otherwise partial explanation. C07 shows `missing_patch_evidence` when a candidate and files exist without a patch. C08 shows `insufficient_resolution_context` when only a commit candidate is present.

Independent Completion Verifier remains the only completion authority.
