# Phase 10.0 — Resolution Effect Analysis MVP

## Evaluation Scope

This run observes **Candidate Resolution Evidence Analysis** on Real-v1 focus cases `C01`, `C07`, and `C08`.

The new Resolution Analyzer sits after Investigation Agent observations and before Independent Completion Verifier. It produces **Resolution Claims** and supporting signals. It does not decide that an issue is solved. It cannot produce `VERIFIED_COMPLETE`.

```text
Issue
  → Candidate Retrieval
  → Investigation Agent
  → Resolution Analyzer
  → Evidence Graph provenance
  → Independent Verifier
```

Evaluated:

- Unit / synthetic contracts in `tests/resolution-analyzer.test.ts`
- Real-v1 `C01`, `C07`, `C08` via `evaluatePhase10FocusCases()`

Each Real-v1 case used the same Investigation Agent, the same deterministic Fake Model policy (`createStrategyEvaluationModel` / `nextInvestigationAction`), `SnapshotGitHubProvider`, `maxAttempts = 3`, `maxSteps = 12`, and `compactPatchExposure = patch_enabled`. Ground truth / `expectedOutcome` was loaded only by the evaluator after the run. Real-v1 agent input was built from `convertCaseToScenario()` plus `createInvestigationTask()`.

Independent Completion Verifier, RESOLUTION_CHAIN, Ground Truth, Real-v1 snapshots, retrieval ranking, discovery, Evidence-Gap Strategy, RecoveryPlanner, and FailureAnalyzer were not modified.

No live LLM was called. Structured signal status is assigned by code. Explanations are template text, not completion evidence.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `10.0` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 556 passed, 0 failed |
| Build command | `npx tsc --noEmit` |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |

## What the analyzer can and cannot prove

Resolution Analyzer can produce:

| Signal | Meaning |
|---|---|
| `file_scope_alignment` | Changed-file paths share lexical / structural tokens with the issue text |
| `patch_intent_alignment` | A bounded patch shares lexical tokens with the issue text |
| `test_evidence` | A file path contains `test` / `tests` / `spec` / `specs` as a path signal |

It cannot produce:

- `issue fixed`
- `merged PR => solved`
- `PR title/body => resolution proof`
- `VERIFIED_COMPLETE`

Lexical overlap ≠ the change actually fixes the issue. A test-file path ≠ tests passed. `overall: supported` is still an investigation claim.

## Focus-case results

Primary claim per case is the Resolution Analysis with the strongest file/patch/test provenance (not the first discovered candidate). Signals always cite Evidence IDs.

| Case | Candidate | Files | Patch in snapshot | file_scope | patch_intent | test_evidence | overall | Verifier | Invariant |
|---|---|---|---|---|---|---|---|---|---|
| C01 | PR | yes | no | supported | unknown | absent | partial | verified_complete | hold |
| C07 | PR + commit | yes | no | supported | unknown | present | partial | insufficient_evidence | hold |
| C08 | commit | no | no | unknown | unknown | unknown | unknown | insufficient_evidence | hold |

`verifierInvariant = hold` means Independent Completion Verifier status and check ids are unchanged when `resolutionAnalyses` are stripped.

### C01 — vscode#258694

Observe: whether PR + patch produce alignment evidence.

- Investigation retrieved more than one PR. Unmerged PR `#275576` has no file evidence. Merged PR `#284149` has file metadata for `terminalSuggestAddon.ts` and `simpleSuggestWidget.ts`.
- `file_scope_alignment = supported` on the merged PR: path tokens overlap `terminal` / `suggestion` in the issue title. This is domain-scope evidence, not “issue fixed”.
- Snapshot has **no bounded unified diff**. `patch_intent_alignment = unknown`.
- No test-file path. `test_evidence = absent`. Absence is not “no verification”.
- `overall = partial`. Verifier remains `verified_complete` via the existing resolution path. Resolution Analyzer did not create that verdict.

C01 alignment evidence exists at file-scope. Patch-intent evidence does not, because the snapshot has no patch.

### C07 — better-auth#4490

Observe: why a candidate exists but resolution evidence is insufficient.

