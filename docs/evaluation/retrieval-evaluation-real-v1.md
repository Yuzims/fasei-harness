# Phase 8.x — Retrieval Evaluation Results

Measurement infrastructure is frozen at `e57fceb` (`fix: correct retrieval evaluation measurements`). This document reports a run of that evaluator. It does not change Ground Truth, verifier behavior, Recovery Planner, Evidence-Gap Strategy, ranking, or discovery.

Evaluated:

- Synthetic cases `SRE01`–`SRE07` via `evaluateAllSyntheticRetrievalCases()`
- Real-v1 `C01`–`C10` via `evaluateRealV1RetrievalCases()`

Each case was run twice with the same Investigation Agent, the same deterministic Fake Model (`createStrategyEvaluationModel` / `nextInvestigationAction`), the same snapshot provider, and the same candidate investigation budget (`MAX_INVESTIGATED_CANDIDATES = 5` per source type).

| Arm | Code id | What actually differs |
|---|---|---|
| Controlled baseline | `baseline` | Same agent, Fake Model, snapshot, discovery, and budget. Selection is **discovery-order bounded selection** (`applyDiscoveryOrderSelection`). |
| Evidence-driven retrieval | `evidence_driven` | Same everything except selection: **Evidence-driven Candidate Ranking + Top-K** (`applyCandidateSelection` / `rankCandidates`). Ranking score = issue-reference + structural + lexical + temporal. Ranking score is investigation order only, not a probability of resolution. |

The baseline is a **controlled baseline**, not a historical production system and not a “free LLM baseline”. No live LLM was called.

Evidence-Gap Strategy (legal-action constraint) is **not** the experiment variable. Both arms run it. Do not read this as “Evidence-Gap Strategy vs unconstrained tools”.

Ground truth / `expectedOutcome` was used only by the evaluator after the run. Real-v1 agent input was built from `convertCaseToScenario()` plus `createInvestigationTask()`. The evaluator rejects a real case if `expectedOutcome` is present on the scenario object.

## Executive Summary

This run measured whether Evidence-driven Candidate Ranking / Top-K improves **resolution-candidate retrieval** versus discovery-order selection, and what tool / LLM / token / runtime cost that comparison required.

**It did not improve retrieval on this evaluation.**

- Synthetic: discovery is identical (5/6). Recall@1 / Recall@3 / Recall@5 and investigation-success are **lower** under ranking, driven by `SRE04` (GT not rank-1) and `SRE06` (GT ranked out of Top-K).
- Real-v1: discovery is identical (7/7 resolution-expected cases). Recall@1 and Recall@3 are identical. Recall@5 is **worse** under ranking (`C08` only). Investigation-success is 7/7 on both arms.
- Cost is unchanged on Real-v1. On synthetic, ranking costs more only on `SRE06` (more tool/LLM calls while investigating distractors).

Discovery of a candidate is not task success. Investigation is not verification. `promoted` is not `investigated`.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-19 |
| HEAD | `e57fcebdcfcab024044a28a5afb18f9738d6924b` |
| Evaluation version | `8.9.x` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |
| Live keys present | none |

`inputTokens` is a local heuristic (`message chars / 4`), flagged `inputTokensEstimated = true`. Provider token fields are unavailable (`providerTokensUnavailable = true`). `outputTokens` is `null` on every case. `toolCalls` comes from AgentLoop `tool_call` events (`report.toolCallCount`), not `investigationSteps.length`. `runtimeMs` is wall-clock `Date.now()` around the Fake Model run.

## Baseline Definition

Code note (`RETRIEVAL_EVALUATION_BASELINE_NOTE`):

> baseline is a controlled baseline: the same Investigation Agent, Fake Model policy, snapshot, discovery source, and candidate investigation budget (`MAX_INVESTIGATED_CANDIDATES`) run with discovery-order bounded selection instead of Evidence-driven Candidate Ranking / Top-K. It is not a historical replay of a previous harness version or a live production retrieval system. controlled baseline ≠ historical production system.

## Metric and schema notes

The evaluator diagnoses first-funnel failure as:

