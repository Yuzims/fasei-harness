# Retrieval Measurement Contract

Measurement / instrumentation only. This does not change ranking, discovery, the per-source-type investigation budget, verifier behavior, or recovery.

Evaluation version: `8.9.x-contract`.

## Independent stages

```text
Discovery
  → Ranking
  → Retrieval Top-K
  → Investigation Budget
  → Investigation
  → Promotion
  → Evidence
  → Verification
```

| Stage | Meaning | Observed as |
|---|---|---|
| Discovered | Present in the discovery result | `retrievalCandidates` / `discovered` |
| Ranked | Has a deterministic ranking position/score | `retrieval_candidate_ranked` |
| Retrieval Top-K | In the explicit combined list used for Recall@K / Precision@K | `retrievalTopKCandidates` |
| Investigation Budget | Admitted into `MAX_INVESTIGATED_CANDIDATES` per source type | `investigationCandidates` |
| Investigating | Entered the investigation budget | status `investigating` or `promoted` |
| Investigated | `retrieval_investigation_started` was recorded | `investigatedCandidates` |
| Promoted | Existing candidate lifecycle promotion | `promotedCandidates` |
| Evidence / Verification | IndependentCompletionVerifier | `verificationResult` |

`promoted` is not investigation success and is not retrieval Top-K.

Investigation success (unchanged from `e57fceb`): the expected candidate entered the investigation budget (`investigating` or `promoted`).

## Independent constants

| Constant | Role | Value |
|---|---|---|
| `RETRIEVAL_TOP_K` | Combined retrieval Top-K for Recall@K / Precision@K | 5 |
| `MAX_INVESTIGATED_CANDIDATES` | Per-source-type investigation budget | 5 |

These are not the same policy. Combined selected count can exceed `RETRIEVAL_TOP_K` because the budget is applied separately to pull requests and commits.

Current retrieval Top-K policy: first `RETRIEVAL_TOP_K` of the combined investigation-admitted list, in runtime order. The evaluator does not re-rank to derive this list.

## Why C08 needs this

Recall@K uses the combined retrieval Top-K. The investigation budget is per source type. An expected commit can therefore be investigated while sitting outside combined Recall@5.

That is a measurement distinction, not a ranking-algorithm change.
