# Phase — Metadata-Enriched Retrieval Ranking Results

This document reports a controlled run of metadata-enriched ranking against the frozen retrieval measurement contract (`docs/evaluation/retrieval-measurement-contract.md`, evaluator version `8.9.x-contract`). It does not change Ground Truth, verifier behavior, Recovery Planner, Evidence-Gap Strategy, discovery bounds, investigation budget, or metric definitions.

Evaluated:

- Synthetic cases `SRE01`–`SRE07` via `evaluateAllSyntheticRetrievalCases()`
- Real-v1 `C01`–`C10` via `evaluateRealV1RetrievalCases()`

Each case was run three times with the same Investigation Agent, the same deterministic Fake Model (`createStrategyEvaluationModel` / `nextInvestigationAction`), the same snapshot provider, the same discovery, and the same candidate investigation budget (`MAX_INVESTIGATED_CANDIDATES = 5` per source type). Combined `RETRIEVAL_TOP_K = 5`.

| Arm | Code id | What actually differs |
|---|---|---|
| Controlled baseline | `baseline` | Discovery-order bounded selection (`applyDiscoveryOrderSelection`). No ranking. |
| Evidence-driven retrieval | `evidence_driven` | Existing deterministic ranking: issue-reference + structural + lexical + temporal (`applyCandidateSelection` / `rankCandidates`). |
| Metadata-enriched retrieval | `metadata_enriched` | **Only variable versus `evidence_driven`:** the same existing score plus metadata signals extracted from already-available snapshot / candidate metadata (`applyMetadataEnrichedSelection`). |

The unique experimental variable in this phase is **metadata-enriched ranking**. Discovery candidates, snapshots, Fake Model, investigation budget, `RETRIEVAL_TOP_K`, verifier, and Ground Truth are identical across `evidence_driven` and `metadata_enriched`.

`baseline` is retained so prior discovery-order numbers remain comparable. It is a controlled baseline, not a historical production system. No live LLM or GitHub API was called.

Ground truth / `expectedOutcome` was used only by the evaluator after the run. Ranking code does not import evaluation, verifier, or `ground-truth.json`.

## What was added

Metadata signals (each capped; missing metadata scores 0; no hard filter):

| Signal | Cap | Source |
|---|---|---|
| `issueReferenceStrength` | 20 | `extractSemanticReferences`: closing keyword for this issue = 20, ordinary reference = 8, negative / none = 0 |
| `pathOverlapScore` | 15 | unique token overlap between issue text and changed file paths |
| `messageOrTitleAlignment` | 15 | capped lexical overlap of issue text vs PR title / commit message |
| `resolutionKeywordSignal` | 10 | generic fix/close/resolve/address language in title/body/message |
| `mergeStateSignal` | 8 | `merged === true` only; not a proof of resolution |
| `structuralChangeSignal` | 8 | file count / additions+deletions buckets |

Formula:

```text
rankingScore = existingScore + metadataScore

existingScore =
    (issueReference ? 100 : 0)
  + structuralScore
  + lexicalScore
  + temporalScore

metadataScore =
    issueReferenceStrength
  + pathOverlapScore
  + messageOrTitleAlignment
  + resolutionKeywordSignal
  + mergeStateSignal
  + structuralChangeSignal
```

`existingScore` is unchanged when metadata signals are absent. Tie-breakers remain `sourceType` then `sourceId`. Ranking still controls investigation order only.

Snapshot schema, GitHub API surface, and dataset ground truth were not modified. Enrichment reads `SnapshotGitHubProvider.getSnapshot()` already in memory. No new network request.

## Executive Summary

Versus **evidence-driven ranking** (the only intended variable):

