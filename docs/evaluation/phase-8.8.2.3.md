# Phase 8.8.2.3 — Strategy Stop & Closure Semantics

This phase repairs Evidence-Gap Investigation Strategy stop / closure semantics. It does not change IndependentCompletionVerifier verdicts, Recovery Planner, Failure Analyzer, Dataset, Ground Truth, GitHub Provider, LLM runtime, or semantic `resolution_effect` alignment.

> Later correction (Phase 8.8.6): `issue_closed rejected` is no longer terminal negative evidence. An open issue continues investigation; IndependentCompletionVerifier still uses `issue_closed` as a completion condition.

## Scope

- HEAD at start: `46a4a43c46fc31b06fecd96bd6b01786848796a2`
- Prior analysis: [phase-8.8.2.2.md](./phase-8.8.2.2.md)
- Working tree at start had one unrelated untracked file (`8.md`). It was not included.

Allowed edits were limited to Evidence Gap / candidate actions, Strategy stop / closure, resolution-candidate discovery/filtering, related types / trace fields, and deterministic tests.

## 1. Problem

Phase 8.8.2.2 showed that Strategy treated “a legal investigation action still exists” as “the investigation should continue.” That single stop rule produced:

| Case | Mechanism |
|---|---|
| C01 | First linked unmerged PR satisfied `resolution_candidate` and rejected `resolution_merged`, so later `github_get_pull_request` (including merged #284149) became illegal |
| C05 / C06 | `eligible_closure` rejected (`not_planned`) was ignored; leftover files/commits on body-mention PRs stayed legal |
| C08 | After the resolution chain was already satisfied, exploratory files/commits on leftover candidate numbers stayed legal until `maxSteps` |
| 17/18 `strategy_exhausted` | Empty legal list was the only Strategy terminal, including healthy completions |

`resolution_effect` remaining after GitHub objects are already in the graph is a semantic / descriptive-alignment gap. This phase does not try to close it with more of the same tools.

## 2. Closure decision

`decideInvestigationClosure()` in `src/investigation/investigation-closure.ts` is the deterministic stop decision. It is not a second verifier.

```text
GAP_CLOSED
  required required-gaps are satisfied
  OR terminal negative evidence (eligible_closure / issue_identity / issue_closed rejected)
  → stop; IndependentCompletionVerifier still runs

GAP_OPEN_ACTIONABLE
  a required gap remains AND at least one mapped action can still change that gap
  → continue; legal set is advancing GitHub actions, plus record_claim if already proposed

GAP_OPEN_UNRESOLVABLE
  resolution_effect is missing AND a landed path already exists
  → stop; do not keep fetching files/commits/claims to “prove” alignment

NO_LEGAL_ACTION
  a required gap remains, no advancing action remains, and the remainder is not the semantic-effect case
  → existing strategy_exhausted terminal
```

AgentLoop maps those terminals as:

| Closure | `investigation_blocked` code | `AgentResult.decision` |
|---|---|---|
| `GAP_CLOSED` | `GAP_CLOSED` | `gap_closed` |
| `GAP_OPEN_UNRESOLVABLE` | `GAP_OPEN_UNRESOLVABLE` | `gap_unresolvable` |
| `NO_LEGAL_ACTION` | `NO_LEGAL_INVESTIGATION_ACTION` | `strategy_exhausted` |

None of these is an Agent `final`. Strategy still cannot set `verified_complete`.

`record_claim` may remain legal while the gap is still `GAP_OPEN_ACTIONABLE`. It does not, by itself, keep investigation open once advancing GitHub actions are gone.

## 3. Candidate-action repairs

`collectPullActions` now keeps unfetched `candidatePrs` legal until `resolution_merged` is satisfied. An earlier unmerged PR no longer freezes later candidates.

`collectCodeActions` no longer emits exploratory files/commits after code/effect gaps are closed, and it no longer falls back to unused candidate PR numbers when no merged PR exists. Files/commits are collected on landed PRs; repo `github_list_commits` remains a discovery path when no merged PR is present.

Terminal negative evidence (`not_planned`, wrong identity, open issue) suppresses discovery / pull / code / claim collectors, except `recheck_target` recovery which may still re-fetch the issue.

## 4. Mechanism check on C01 / C05 / C06 / C08

Re-ran existing `evaluateRealV1Case` (snapshot + Fake Model only; no live GitHub / LLM) after the code change:

| Case | Baseline | Strategy | Decision | Tools | Notes |
|---|---|---|---|---:|---|
| C01 | `verified_complete` | `verified_complete` | `gap_closed` | 6 | `get_pr` continues after the first unmerged candidate; false completion 0 |
| C05 | `not_verified` | `not_verified` | `gap_closed` | 1 | Stops after `github_get_issue`; no phantom files/commits |
| C06 | `not_verified` | `not_verified` | `gap_closed` | 1 | Same `not_planned` stop |
| C08 | `verified_complete` | `verified_complete` | `gap_closed` | 7 | No leftover exploratory files/commits; `budgetExhaustion=false` |

C01 tool sequence: issue → timeline → three `github_get_pull_request` → files on the landed PR. That is the unfreeze, not a Verifier change. C01 `llmCalls=6`, `toolCalls=6`, `falseCompletionRate=0`. C08 `budgetExhaustion=false`.

Across the same 18 strategy arms as Phase 8.8.2.1 (8 synthetic + C01–C10):

| Terminal | Count |
|---|---:|
| `GAP_CLOSED` (`gap_closed`) | 14 |
| `GAP_OPEN_UNRESOLVABLE` (`gap_unresolvable`) | 2 |
| `NO_LEGAL_ACTION` (`strategy_exhausted`) | 2 |
| `GAP_OPEN_ACTIONABLE` as a terminal | 0 |

`strategy_exhausted` is **2 / 18** (Phase 8.8.2.1: 17 / 18). The two remaining `NO_LEGAL_ACTION` terminals are synthetic `no_legal_action` and Real-v1 `C10`. The two `GAP_OPEN_UNRESOLVABLE` terminals are synthetic `resolution_effect_gap` and Real-v1 `C07` (semantic `resolution_effect`, not a missing tool).

This is not a new Phase 8.8.2.1-style full metric table. The 18-arm counts above come from a later snapshot + Fake Model re-run of the existing evaluator.

## 5. What was not changed

- IndependentCompletionVerifier verdict semantics
- Verification Contract
- GitHub Provider / snapshots
- Real-v1 Dataset / Ground Truth
- Recovery Planner / Failure Analyzer
- LLM provider, OpenAICompatModel, LLM runtime budget implementation
- context compaction implementation
- frontend / API
- Fake Model observation policy (`nextInvestigationAction` / `selectPreferredToolCall`)
- semantic `resolution_effect` alignment (`describeResolutionAlignment`)
- no new LLM judge, external API, or tool

LLM budget / context-profiling tests that need a long unconstrained loop now pass `investigationActionConstraint: "unconstrained"` so they keep testing `LlmRuntimeGuard` rather than leftover Strategy actions.

## 6. Tests

`npm test` — 384 passed, 0 failed  
`npm run build` — passed  

New / updated deterministic tests:

- `tests/investigation-closure.test.ts` — the four closure statuses, `not_planned` stop, first-candidate unfreeze
- `tests/evidence-gap-strategy.test.ts` — closed-gap stop is `gap_closed`, not `strategy_exhausted`
- `tests/agent-loop.test.ts` — `gap_closed` / `gap_unresolvable` are not Agent finals

No live GitHub. No live LLM.
