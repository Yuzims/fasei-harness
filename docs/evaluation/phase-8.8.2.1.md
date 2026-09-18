# Phase 8.8.2.1 — Strategy Evaluation Results

## Evaluation Scope

This run executed the existing Phase 8.8.2 evaluation functions against the current codebase at `973ef092920318dd7ee34c86c656a33977d863f6`.

Evaluated:

- 8 synthetic cases via `evaluateAllSyntheticCases()`
- Real-v1 `C01`–`C10` via `evaluateRealV1Cases()`

Each case was run twice with the same Fake Model policy and the same snapshot provider:

| Arm | `investigationActionConstraint` |
|---|---|
| baseline | `unconstrained` |
| strategy | `evidence_gap` |

Ground truth / `expectedOutcome` was used only by the evaluator after the run. Real-v1 agent input was built from `convertCaseToScenario()` plus `createInvestigationTask()`. The evaluator rejects a real case if `expectedOutcome` is present on the scenario object.

No Verifier, GitHub Provider, Recovery Planner, Evidence-Gap Strategy, Candidate Actions, Benchmark Dataset, Real-v1 snapshot, or `ground-truth.json` files were modified for this run.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-18 |
| HEAD | `973ef092920318dd7ee34c86c656a33977d863f6` |
| Evaluation version | `8.8.2` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 375 passed, 0 failed |
| Build command | `npm run build` — passed |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |
| `GITHUB_TOKEN` | unset |
| `OPENAI_API_KEY` | unset |
| `DASHSCOPE_API_KEY` | unset |
| Live keys present during evaluation | none |

`estimatedInputTokens` is a local heuristic (`message chars / 4`). It is not a provider token count.

## Baseline Definition

Baseline is NOT a historical replay of the pre-8.8 agent.

It is a controlled approximation using the same deterministic Fake Model policy, with `investigationActionConstraint` disabled.

Code note (`STRATEGY_EVALUATION_BASELINE_NOTE`):

> Baseline is an approximation of pre-8.8 tool-selection behavior. It reuses the observation-based SnapshotInvestigationDriver policy with the Evidence-Gap legal-action constraint disabled. It is not a strict historical replay of a live LLM trajectory.

The experiment variable is constraint presence, not a second chooser and not a live LLM.

Under the current deterministic evaluation policy, enabling the Evidence-Gap investigation constraint produced the differences below. This is not a claim that Evidence-Gap Strategy beats the old Agent.

## Synthetic Results

Synthetic fixtures: `resolved` except `no_legal_action` (`insufficient-evidence`). Expected statuses come from the synthetic case configs, not from Real-v1 ground truth.

`missing_resolution_evidence` and `issue_already_satisfied` currently share the same fixture, expected status, and `prepareState`. Their identical metrics are a property of the current case configs.

### Synthetic status table

| Case | Expected status | Baseline status | Strategy status |
|---|---|---|---|
| missing_resolution_evidence | verified_complete | verified_complete | verified_complete |
| issue_already_satisfied | verified_complete | verified_complete | verified_complete |
| missing_commit_evidence | verified_complete | verified_complete | verified_complete |
| missing_code_evidence | verified_complete | verified_complete | verified_complete |
| resolution_effect_gap | insufficient_evidence | insufficient_evidence | insufficient_evidence |
| recovery | verified_complete | verified_complete | verified_complete |
| tight_budget | verified_complete | verified_complete | verified_complete |
| no_legal_action | insufficient_evidence | insufficient_evidence | insufficient_evidence |

Verifier status matched expected on all 8 synthetic cases for both arms.