- Synthetic: Candidate Discovery Rate unchanged (5/6). Recall@1 rose from 0.500 to 0.667. Recall@3 rose from 0.500 to 0.667. Recall@5 stayed 0.667. Investigation Success stayed 0.667. The only changed case is `SRE04`.
- Real-v1: Discovery unchanged (7/7). Recall@1 rose from 0.286 (2/7) to 0.714 (5/7). Recall@3 stayed 0.857 (6/7). Recall@5 stayed 0.857 (6/7). Investigation Success stayed 1.000 (7/7). Verification outcomes did not change on any case.
- No Real-v1 or synthetic case **regressed** versus evidence-driven on Recall, Precision, Investigation Success, or verifier status.
- `C08` still has combined Recall@5 = 0 and Investigation Success = true. That measurement distinction remains valid.
- `C10` still discovers 0 candidates. Metadata ranking did not invent a false candidate.

This run does **not** show that metadata ranking is “smarter.” It shows that unused snapshot PR metadata can move some already-discovered GT PRs to rank-1, and that the remaining misses (`SRE06`, `C08`, `C09` Recall@1) are not fixed by these signals.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Parent HEAD | `dd01e689fcf1f2308243d3231bfa44cdf4cdd160` |
| Evaluation version | `8.9.x-contract` (measurement contract unchanged) |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| GitHub API | not called (`SnapshotGitHubProvider` only) |
| OpenAI / DashScope / Qwen | not called (deterministic Fake Model only) |
| Live keys present | none |

`inputTokens` is a local heuristic (`message chars / 4`), flagged `inputTokensEstimated = true`. `outputTokens` is `null`. `toolCalls` comes from AgentLoop `tool_call` events. `runtimeMs` is Fake Model wall-clock and is not a ranking-cost signal.

Recall@K / Precision@K use runtime `retrievalTopKCandidates`. Investigation Success uses investigation-budget status (`investigating` or `promoted`). The evaluator does not re-rank.

---

## Synthetic Results

### Synthetic aggregate (6 resolution-expected cases)

| Metric | Controlled baseline | Evidence-driven | Metadata-enriched |
|---|---|---|---|
| Candidate Discovery Rate | 0.833 (5/6) | 0.833 (5/6) | 0.833 (5/6) |
| Recall@1 | 0.833 | 0.500 | 0.667 |
| Recall@3 | 0.833 | 0.500 | 0.667 |
| Recall@5 | 0.833 | 0.667 | 0.667 |
| Precision@1 | 0.833 | 0.500 | 0.667 |
| Precision@3 | 0.611 | 0.500 | 0.556 |
| Precision@5 | 0.575 | 0.542 | 0.542 |
| Investigation success rate | 0.833 | 0.667 | 0.667 |
| False completion rate | 0 | 0 | 0 |
| Verification invariant rate | 1 | 1 | 1 |

Discovery did not change. Versus evidence-driven, metadata ranking raised Recall@1 / Recall@3 / Precision@1 / Precision@3 because `SRE04` moved GT PR `#7` from position 4 to position 1. Recall@5 and Investigation Success did not change: `SRE06` is still ranked out of Top-K, `SRE07` is still a discovery miss.

### Synthetic per-case (E = evidence-driven, M = metadata-enriched)

| Case | Disc. E/M | Top-K E/M | R@1 E/M | R@3 E/M | R@5 E/M | P@1 E/M | Inv. E/M | Diagnosis E/M | Verifier E/M |
|---|---|---|---|---|---|---|---|---|---|
| SRE01 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | Y/Y | retrieval_complete | verified_complete |
| SRE02 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | Y/Y | retrieval_complete | verified_complete |
| SRE03 | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | 1/1 | Y/Y | retrieval_complete | verified_complete |
| SRE04 | Y/Y | Y/Y | 0/1 | 0/1 | 1/1 | 0/1 | Y/Y | retrieval_complete | verified_complete |
| SRE05 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | no_resolution_expected | not_verified |
| SRE06 | Y/Y | N/N | 0/0 | 0/0 | 0/0 | 0/0 | N/N | ranked_out_of_top_k | insufficient_evidence |
| SRE07 | N/N | N/N | 0/0 | 0/0 | 0/0 | 0/0 | N/N | discovery_failure | insufficient_evidence |