| Evaluator `diagnosis` | Report label used here |
|---|---|
| `discovery_failure` | `DISCOVERY_FAILURE` |
| `ranked_out_of_top_k` | `RANKING_FAILURE` |
| `investigation_failed` | `INVESTIGATION_FAILURE` |
| `evidence_insufficient` | `EVIDENCE_INSUFFICIENCY` |
| `retrieval_complete` | no retrieval-funnel failure labeled |
| `no_resolution_expected` | not a retrieval failure (`C05`/`C06`/`C10`/`SRE05`) |

**`VERIFICATION_FAILURE` is not an evaluator diagnosis.** `diagnoseRetrieval()` never emits it. If investigation succeeds and verification is `not_verified` (rather than `insufficient_evidence`), the diagnosis is `retrieval_complete`. This report does not invent a `VERIFICATION_FAILURE` metric. Observed verifier status is reported separately, and `verifierFalsePositive` is the existing field (`verified_complete` when expected is not). It is `false` on every case in this run.

**`selectedCandidateCount` is not a first-class schema field.** The table uses `topK.length`, which is the runtime selection (`report.selectedCandidates`). In this runtime, selection **is** entering the investigation budget (`status` `investigating` or `promoted`), so `selectedCandidateCount` equals `investigatedCandidateCount` on every case below. There is no recorded “selected but not yet investigated” state.

**Promoted ≠ investigated.** `investigationSuccess` is true when the expected candidate has status `investigating` **or** `promoted`. Several cases investigate a GT candidate that is never promoted.

**Top-K vs per-type budget.** Selection budget is `MAX_INVESTIGATED_CANDIDATES = 5` **per source type** (PR group and commit group separately). `topKFound` / Recall@K slice the **combined** selected list. `C08` evidence-driven is `RANKING_FAILURE` on Recall@5 even though the expected commit still has status `investigating` (commit-group budget). That limitation is reported, not papered over.

**`totalTokens` is not in the evaluation schema.** Only estimated `inputTokens` and null `outputTokens` exist. This report does not add them into a fake total.

Recall@K / Precision@K are `null` when no resolution candidate is expected. Aggregates average only resolution-expected cases (`resolutionExpectedCases`). Synthetic: 6 expected + 1 none. Real-v1: 7 expected + 3 none.

---

## Synthetic Results

Fixtures are constructed snapshots (`acme/box#42`) with evaluator-only retrieval ground truth.

| Case | Setup |
|---|---|
| SRE01 | Strong PR `#7` (`Fixes #42`) |
| SRE02 | Direct commit (no PR) |
| SRE03 | Two valid PRs `#7` and `#8` |
| SRE04 | Valid `#7` plus three docs-only noise PRs that also say `Fixes #42` |
| SRE05 | Closed `not_planned`; no resolution candidate expected |
| SRE06 | Valid `#99` (“True fix”) plus five distractors with `Fixes #42`; ranking-stress |
| SRE07 | Expected commit is absent from the discovery window |

### Synthetic aggregate (resolution-expected cases)

| Metric | Controlled baseline | Evidence-driven ranking |
|---|---|---|
| Candidate Discovery Rate | 0.833 (5/6) | 0.833 (5/6) |
| Recall@1 | 0.833 | 0.500 |
| Recall@3 | 0.833 | 0.500 |
| Recall@5 | 0.833 | 0.667 |
| Precision@1 | 0.833 | 0.500 |
| Precision@3 | 0.611 | 0.500 |
| Precision@5 | 0.575 | 0.542 |
| Investigation success rate | 0.833 | 0.667 |
| False completion rate | 0 | 0 |
| Verification invariant rate | 1 | 1 |

`SRE07` is `DISCOVERY_FAILURE` on both arms. Ranking cannot recover a candidate that was never discovered.

### Synthetic per-case (B = baseline, E = evidence-driven)