### missing_resolution_evidence

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 6 | 5 | -1 |
| toolCalls | 5 | 5 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 2 | 2 | 0 |
| estimatedInputTokens | 8067 | 9027 | 960 |
| estimatedMessageChars | 32260 | 36099 | 3839 |
| estimatedToolResultChars | 8615 | 5881 | -2734 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### issue_already_satisfied

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 6 | 5 | -1 |
| toolCalls | 5 | 5 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 2 | 2 | 0 |
| estimatedInputTokens | 8067 | 9027 | 960 |
| estimatedMessageChars | 32260 | 36099 | 3839 |
| estimatedToolResultChars | 8615 | 5881 | -2734 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### missing_commit_evidence

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 4 | 3 | -1 |
| toolCalls | 3 | 3 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 1 | 1 | 0 |
| estimatedInputTokens | 4289 | 4067 | -222 |
| estimatedMessageChars | 17148 | 16265 | -883 |
| estimatedToolResultChars | 3114 | 1615 | -1499 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### missing_code_evidence

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 4 | 3 | -1 |
| toolCalls | 3 | 3 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 1 | 1 | 0 |
| estimatedInputTokens | 4289 | 4067 | -222 |
| estimatedMessageChars | 17148 | 16265 | -883 |
| estimatedToolResultChars | 3114 | 1615 | -1499 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### resolution_effect_gap

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 7 | 3 | -4 |
| toolCalls | 4 | 3 | -1 |
| duplicateInvestigationActions | 2 | 2 | 0 |
| exactDuplicateActions | 2 | 2 | 0 |
| repeatedToolCalls | 2 | 2 | 0 |
| unnecessaryInvestigationActions | 4 | 3 | -1 |
| exploratoryActions | 0 | 0 | 0 |
| estimatedInputTokens | 9714 | 4291 | -5423 |
| estimatedMessageChars | 38847 | 17159 | -21688 |
| estimatedToolResultChars | 2271 | 0 | -2271 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 1 | 1 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 3 | 3 | 0 |
| recoveryEvents | 2 | 2 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `record_claim`, `github_get_issue_comments`, `record_claim`, `record_claim`

strategy toolSequence: `record_claim`, `record_claim`, `record_claim`

missingRequirements (both): `resolution-effect`

missingConditions (both): `resolution_effect`

Observed failure modes:

- baseline: `missing_candidate_mapping`, `unnecessary_exploration`, `duplicate_action`
- strategy: `strategy_exhaustion`, `over_constraint`, `missing_candidate_mapping`, `unnecessary_exploration`, `duplicate_action`

### recovery

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 10 | 9 | -1 |
| toolCalls | 8 | 8 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 2 | 2 | 0 |
| exploratoryActions | 3 | 3 | 0 |
| estimatedInputTokens | 13247 | 17273 | 4026 |
| estimatedMessageChars | 52969 | 69079 | 16110 |
| estimatedToolResultChars | 12912 | 9689 | -3223 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 2 | 2 | 0 |
| recoveryEvents | 1 | 1 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `record_claim`, `github_get_issue_comments`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### tight_budget

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 6 | 2 | -4 |
| toolCalls | 5 | 2 | -3 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 3 | 0 | -3 |
| exploratoryActions | 0 | 0 | 0 |
| estimatedInputTokens | 8074 | 2517 | -5557 |
| estimatedMessageChars | 32288 | 10063 | -22225 |
| estimatedToolResultChars | 8615 | 674 | -7941 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_pull_request`, `github_get_pull_request_files`

missingRequirements / missingConditions: none / none

The strategy arm did not call `record_claim`. Independent verification still returned `verified_complete` with coverage 1 on the seeded plus fetched evidence.

### no_legal_action

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 6 | 5 | -1 |
| toolCalls | 5 | 5 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 3 | 3 | 0 |
| estimatedInputTokens | 5805 | 7853 | 2048 |
| estimatedMessageChars | 23213 | 31409 | 8196 |
| estimatedToolResultChars | 7329 | 5055 | -2274 |
| evidenceCoverage | 0.3333333333333333 | 0.3333333333333333 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_issue_comments`, `github_list_commits`, `record_claim`

missingRequirements (both): `req-pr`, `pr-merged`, `req-commit`, `resolution-effect`

missingConditions (both): `resolution_candidate`, `resolution_merged`, `resolution_code_evidence`, `resolution_effect`

## Real-v1 Results

Real-v1 used recorded snapshots only. Ground truth was loaded by the evaluator after each run via `expectedOutcomeForDatasetCase()`.

### C01–C10 status table

| Case | Expected status | Baseline status | Strategy status |
|---|---|---|---|
| C01 | verified_complete | verified_complete | insufficient_evidence |
| C02 | verified_complete | verified_complete | verified_complete |
| C03 | verified_complete | verified_complete | verified_complete |
| C04 | verified_complete | verified_complete | verified_complete |
| C05 | not_verified | not_verified | not_verified |
| C06 | not_verified | not_verified | not_verified |
| C07 | not_verified | insufficient_evidence | insufficient_evidence |
| C08 | verified_complete | verified_complete | verified_complete |
| C09 | verified_complete | verified_complete | verified_complete |
| C10 | not_verified | insufficient_evidence | insufficient_evidence |