- Candidate PR `#7256` and related commits are present. Files include `packages/better-auth/src/plugins/multi-session/index.ts` and `multi-session.test.ts`.
- `file_scope_alignment = supported` is lexical (multi-session / session identifiers). The issue is an off-by-one `listDeviceSessions` / `maximumSessions` failure. The PR is titled around preventing duplicate cookies. File-scope overlap does not close that semantic gap.
- No bounded patch. `patch_intent_alignment = unknown`.
- `test_evidence = present` because of `multi-session.test.ts`. Path presence is not a test execution result.
- `overall = partial`. Verifier remains `insufficient_evidence`. Stripping Resolution Analysis does not change the verdict.

C07 shows the intended Phase 10.0 boundary: a retrieved candidate can have file-scope and test-path signals and still lack resolution-effect proof.

### C08 — bar-lobby#291

Observe: whether merged PR + files + patch generate supporting evidence.

- Snapshot has **no pull requests** and **no file rows**. Candidates are commits (`e70118a` and siblings).
- Resolution Analyzer therefore emits a commit-path claim with `file_scope = unknown`, `patch_intent = unknown`, `test_evidence = unknown`.
- No supporting file/patch evidence was generated. There is nothing in the snapshot to analyze.
- Observed Fake Model verifier status is `insufficient_evidence`. Ground-truth expected status remains `verified_complete`. That mismatch is a verification / commit-path observation on this Fake Model trajectory, not a Resolution Analyzer completion. Invariant holds.

C08 does not demonstrate “merged PR + files + patch ⇒ support”. It demonstrates the opposite constraint: without PR file/patch evidence, the analyzer must stay `unknown`.

## Required contracts (unit)

| Contract | Result |
|---|---|
| ResolutionAnalyzer does not change verifier result | pass |
| No bounded patch ⇒ `patch_intent_alignment = unknown` | pass |
| No test file ⇒ cannot emit `test_evidence = present`; cannot infer “no verification” | pass |
| Resolution claim cannot produce `VERIFIED_COMPLETE` | pass |
| `external_untrusted` patch cannot override system instruction | pass |

Terminal-resize fixture (`terminal suggestions … after resize` + `src/vs/workbench/contrib/terminal/browser/terminal.ts`) produces `file_scope_alignment = supported` without “issue fixed”.

## Unchanged modules

Confirmed not modified in this phase:

- `src/verification/independent-completion-verifier.ts`
- `src/investigation/retrieval/ranking.ts`
- `src/investigation/retrieval/discovery.ts`
- `src/investigation/retrieval/selection.ts`
- `src/investigation/retrieval/metadata-signals.ts`
- `src/investigation/evidence-gap.ts`
- `src/investigation/recovery-planner.ts`
- `src/investigation/failure-analyzer.ts`
- `src/domain/resolution-alignment.ts` (`describeResolutionAlignment` / verifier `resolution_effect`)
- `src/domain/requirement-eval.ts`
- `fixtures/benchmark/dataset/real-v1/**`
- `fixtures/benchmark/dataset/real-v1/ground-truth.json`

## Limitations

- Deterministic Fake Model only. No live LLM sample.
- Lexical / structural signals only. No AST, no semantic bug proving.
- Real-v1 snapshots still have file metadata and almost no bounded diffs. Patch-intent cannot be measured on C01/C07/C08 until snapshots carry patches.
- File-scope `supported` can fire on domain-adjacent paths (C07 `multi-session`) and on incidental tokens from issue bodies. That is expected for Phase 10.0 and is not treated as resolution proof.
- C08 has no PR/files/patch in the snapshot, so it cannot test “merged PR + files + patch ⇒ support”.

## Conclusion

Phase 10.0 adds a code-constrained Resolution Analyzer that emits investigation claims with Evidence provenance. C01 shows file-scope alignment when a PR’s changed files match the issue domain. C07 shows why a candidate can exist and still lack resolution evidence: file/test signals are not completion. C08 shows that missing file/patch evidence keeps signals `unknown`.

Independent Completion Verifier remains the only completion authority.