| Case | Disc. B/E | Top-K B/E | R@1 B/E | R@3 B/E | R@5 B/E | P@1 B/E | P@3 B/E | P@5 B/E | Diagnosis B/E | Verifier B/E |
|---|---|---|---|---|---|---|---|---|---|---|
| SRE01 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | retrieval_complete / retrieval_complete | verified_complete |
| SRE02 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | retrieval_complete / retrieval_complete | verified_complete |
| SRE03 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | retrieval_complete / retrieval_complete | verified_complete |
| SRE04 | Y/Y | Y/Y | 1/0 | 1/0 | 1/1 | 1/0 | 0.333/0 | 0.250/0.250 | retrieval_complete / retrieval_complete | verified_complete |
| SRE05 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | no_resolution_expected | not_verified |
| SRE06 | Y/Y | Y/N | 1/0 | 1/0 | 1/0 | 1/0 | 0.333/0 | 0.200/0 | evidence_insufficient / ranked_out_of_top_k | insufficient_evidence |
| SRE07 | N/N | N/N | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | discovery_failure / discovery_failure | insufficient_evidence |

`SRE04`: both arms discover and investigate `#7` (4 candidates, all in budget). Ranking ties on lexical score and sorts by `sourceId`, so noise `#21/#22/#23` precede `#7`. Recall@1/@3 fall; Recall@5 stays 1. Verifier still `verified_complete`. Ranking changed order, not discovery, and not the final verifier status.

`SRE06`: both arms discover `#99`. Baseline keeps discovery order, so `#99` is in Top-K and investigated (`promoted`). Evidence-driven ranking gives every PR the same lexical score and sorts `#101`–`#105` ahead of `#99`; `#99` is `rejected` (`RANKING_FAILURE`). Baseline still ends `insufficient_evidence` (`EVIDENCE_INSUFFICIENCY`) after investigating `#99` (PR body is `patch`, not a closing keyword). Ranking moved the GT out of Top-K; it did not create a verified resolution on either arm.

---

## Real-v1 Results

Real-v1 snapshots + Fake Model only. Retrieval ground truth is `REAL_V1_RETRIEVAL_GROUND_TRUTH` (evaluator-only). `C05`, `C06`, `C10` have `expectedResolution: none` and are excluded from discovery / Recall / Precision aggregates.

### Real-v1 aggregate (7 resolution-expected cases)

| Metric | Controlled baseline | Evidence-driven ranking |
|---|---|---|
| Candidate Discovery Rate | 1.000 (7/7) | 1.000 (7/7) |
| Recall@1 | 0.286 (2/7) | 0.286 (2/7) |
| Recall@3 | 0.857 (6/7) | 0.857 (6/7) |
| Recall@5 | 1.000 (7/7) | 0.857 (6/7) |
| Precision@1 | 0.286 | 0.286 |
| Precision@3 | 0.476 | 0.476 |
| Precision@5 | 0.505 | 0.476 |
| Investigation success rate | 1.000 (7/7) | 1.000 (7/7) |
| False completion rate | 0 | 0 |
| Verification invariant rate | 1 | 1 |

Recall@1 is 1 only for `C02` and `C04` (single discovered PR, which is the GT). On `C01`/`C03`/`C07`/`C08`/`C09` the expected candidate is not first in the combined selected list on **either** arm.

The only aggregate retrieval regression under ranking is Real-v1 Recall@5 / Precision@5, caused entirely by `C08`.

### Real-v1 case table

B = controlled baseline, E = evidence-driven. Tokens are estimated input tokens. `outputTokens` is null. Runtime is measured wall-clock ms (Fake Model; see Cost).