C01 is the only Real-v1 case where the two arms disagreed on verifier status. C07 and C10 differ from ground-truth expected status on both arms (`insufficient_evidence` vs expected `not_verified`). That mismatch is not a verifier false positive under the current definition (`observed === verified_complete && expected !== verified_complete`).

### C01

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 9 | 11 | 2 |
| toolCalls | 8 | 11 | 3 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 2 | 1 | -1 |
| exploratoryActions | 2 | 1 | -1 |
| estimatedInputTokens | 18301 | 33669 | 15368 |
| estimatedMessageChars | 73188 | 134663 | 61475 |
| estimatedToolResultChars | 25680 | 32784 | 7104 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 1 | 1 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

strategy missingRequirements: `resolution-effect`

strategy missingConditions: `resolution_effect`

### C02

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 7 | 6 | -1 |
| toolCalls | 6 | 6 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 2 | 2 | 0 |
| estimatedInputTokens | 13684 | 13849 | 165 |
| estimatedMessageChars | 54723 | 55386 | 663 |
| estimatedToolResultChars | 16401 | 11647 | -4754 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### C03

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 11 | 10 | -1 |
| toolCalls | 10 | 10 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 3 | 1 | -2 |
| exploratoryActions | 4 | 3 | -1 |
| estimatedInputTokens | 162503 | 125053 | -37450 |
| estimatedMessageChars | 649993 | 500199 | -149794 |
| estimatedToolResultChars | 144650 | 127309 | -17341 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request_files`, `github_get_pull_request_files`, `github_list_commits`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### C04

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 7 | 6 | -1 |
| toolCalls | 6 | 6 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 2 | 2 | 0 |
| estimatedInputTokens | 12475 | 13274 | 799 |
| estimatedMessageChars | 49892 | 53088 | 3196 |
| estimatedToolResultChars | 15243 | 10959 | -4284 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### C05

Expected: `not_verified`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 7 | 8 | 1 |
| toolCalls | 6 | 8 | 2 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 3 | 3 | 0 |
| estimatedInputTokens | 8113 | 17525 | 9412 |
| estimatedMessageChars | 32439 | 70087 | 37648 |
| estimatedToolResultChars | 11747 | 14813 | 3066 |
| evidenceCoverage | 0.3333333333333333 | 0.3333333333333333 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`, `github_get_pull_request_files`, `github_list_commits`

missingRequirements (both): `closure-semantics`, `req-pr`, `pr-merged`, `req-commit`, `resolution-effect`

missingConditions (both): `eligible_closure`, `resolution_candidate`, `resolution_merged`, `resolution_code_evidence`, `resolution_effect`

### C06

Expected: `not_verified`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 8 | 11 | 3 |
| toolCalls | 7 | 11 | 4 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 3 | 3 | 0 |
| estimatedInputTokens | 9163 | 27271 | 18108 |
| estimatedMessageChars | 36639 | 109066 | 72427 |
| estimatedToolResultChars | 12109 | 21196 | 9087 |
| evidenceCoverage | 0.3333333333333333 | 0.3333333333333333 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

baseline toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`

missingRequirements (both): `closure-semantics`, `req-pr`, `pr-merged`, `req-commit`, `resolution-effect`

missingConditions (both): `eligible_closure`, `resolution_candidate`, `resolution_merged`, `resolution_code_evidence`, `resolution_effect`

### C07

Expected: `not_verified`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 9 | 8 | -1 |
| toolCalls | 8 | 8 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 1 | 1 | 0 |
| estimatedInputTokens | 18493 | 21596 | 3103 |
| estimatedMessageChars | 73956 | 86373 | 12417 |
| estimatedToolResultChars | 22494 | 16797 | -5697 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 1 | 1 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements (both): `resolution-effect`

missingConditions (both): `resolution_effect`

### C08

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 9 | 12 | 3 |
| toolCalls | 8 | 12 | 4 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 3 | 7 | 4 |
| estimatedInputTokens | 12572 | 37179 | 24607 |
| estimatedMessageChars | 50275 | 148701 | 98426 |
| estimatedToolResultChars | 15701 | 27089 | 11388 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | true | — |
| strategyExhausted | false | false | — |
| agentDecision | final | (absent) | — |

baseline toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`

