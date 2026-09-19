# Phase 8.8.6 — Open-Issue Closure Semantics

This phase repairs Investigation Closure / Evidence-Gap Strategy termination so that an open GitHub issue does not end investigation. IndependentCompletionVerifier verdicts, EvidenceRequirement evaluation, Recovery Planner, Failure Analyzer, Dataset, Ground Truth, and GitHub Provider are unchanged.

## Problem

Phase 8.8.2.3 treated `issue_closed rejected` as terminal negative evidence. After `github_get_issue` observed `state = OPEN`:

1. `evaluateEvidenceRequirement(issue_closed)` returned `rejected`
2. `hasTerminalNegativeEvidence(gap)` was true
3. `decideInvestigationClosure()` returned `GAP_CLOSED`
4. `legalActions = []`
5. Investigation stopped after a single issue observation

That mixed a **verification condition** with an **investigation termination condition**. An open issue only proves the issue is not currently closed. It does not prove “unresolved” and is not enough to stop timeline / comments / PR / files / commits investigation.

## Rule

```text
Evidence Requirement rejected  ≠  Investigation Terminal Condition
```

| Condition | Investigation | Verification |
|---|---|---|
| `issue_closed rejected` (issue is open) | continue; keep discovery / PR / code actions legal | still blocks `verified_complete` |
| `eligible_closure rejected` (`not_planned`) | `GAP_CLOSED` | still `not_verified` |
| `issue_identity rejected` | `GAP_CLOSED` | still `not_verified` |

`hasTerminalNegativeEvidence()` now checks only `eligible_closure` and `issue_identity`.

## What was not changed

- IndependentCompletionVerifier / Verification Contract
- `evaluateEvidenceRequirement("issue_closed")` (open issue remains `rejected`)
- Recovery Planner / Failure Analyzer
- GitHub Provider / snapshots / Real-v1 Dataset / Ground Truth
- LLM runtime, frontend, API
- semantic `resolution_effect` alignment

## Tests

Deterministic tests in `tests/investigation-closure.test.ts`:

- open `issue_closed rejected` is not terminal; strategy is `GAP_OPEN_ACTIONABLE`
- wrong identity and `not_planned` remain `GAP_CLOSED`
- open-issue loop continues past `get_issue` and does not mint `verified_complete`
- IndependentCompletionVerifier still rejects an open issue even when a landed path exists

No live GitHub. No live LLM.