| Case | Expected candidate | Disc. B/E | Top-K B/E | Investigated B/E | Evidence sufficient B/E | Verifier B/E | Cand. | Inv. | Tools | LLM | Est. input tokens | Runtime ms | First failure stage (E, then B if different) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 | PR `284149` | Y/Y | Y/Y | Y/Y | Y/Y | verified_complete | 3 | 3 | 6 | 6 | 15282 | 4 / 3 | none (`retrieval_complete`; Recall@1 is 0 on both) |
| C02 | PR `14527` | Y/Y | Y/Y | Y/Y | Y/Y | verified_complete | 1 | 1 | 4 | 4 | 7608 | 3 / 2 | none |
| C03 | PR `14022` | Y/Y | Y/Y | Y/Y | Y/Y | verified_complete | 3 | 3 | 5 | 5 | 12120 | 4 / 5 | none (`retrieval_complete`; Recall@1 is 0 on both) |
| C04 | PR `14504` | Y/Y | Y/Y | Y/Y | Y/Y | verified_complete | 1 | 1 | 4 | 4 | 7650 | 2 / 3 | none |
| C05 | none | n/a | n/a | n/a | n/a | not_verified | 1 | 1 | 1 | 1 | 1398 | 2 / 0 | none (`no_resolution_expected`; closed not_planned) |
| C06 | none | n/a | n/a | n/a | n/a | not_verified | 0 | 0 | 1 | 1 | 1396 | 1 / 1 | none (`no_resolution_expected`; closed not_planned) |
| C07 | PR `7256` | Y/Y | Y/Y | Y/Y | N/N | insufficient_evidence | 3 | 3 | 7 | 7 | 17068 | 4 / 2 | `EVIDENCE_INSUFFICIENCY` (candidate was retrieved) |
| C08 | commit `e70118a2a11aa239472336f6a961784f04c63c9d` | Y/Y | Y/N | Y/Y | N/N | insufficient_evidence | 6 | 6 | 8 | 8 | 18426 | 4 / 3 | E: `RANKING_FAILURE` (Recall@5); B: `EVIDENCE_INSUFFICIENCY`. GT commit still investigated on E |
| C09 | PR `279` | Y/Y | Y/Y | Y/Y | Y/Y | verified_complete | 3 | 3 | 6 | 6 | 13416 | 3 / 3 | none (`retrieval_complete`; Recall@1 is 0 on both) |
| C10 | none | n/a | n/a | n/a | n/a | insufficient_evidence | 0 | 0 | 4 | 4 | 6745 | 1 / 1 | none as retrieval (`no_resolution_expected`) |

“Evidence sufficient” here means Independent Completion Verifier status `verified_complete`, not `evidenceCoverage`. `C07` and `C08` have `evidenceCoverage = 1` and still `insufficient_evidence`.

Candidate / investigated / tool / LLM / token counts did not differ across arms on any Real-v1 case.

---

## Retrieval Funnel

Stages are not interchangeable.

```text
Discovery          find PR / commit references (candidates, not evidence)
    → Top-K        runtime selection / ranking into the investigation budget
    → Investigation fetch PR/commit metadata, files, patch, commit details
    → Evidence     observations that can satisfy requirements
    → Verification Independent Completion Verifier (not the agent)
```

### Synthetic evidence-driven (6 expected)

| Stage | Count | Notes |
|---|---|---|
| Discovery | 5/6 | `SRE07` miss |
| Top-K (`topKFound`) | 4/6 | `SRE06` ranked out; `SRE07` never found |
| Investigation success | 4/6 | same as Top-K here |
| Verifier `verified_complete` | 4/6 | `SRE01`–`SRE04`; `SRE06`/`SRE07` `insufficient_evidence` |

Baseline synthetic: Discovery 5/6, Top-K 5/6, Investigation 5/6, `verified_complete` 4/6 (`SRE06` investigated but still `insufficient_evidence`).

### Real-v1 evidence-driven (7 expected)

| Stage | Count | Notes |
|---|---|---|
| Discovery | 7/7 | every expected PR/commit appears in `discovered` |
| Top-K (`topKFound` / Recall@5) | 6/7 | `C08` combined-list position 6 |
| Investigation success | 7/7 | `C08` GT commit is still `investigating` (per-type budget) |
| Evidence / verifier `verified_complete` | 5/7 | `C07` and `C08` stop at `insufficient_evidence` |

Baseline Real-v1: Discovery 7/7, Top-K 7/7, Investigation 7/7, `verified_complete` 5/7.

Ranking did not add a Real-v1 discovery. It moved `C08`’s expected commit later in the combined selected list. Verification outcomes did not change on any Real-v1 case.

`C05`/`C06`/`C10` are outside this funnel (no resolution candidate expected).

---

## Cost

`toolCalls` = trace `tool_call` count. `llmCalls` = Fake Model `decide()` count collected during the run. `inputTokens` = estimated. `outputTokens` = null. Runtime = measured `Date.now()` delta (typically 0–17 ms; not a meaningful ranking-cost signal on this Fake Model).