`SRE04`: all four PRs say `Fixes #42` in snapshot bodies. Evidence-driven ties on discovery-time lexical score and sorts `#21/#22/#23` before `#7`. Metadata uses the real PR title “Fix empty cart save” plus path overlap with `src/cart.ts`, so `#7` becomes rank-1. Discovery count stayed 4. Verifier stayed `verified_complete`.

`SRE06`: every constructed PR also has `Fixes #42` and the same `src/cart.ts` file row. Metadata signals are therefore the same on GT `#99` and distractors `#101`–`#105`. Order still follows `sourceId`. `#99` remains `rejected`. Metadata ranking did not recover this case.

---

## Real-v1 Results

### Real-v1 aggregate (7 resolution-expected cases)

| Metric | Controlled baseline | Evidence-driven | Metadata-enriched |
|---|---|---|---|
| Candidate Discovery Rate | 1.000 (7/7) | 1.000 (7/7) | 1.000 (7/7) |
| Recall@1 | 0.286 (2/7) | 0.286 (2/7) | 0.714 (5/7) |
| Recall@3 | 0.857 (6/7) | 0.857 (6/7) | 0.857 (6/7) |
| Recall@5 | 1.000 (7/7) | 0.857 (6/7) | 0.857 (6/7) |
| Precision@1 | 0.286 | 0.286 | 0.714 |
| Precision@3 | 0.476 | 0.476 | 0.476 |
| Precision@5 | 0.505 | 0.476 | 0.476 |
| Investigation success rate | 1.000 (7/7) | 1.000 (7/7) | 1.000 (7/7) |
| False completion rate | 0 | 0 | 0 |
| Verification invariant rate | 1 | 1 | 1 |

Discovery did not change. Versus evidence-driven, Recall@1 / Precision@1 rose because `C01`, `C03`, and `C07` moved the expected PR to combined rank-1. Recall@3, Recall@5, Precision@3, Precision@5, and Investigation Success did not change. `C08` still accounts for the Recall@5 gap versus discovery-order baseline.

### Real-v1 case table (E = evidence-driven, M = metadata-enriched)

| Case | Expected | Disc. E/M | Top-K E/M | R@1 E/M | R@3 E/M | R@5 E/M | Inv. E/M | Verifier E/M | Cand. | Inv. | Tools | LLM | First difference |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 | PR `284149` | Y/Y | Y/Y | 0/1 | 1/1 | 1/1 | Y/Y | verified_complete | 3 | 3 | 6 | 6 | GT PR becomes combined rank-1 |
| C02 | PR `14527` | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | Y/Y | verified_complete | 1 | 1 | 4 | 4 | none |
| C03 | PR `14022` | Y/Y | Y/Y | 0/1 | 1/1 | 1/1 | Y/Y | verified_complete | 3 | 3 | 5 | 5 | GT PR becomes combined rank-1 |
| C04 | PR `14504` | Y/Y | Y/Y | 1/1 | 1/1 | 1/1 | Y/Y | verified_complete | 1 | 1 | 4 | 4 | none |
| C05 | none | n/a | n/a | n/a | n/a | n/a | n/a | not_verified | 1 | 1 | 1 | 1 | none |
| C06 | none | n/a | n/a | n/a | n/a | n/a | n/a | not_verified | 0 | 0 | 1 | 1 | none |
| C07 | PR `7256` | Y/Y | Y/Y | 0/1 | 1/1 | 1/1 | Y/Y | insufficient_evidence | 3 | 3 | 7 | 7 | GT PR becomes rank-1; verifier unchanged |
| C08 | commit `e70118a…` | Y/Y | N/N | 0/0 | 0/0 | 0/0 | Y/Y | insufficient_evidence | 6 | 6 | 8 | 8 | none vs evidence-driven |
| C09 | PR `279` | Y/Y | Y/Y | 0/0 | 1/1 | 1/1 | Y/Y | verified_complete | 3 | 3 | 6 | 6 | none |
| C10 | none | n/a | n/a | n/a | n/a | n/a | n/a | insufficient_evidence | 0 | 0 | 4 | 4 | none; 0 candidates |