strategy toolSequence: `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_issue_comments`, `github_list_commits`, `record_claim`, `github_get_pull_request_files`, `github_list_commits`, `github_get_pull_request_files`, `github_list_commits`

missingRequirements / missingConditions: none / none

C08 strategy is the only evaluated case with `budgetExhaustion = true`. Verifier status remained `verified_complete`.

### C09

Expected: `verified_complete`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 9 | 8 | -1 |
| toolCalls | 8 | 8 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 2 | 2 | 0 |
| estimatedInputTokens | 16481 | 20949 | 4468 |
| estimatedMessageChars | 65911 | 83784 | 17873 |
| estimatedToolResultChars | 19702 | 14822 | -4880 |
| evidenceCoverage | 1 | 1 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request`, `github_get_pull_request_files`, `github_list_commits`, `record_claim`

missingRequirements / missingConditions: none / none

### C10

Expected: `not_verified`

| Metric | Baseline | Strategy | Difference (strategy − baseline) |
|---|---:|---:|---:|
| llmCalls | 6 | 5 | -1 |
| toolCalls | 5 | 5 | 0 |
| duplicateInvestigationActions | 0 | 0 | 0 |
| exactDuplicateActions | 0 | 0 | 0 |
| repeatedToolCalls | 0 | 0 | 0 |
| unnecessaryInvestigationActions | 1 | 1 | 0 |
| exploratoryActions | 3 | 3 | 0 |
| estimatedInputTokens | 6313 | 8293 | 1980 |
| estimatedMessageChars | 25240 | 33165 | 7925 |
| estimatedToolResultChars | 8279 | 5782 | -2497 |
| evidenceCoverage | 0.3333333333333333 | 0.3333333333333333 | 0 |
| unsupportedClaimRate | 0 | 0 | 0 |
| falseCompletionRate | 0 | 0 | 0 |
| verifierFalsePositiveRate | 0 | 0 | 0 |
| attempts | 1 | 1 | 0 |
| recoveryEvents | 0 | 0 | 0 |
| budgetExhaustion | false | false | — |
| strategyExhausted | false | true | — |
| agentDecision | final | strategy_exhausted | — |

toolSequence (both): `github_get_issue`, `github_get_issue_timeline`, `github_get_issue_comments`, `github_list_commits`, `record_claim`

missingRequirements (both): `req-pr`, `pr-merged`, `req-commit`, `resolution-effect`

missingConditions (both): `resolution_candidate`, `resolution_merged`, `resolution_code_evidence`, `resolution_effect`

## Aggregate Metrics

Counts below treat a numeric difference as:

- lower: `strategy − baseline < 0`
- equal: `strategy − baseline === 0`
- higher: `strategy − baseline > 0`

“Lower” on cost/waste metrics is a numeric fact, not an overall quality judgment.

### Totals

| Suite | Cases |
|---|---:|
| Synthetic | 8 |
| Real-v1 | 10 |
| Combined | 18 |

### Cost / waste metric case counts

#### Combined (18)

| Metric | strategy lower | equal | strategy higher |
|---|---:|---:|---:|
| llmCalls | 14 | 0 | 4 |
| toolCalls | 2 | 12 | 4 |
| duplicateInvestigationActions | 0 | 18 | 0 |
| exactDuplicateActions | 0 | 18 | 0 |
| repeatedToolCalls | 0 | 18 | 0 |
| unnecessaryInvestigationActions | 4 | 14 | 0 |
| exploratoryActions | 2 | 15 | 1 |
| estimatedInputTokens | 5 | 0 | 13 |
| estimatedMessageChars | 5 | 0 | 13 |
| estimatedToolResultChars | 14 | 0 | 4 |
| evidenceCoverage | 0 | 18 | 0 |
| unsupportedClaimRate | 0 | 18 | 0 |
| falseCompletionRate | 0 | 17 | 1 |
| verifierFalsePositiveRate | 0 | 18 | 0 |
| attempts | 0 | 18 | 0 |
| recoveryEvents | 0 | 18 | 0 |

strategy lower llmCalls cases: all 8 synthetic; Real-v1 C02, C03, C04, C07, C09, C10.

strategy higher llmCalls cases: Real-v1 C01, C05, C06, C08.

strategy lower toolCalls cases: synthetic `resolution_effect_gap`, `tight_budget`.

strategy higher toolCalls cases: Real-v1 C01, C05, C06, C08.

strategy lower unnecessaryInvestigationActions cases: synthetic `resolution_effect_gap`, `tight_budget`; Real-v1 C01, C03.

strategy lower estimatedInputTokens cases: synthetic `missing_commit_evidence`, `missing_code_evidence`, `resolution_effect_gap`, `tight_budget`; Real-v1 C03.

strategy higher estimatedInputTokens cases: synthetic `missing_resolution_evidence`, `issue_already_satisfied`, `recovery`, `no_legal_action`; Real-v1 C01, C02, C04, C05, C06, C07, C08, C09, C10.

strategy higher falseCompletionRate: Real-v1 C01 only (0 → 1).

#### Synthetic (8)

| Metric | strategy lower | equal | strategy higher |
|---|---:|---:|---:|
| llmCalls | 8 | 0 | 0 |
| toolCalls | 2 | 6 | 0 |
| duplicateInvestigationActions | 0 | 8 | 0 |
| unnecessaryInvestigationActions | 2 | 6 | 0 |
| estimatedInputTokens | 4 | 0 | 4 |

#### Real-v1 (10)

| Metric | strategy lower | equal | strategy higher |
|---|---:|---:|---:|
| llmCalls | 6 | 0 | 4 |
| toolCalls | 0 | 6 | 4 |
| duplicateInvestigationActions | 0 | 10 | 0 |
| unnecessaryInvestigationActions | 2 | 8 | 0 |
| estimatedInputTokens | 1 | 0 | 9 |

### Means

| Suite | Metric | Baseline | Strategy |
|---|---|---:|---:|
| Synthetic | mean llmCalls | 6.125 | 4.375 |
| Synthetic | mean toolCalls | 4.75 | 4.25 |
| Synthetic | mean estimatedInputTokens | 7694 | 7265.25 |
| Synthetic | mean evidenceCoverage | 0.9166666666666666 | 0.9166666666666666 |
| Real-v1 | mean llmCalls | 8.2 | 8.5 |
| Real-v1 | mean toolCalls | 7.2 | 8.5 |
| Real-v1 | mean estimatedInputTokens | 27809.8 | 31865.8 |
| Real-v1 | mean evidenceCoverage | 0.8 | 0.8 |
| Combined | mean evidenceCoverage | 0.8518518518518519 | 0.8518518518518519 |

### Outcome rates

| Metric | Synthetic baseline | Synthetic strategy | Real-v1 baseline | Real-v1 strategy | Combined baseline | Combined strategy |
|---|---:|---:|---:|---:|---:|---:|
| falseCompletion cases | 1/8 | 1/8 | 1/10 | 2/10 | 2/18 | 3/18 |
| verifierFalsePositive cases | 0/8 | 0/8 | 0/10 | 0/10 | 0/18 | 0/18 |
| budgetExhaustion cases | 0/8 | 0/8 | 0/10 | 1/10 | 0/18 | 1/18 |
| strategyExhausted cases | 0/8 | 8/8 | 0/10 | 9/10 | 0/18 | 17/18 |
| unsupportedClaimRate (all cases) | 0 | 0 | 0 | 0 | 0 | 0 |

falseCompletion cases:

- synthetic both arms: `resolution_effect_gap`
- Real-v1 baseline: C07
- Real-v1 strategy: C01, C07

budgetExhaustion: Real-v1 C08 strategy only.

strategyExhausted: every strategy run except Real-v1 C08.

Verifier status agreement between arms:

- synthetic: 8/8 identical
- Real-v1: 9/10 identical; C01 differed (`verified_complete` → `insufficient_evidence`)

## Metric Differences

Under the current deterministic evaluation policy, enabling the Evidence-Gap investigation constraint produced the following differences.

Decreased in some cases:

- `llmCalls` decreased in 14/18 cases; increased in 4/18 (all Real-v1: C01, C05, C06, C08).
- `toolCalls` decreased in 2/18 synthetic cases; increased in 4/18 Real-v1 cases; unchanged in 12/18.
- `unnecessaryInvestigationActions` decreased in 4/18 cases; never increased.
- `duplicateInvestigationActions` / `exactDuplicateActions` / `repeatedToolCalls` were unchanged on every case.
- `estimatedInputTokens` decreased in 5/18 cases and increased in 13/18.
- `estimatedToolResultChars` decreased in 14/18 cases and increased in 4/18.

Unchanged on every case:

- `evidenceCoverage`
- `unsupportedClaimRate`
- `verifierFalsePositiveRate`
- `attempts`
- `recoveryEvents`

Increased / degraded on specific recorded metrics:

- Real-v1 C01: verifier status `verified_complete` → `insufficient_evidence`; `falseCompletionRate` 0 → 1; `llmCalls`, `toolCalls`, and `estimatedInputTokens` increased.
- Real-v1 C08: `budgetExhaustion` false → true; `exploratoryActions` 3 → 7; `llmCalls`, `toolCalls`, and `estimatedInputTokens` increased. Verifier status stayed `verified_complete`.
- Real-v1 C05 and C06: `llmCalls`, `toolCalls`, and `estimatedInputTokens` increased; verifier status stayed `not_verified`.
- Strategy arm ended `strategy_exhausted` in 17/18 cases (baseline: 0/18). That terminal is not an Agent `final`; the verifier still ran.

No overall win/loss is assigned from these mixed metric movements.

## Observations

1. Synthetic verifier outcomes were identical across arms and matched the synthetic expected statuses.
2. Real-v1 C01 is the only case where enabling the constraint changed verifier status. Baseline matched ground truth (`verified_complete`); strategy returned `insufficient_evidence` with `resolution_effect` still missing and a false completion.
3. Real-v1 C07 and C10 both returned `insufficient_evidence` on both arms while ground truth expects `not_verified`. The constraint did not change that mismatch.
4. On several Real-v1 unresolved cases (C05, C06, C08), the strategy arm continued after `record_claim` with extra `github_get_pull_request_files` / `github_list_commits` calls. That increased tool and token counts.
5. Synthetic `tight_budget` is the largest cost reduction: llmCalls 6 → 2, toolCalls 5 → 2, unnecessary actions 3 → 0, estimated input tokens 8074 → 2517, with the same `verified_complete` status.
6. Synthetic `resolution_effect_gap` reduced llmCalls 7 → 3 and dropped the extra `github_get_issue_comments` call. Duplicate `record_claim` actions remained (2 on both arms). Both arms still had false completion with `insufficient_evidence`.
7. `strategy_exhausted` on the strategy arm is common even when verification status matches baseline. llmCalls often differ by exactly −1 on those cases (one fewer decide after the last tool), while message-char estimates often increase because legal-action context is present.
8. `missing_resolution_evidence` and `issue_already_satisfied` are duplicate configs in the current synthetic suite; they cannot distinguish those two intended situations.

## Limitations

- Baseline is a controlled approximation, not a historical replay of the pre-8.8 agent.
- The Fake Model is a deterministic observation-based policy, not a real LLM.
- Constraint presence is the only experiment variable. Both arms share the same chooser.
- Token figures are local character heuristics, not provider tokens.
- Snapshots replace live GitHub. No network GitHub or model APIs were used.
- Ground truth is evaluator-only. This run does not measure a live unconstrained LLM agent.
- Two synthetic cases are currently identical, which inflates synthetic sample size without adding a distinct trajectory.
- Real-v1 has 10 cases. Mixed cost movements on that set are not a general ranking.
- This experiment does not establish a generalization advantage under a real LLM-based unconstrained agent.

## Conclusion

The evaluation infrastructure executed successfully.

Under the current deterministic evaluation policy, enabling the Evidence-Gap investigation constraint:

- reduced `llmCalls` in 14/18 cases, and increased them in 4/18
- reduced `toolCalls` in 2/18 cases, left them equal in 12/18, and increased them in 4/18
- reduced unnecessary investigation actions in 4/18 cases and never increased them
- left duplicate actions equal in 18/18 cases
- reduced estimated input tokens in 5/18 cases and increased them in 13/18
- left evidence coverage equal in 18/18 cases (synthetic mean 0.9167, Real-v1 mean 0.8)
- left false completion equal on synthetic (1/8) and increased it on Real-v1 (1/10 → 2/10)
- left verifier false positives at 0/18
- increased budget exhaustion from 0/18 to 1/18 (C08)
- increased strategy exhaustion from 0/18 to 17/18

Verifier status changed on 1/18 cases (Real-v1 C01: `verified_complete` → `insufficient_evidence`).

This experiment does not establish general superiority over a real LLM-based unconstrained agent.