### Synthetic averages (all 7 cases, including `SRE05`)

| Metric | Controlled baseline | Evidence-driven ranking |
|---|---|---|
| averageCandidates | 2.14 | 2.14 |
| averageInvestigatedCandidates | 2.00 | 2.00 |
| averageToolCalls | 4.00 | 4.29 |
| averageLlmCalls | 4.00 | 4.29 |
| averageInputTokens (estimated) | 8038 | 9097 |
| averageOutputTokens | null | null |
| averageRuntimeMs | 4.86 | 3.43 |

The synthetic cost delta is `SRE06`: baseline 5 tool / 5 LLM / 13118 estimated input tokens; evidence-driven 7 / 7 / 20531. Ranking investigated five `Fixes #42` distractors instead of the GT. Other synthetic pairs are identical on tools, LLM calls, and estimated tokens.

### Real-v1 averages (C01–C10)

| Metric | Controlled baseline | Evidence-driven ranking |
|---|---|---|
| averageCandidates | 2.10 | 2.10 |
| averageInvestigatedCandidates | 2.10 | 2.10 |
| averageToolCalls | 4.60 | 4.60 |
| averageLlmCalls | 4.60 | 4.60 |
| averageInputTokens (estimated) | 10111 | 10111 |
| averageOutputTokens | null | null |
| averageRuntimeMs | 2.80 | 2.30 |

No Real-v1 case differed in candidate counts, investigated counts, tool calls, LLM calls, or estimated input tokens across arms. Ranking did not buy retrieval quality and did not spend extra investigation budget on this dataset, except the `C08` order change inside the same six selected candidates.

---

## Case-Level Failure Analysis

Focus cases requested: `C01`, `C07`, `C08`, `C09`, `C10`. Causes below are taken from evaluation metrics plus the detailed candidate / verifier-check dump from `runRetrievalEvaluation` on the same snapshots. They are not assumed from issue narrative.

### C01 — microsoft/vscode#258694 — PR `284149`

Expected: PR `284149`. Observed (both arms, identical):

- Discovered: PRs `258293` (lexical score 42, `investigating`), `275576` (`promoted`, score 0), `284149` (`promoted`, score 0).
- Top-K: all three selected. Recall@1 = 0, Recall@3 = 1.
- Investigated: yes. GT promoted.
- Verifier: `verified_complete` (all checks pass, including `resolution-effect`).
- Tools: `github_get_issue` → timeline → three `github_get_pull_request` → `github_get_pull_request_files`.

First labeled retrieval failure: none (`retrieval_complete`). The GT is not rank-1 because ranking and discovery order both place lexical-overlap PR `258293` first, and the GT PR has `rankingScore = 0` / `default_order` at discovery (pointer text, no issue-reference signal). That is a rank-1 quality issue, not a discovery miss, and ranking did not change it versus baseline.

### C07 — better-auth/better-auth#4490 — PR `7256`

Expected retrieval candidate: PR `7256`. Benchmark expectedOutcome is `not_verified` (semantic mismatch / `wrong_target`; GitHub `Closes #4490` is not independent proof). Observed (both arms, identical):

- Discovered: PRs `3868`, `6248`, `7256`. All score 0 / `default_order`.
- Top-K: yes (Recall@1 = 0, Recall@3 = 1). GT is third and `promoted`.
- Investigated: yes.
- Verifier: `insufficient_evidence`. Checks: `resolution-candidate/pr-merged/code-commit` pass; `resolution-effect` is `unknown`.
- Tools include three PR fetches, files, and `github_list_commits`.

This is **not** a retrieval miss. The expected candidate was discovered, entered Top-K, investigated, and promoted. First funnel label: `EVIDENCE_INSUFFICIENCY`. Independent verification did not accept `resolution_effect`. That matches the case’s intended semantic gap; it is not evidence that ranking failed, and ranking did not change the outcome.

### C08 — beyond-all-reason/bar-lobby#291 — commit `e70118a…`