Candidate / investigated / tool / LLM counts did not differ across `evidence_driven` and `metadata_enriched` on any Real-v1 case. Estimated input tokens rose slightly on cases whose ranking traces now include metadata signals (Real-v1 average 10111 → 10284).

---

## Case notes requested for this phase

### C01 — microsoft/vscode#258694 — PR `284149`

Evidence-driven Top-K: `258293`, `275576`, `284149`. Recall@1 = 0.

Metadata-enriched Top-K: `284149`, `258293`, `275576`. Recall@1 = 1.

PR `284149` and `275576` already exist in the snapshot (`fixes #258694` / `Fixes #258694`). `284149` is merged with two files and more churn; `275576` is closed unmerged. Pointer PR `258293` has no snapshot metadata, so it keeps discovery-time lexical overlap only. Metadata moved the labeled PR to rank-1 without changing discovery (3) or verifier (`verified_complete`).

### C03 — streamlit/streamlit#10721 — PR `14022`

Evidence-driven Top-K: `12382`, `14022`, `15002` (sourceId order; all discovery scores 0). Recall@1 = 0.

Metadata-enriched Top-K: `14022`, `15002`, `12382`. Recall@1 = 1.

`14022` is merged with mermaid implementation files. `12382` is an unmerged prototype. `15002` is a merged spec-only PR. Investigation Success and verifier (`verified_complete`) did not change.

### C02 / C04

Single discovered GT PR on both arms. Recall@1 stayed 1. Metadata ranking did not reorder a one-candidate set.

### C07 — better-auth/better-auth#4490 — PR `7256`

Evidence-driven Top-K: `3868`, `6248`, `7256`. Recall@1 = 0.

Metadata-enriched Top-K: `7256`, `3868`, `6248`. Recall@1 = 1.

Only `7256` is in the snapshot (`Closes …#4490`, merged). The other two are mention pointers without snapshot metadata.

Verifier stayed `insufficient_evidence` (`resolution-effect` unknown) on both arms. Ranking moved the candidate; it did not change verification. This remains a retrieval / verification boundary case.

### C08 — beyond-all-reason/bar-lobby#291 — commit `e70118a…`

Unchanged versus evidence-driven:

- Discovered: 3 PRs + 3 commits (6). Combined Top-K length 5. Investigation budget 6.
- Combined Top-K: PRs `293`, `596`, `597`, then commits `63983127`, `fe99285a`. GT commit is 6th.
- Recall@5 = 0. Investigation Success = true. Diagnosis `ranked_out_of_top_k`.
- Verifier `insufficient_evidence` on all three arms.

All three commits already have explicit closing language (`Closes #291` / `Resolves #291`). Commit snapshots have no changed-file metadata, so path / structural / merge signals are 0. Combined Top-K is the first five of the investigation-admitted list in runtime order (PRs recorded first). Metadata did not change that list prefix.

Per-source-type budget is still 5. Combined Recall@5 and source-specific Investigation Success still disagree. Measurement contract still holds.

### C09 — olafkfreund/Factory#273 — PR `279`

Recall@1 stayed 0. Pointer PRs `1` and `270` still outrank `279` because discovery copies issue text onto mentioned PR numbers, producing large lexical scores. Snapshot metadata exists only for `279`. Maximum metadata score cannot overtake that discovery-time lexical overlap. Recall@3 stayed 1. Verifier stayed `verified_complete`.

### C10 — microsoft/playwright-mcp#1495

`expectedResolution = none`. Discovered candidates: 0 on all arms. Metadata ranking did not add a candidate.

---

## Cost

### Synthetic averages (all 7 cases)

| Metric | Baseline | Evidence-driven | Metadata-enriched |
|---|---|---|---|
| averageCandidates | 2.14 | 2.14 | 2.14 |
| averageInvestigatedCandidates | 2.00 | 2.00 | 2.00 |
| averageToolCalls | 4.00 | 4.29 | 4.29 |
| averageLlmCalls | 4.00 | 4.29 | 4.29 |
| averageInputTokens (estimated) | 8038 | 9097 | 9472 |
| averageOutputTokens | null | null | null |