Expected: direct commit `e70118a2a11aa239472336f6a961784f04c63c9d`. Benchmark expectedOutcome is `verified_complete`.

Discovered on both arms (6 candidates): PRs `293`, `596`, `597` (all score 0) and commits:

| Commit prefix | Ranking score | Signals |
|---|---|---|
| `639831274f02` | 113 | issue_reference + lexical |
| `fe99285a0564` | 109 | issue_reference + lexical |
| `e70118a2a11a` (GT) | 106 | issue_reference + lexical |

Selected count is 6 because the budget is per source type (3 PRs + 3 commits), all `investigating`/`promoted`. Rejected count is 0.

**Baseline combined selected order:** PR `597`, `293`, `596`, commit `639831` (`promoted`), **GT `e70118a`**, `fe99285`. Recall@5 = 1. Diagnosis: `evidence_insufficient`.

**Evidence-driven combined selected order:** PR `293`, `596`, `597`, commit `639831` (`promoted`), `fe99285`, **GT `e70118a` (6th)**. Recall@5 = 0. Diagnosis: `ranked_out_of_top_k`. `investigationSuccess` is still true: the GT commit status is `investigating`.

Verifier on both arms: `insufficient_evidence`; `resolution-effect` unknown. Tools: issue, timeline, three PR fetches, comments, `github_list_commits`, `github_get_commit`.

First meaningful retrieval-metric failure under ranking: `RANKING_FAILURE` (combined Recall@5). The candidate was **not** “never discovered” and **not** dropped from the commit investigation budget. After investigation, evidence is still insufficient on **both** arms, so ranking is not the reason verification failed; it is the reason Recall@5 failed.

Multiple commits mention the issue. Lexical + issue-reference ranking prefers other commits over the labeled resolving commit. Unrelated PRs occupy the first three combined slots on both arms, which is why Recall@1 and Recall@3 are 0 even on baseline.

### C09 — olafkfreund/Factory#273 — PR `279`

Expected: PR `279`. Observed (both arms):

- Discovered: PRs `1` and `270` (lexical 165 each) and GT `279` (score 0, `promoted`).
- Top-K: yes. Recall@1 = 0, Recall@3 = 1.
- Investigated: yes. GT promoted.
- Verifier: `verified_complete`.
- Ranking only swaps `#1` and `#270`; it does not move the GT out of Top-3.

No retrieval-funnel failure. Untrusted issue text did not become a completion verdict (`falseCompletion = false`). Ranking did not help Recall@1 because the GT PR again has `default_order` at discovery.

### C10 — microsoft/playwright-mcp#1495 — no resolution candidate expected

`expectedResolution: none`. Diagnosis `no_resolution_expected` on both arms. Discovered candidates: 0. Tools: issue, timeline, comments, `github_list_commits`. Verifier: `insufficient_evidence` (missing `req-pr` / `req-commit`; `resolution-candidate` unknown). Ground-truth expectedOutcome is `not_verified`.

This is not `DISCOVERY_FAILURE`: no candidate was supposed to be retrieved. The evaluator has no `VERIFICATION_FAILURE` label. The observed vs expected verifier status difference (`insufficient_evidence` vs `not_verified`) already exists on this Fake Model path; ranking did not create it.

### Other Real-v1 cases (brief)

- **C02 / C04:** single GT PR, score 0, promoted, `verified_complete`. Ranking has nothing to reorder.
- **C03:** GT PR `14022` discovered among three score-0 PRs, promoted, Recall@1 = 0 / Recall@3 = 1, `verified_complete`. Arms identical.
- **C05:** not_planned; extra PR `616` is selected with lexical 135 but the run stops after `github_get_issue`. Not counted as retrieval failure.
- **C06:** not_planned; zero candidates.

No Real-v1 case produced `INVESTIGATION_FAILURE` (selected GT that then failed the investigation-success predicate). No case produced `verifierFalsePositive`.

---

## Findings

### Observed facts

1. On this controlled Fake Model + snapshot evaluation, Evidence-driven ranking did **not** raise Candidate Discovery Rate, Recall@K, Precision@K, or investigation-success versus discovery-order selection.
2. Where the arms differ, ranking is worse: synthetic `SRE04` Recall@1/@3, synthetic `SRE06` Top-K / investigation-success, Real-v1 `C08` Recall@5.
3. Real-v1 discovery of the labeled resolution candidate is already 7/7 without ranking.
4. Real-v1 tool/LLM/token cost is identical across arms.
5. Several expected PRs (`C01` `284149`, `C03` `14022`, `C07` `7256`, `C09` `279`) have `rankingScore = 0` / `default_order` at evaluation time, while distractors can have lexical overlap with issue text.
6. `C07` retrieves PR `7256` and still does not verify `resolution_effect`.
7. `C08` discovers the expected commit on both arms; ranking places it 6th in the combined selected list; verification is `insufficient_evidence` on both arms.
8. `C10` discovers no resolution candidate, which matches `expectedResolution: none`.
9. `falseCompletion = 0` and `verificationInvariantRate = 1` on both datasets.

### Interpretation

The current ranking signals (especially lexical overlap and issue-reference on commit messages) measure **mention / textual overlap**, not “this is the resolving artifact”. On `SRE06` and `C08` that sends investigation order toward other issue-mentioning objects. On most Real-v1 PR cases there are few candidates and the GT PR is still inside budget, so ranking is a no-op for verifier outcome.

This run does **not** show that Evidence-driven retrieval improves resolution-candidate retrieval. It also does **not** show that ranking is the reason `C07`/`C08` fail verification: those verifier results are the same on the controlled baseline.

Transfer: synthetic ranking-stress (`SRE06`) does show up on real GitHub data (`C08` multi-commit). The “strong single PR” synthetic successes (`SRE01`–`SRE03`) also transfer (`C02`/`C04`). Ranking is not required for those successes.

### Limitations

- Deterministic Fake Model only. Not a live-LLM retrieval quality score.
- `inputTokens` estimated; `outputTokens` / provider totals unavailable; no `totalTokens` field.
- `runtimeMs` is real but too small to interpret as ranking overhead.
- `selected` vs `investigated` cannot be separated in the current runtime statuses.
- Combined-list Recall@K vs per-source-type budget makes `C08` `RANKING_FAILURE` while investigation-success remains true.
- `VERIFICATION_FAILURE` is not in the diagnosis schema.
- Structural ranking (`structurallyReferencedIds`) is populated from **commit** ids when scoring; it does not explain GT PR `default_order` scores.
- Ranking is computed from discovery-time pointer text. Empty PR title/body at that moment is consistent with score 0 on several GT PRs; this report does not claim a code bug, only that the observed scores are 0.
- Real-v1 n = 10 (7 with a labeled resolution candidate). Do not over-generalize.

---

## Next Experiment

Do **not** implement the next capability in this phase.

Observed failures that ranking / Top-K actually moved:

1. **Mention-based ranking vs resolving identity** (`SRE06`, `C08`): issue-reference + lexical overlap ranks other commits/PRs above the labeled resolution candidate.
2. **GT PRs with `default_order` score 0** (`C01`, `C09`, and others): discovery finds them; rank-1 fails because distractors have lexical overlap and the GT PR has no ranking signal at selection time.
3. **Combined Top-K vs per-type budget** (`C08`): Recall@5 and investigation budget disagree.

Failures that are **not** ranking misses and should not be “fixed” with a new retriever:

- `SRE07`: candidate never in the discovery window.
- `C07`: candidate retrieved; independent `resolution_effect` does not pass.
- `C10`: no resolution candidate expected.
- `C05`/`C06`: not_planned, no resolution expected.

**Next experiment to investigate (not implement here):** ranking-signal / Top-K definition — specifically whether selection should re-score after PR/commit metadata is fetched, and whether Recall@K should be computed inside each source-type group the same way the investigation budget is applied — **before** embeddings, vector search, LLM reranking, or query rewriting.

Those latter techniques are not justified by this dataset yet: Real-v1 already discovers the labeled candidate; the measured errors are order and signal quality among discovered objects, and lexical overlap already mis-orders them. Semantic similarity would need a separate experiment that can beat mention-overlap without repeating `SRE06`/`C08`.