Tool / LLM counts match evidence-driven. Token estimate rose slightly because ranking traces now carry extra signal fields. `SRE06` still costs 7 tool / 7 LLM calls on both ranking arms (investigating distractors).

### Real-v1 averages (C01–C10)

| Metric | Baseline | Evidence-driven | Metadata-enriched |
|---|---|---|---|
| averageCandidates | 2.10 | 2.10 | 2.10 |
| averageInvestigatedCandidates | 2.10 | 2.10 | 2.10 |
| averageToolCalls | 4.60 | 4.60 | 4.60 |
| averageLlmCalls | 4.60 | 4.60 | 4.60 |
| averageInputTokens (estimated) | 10111 | 10111 | 10284 |
| averageOutputTokens | null | null | null |

Investigation cost in tools and LLM calls did not change. Metadata ranking did not spend extra investigation budget on Real-v1.

---

## Which cases changed versus evidence-driven

**Improved (Recall@1 / Precision@1 only):**

- Synthetic `SRE04`
- Real-v1 `C01`, `C03`, `C07`

**Regressed:** none versus evidence-driven.

**Unchanged:**

- Synthetic `SRE01`, `SRE02`, `SRE03`, `SRE05`, `SRE06`, `SRE07`
- Real-v1 `C02`, `C04`, `C05`, `C06`, `C08`, `C09`, `C10`

Investigation Success, verification status, false completion, and verification invariant did not change on any case.

Versus **discovery-order baseline**, metadata ranking is still worse on Recall@5 (`SRE06`, `C08`) and still better on Real-v1 Recall@1 (5/7 vs 2/7). Those Recall@5 gaps already existed under evidence-driven ranking.

---

## Leakage and frozen surfaces

- Ranking / metadata-signal modules do not read `ground-truth.json`, `REAL_V1_RETRIEVAL_GROUND_TRUTH`, verifier results, or final task outcome.
- Discovery set is unchanged (same candidate counts on every paired run).
- `MAX_INVESTIGATED_CANDIDATES = 5` per source type is unchanged.
- `RETRIEVAL_TOP_K = 5` and `retrievalTopKCandidates` / `investigationCandidates` / `investigatedCandidates` / `promotedCandidates` remain separately recorded.
- Independent Completion Verifier output is unchanged on every evaluated case.
- Production `investigate()` still defaults to evidence-driven selection unless evaluation injects `metadata_enriched`.

---

## Is semantic retrieval justified next?

Not from this dataset.

What metadata ranking actually moved: GT PRs that already had unused snapshot title/body/merged/files (`C01`, `C03`, `C07`, `SRE04`). That is structured metadata, not semantic similarity.

What it did not move:

1. `SRE06` — distractors share the same closing keyword and the same snapshot file row; signals tie.
2. `C08` — three commits all close `#291`; combined Top-K is filled by PRs first; commit snapshots have no file metadata.
3. `C09` Recall@1 — discovery-time lexical self-overlap on pointer PRs without snapshot metadata.
4. `C07` verification — candidate is retrieved; `resolution-effect` still fails.
5. `C10` / `SRE07` — no-resolution or not-in-window. Not a ranking problem.

Embeddings / LLM ranking / query rewriting would need a separate experiment that can beat mention-overlap without repeating `SRE06` / `C08`. This run does not provide that justification. A cheaper next measurement, if any, is the discovery-text artifact (issue body copied onto every mentioned PR) and/or combined Top-K versus per-type budget — not a vector index.

## Limitations

- Deterministic Fake Model only.
- Metadata catalog is snapshot-local. Live API is not given new fetches; without already-available metadata, `metadataScore` is 0 and the arm equals evidence-driven.
- Commit snapshots have no `createdAt` / files; merge timestamp is absent from the PR snapshot type. Those signals were not invented.
- Real-v1 n = 10 (7 with a labeled resolution candidate).
- Production default ranking was not switched in this phase.
