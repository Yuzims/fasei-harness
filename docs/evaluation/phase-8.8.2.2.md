# Phase 8.8.2.2 — Evidence-Gap Strategy Failure Analysis

This phase is analysis only. No Strategy, Candidate Actions, Verifier, Recovery, Dataset, Snapshot, Ground Truth, evaluator, Fake Model, or metrics code was modified.

## Scope

- HEAD at analysis start: `9b9521f0a472837876c70999625bf268e923b21c` (`docs: analyze` commit is this report)
- Prior experiment: [phase-8.8.2.1.md](./phase-8.8.2.1.md) (evaluation HEAD `973ef09`)
- Re-ran existing `runStrategyEvaluation` / `evaluateRealV1Case` for C01, C05, C06, C08 to recover tool arguments, success/fail, and verifier check messages. No live GitHub. No live LLM.

Working tree at analysis start had one unrelated untracked file (`8.md`). It was not included.

`npm test` / `npm run build` were not re-run in this phase.

---

## 1. Current workspace

```text
HEAD 9b9521f0a472837876c70999625bf268e923b21c
9b9521f eval: report evidence-gap strategy results
973ef09 test: evaluate evidence-gap investigation strategy
```

Phase 8.8.2.1 already recorded the metric deltas this analysis explains.

---

## 2. Actual execution chain (code behavior, not design intent)

The constrained arm (`investigationActionConstraint !== "unconstrained"`) wraps the Fake Model in `InvestigationLoopModel`. Each AgentLoop step does:

```text
InvestigationState + InvestigationRun
  → computeEvidenceGap(task, run)
       evaluateEvidenceRequirement() for STRATEGY_CHAIN conditions
  → EvidenceGap (missing / satisfied / rejected)
  → proposeCandidateActions(state, { gap, remainingLlmCalls })
       collectIssue / collectDiscovery / collectPull / collectCode / collectClaim
       dropSatisfiedIssueRepeats
       excludeRepeatedLoopActions
       applyBudgetFilter          // only if remainingLlmCalls <= 2
  → legalActions
  → if legalActions.length === 0
       return investigation_blocked / NO_LEGAL_INVESTIGATION_ACTION
       AgentLoop decision = strategy_exhausted
       IndependentCompletionVerifier still runs
  → else attach legalInvestigationActions + remainingLlmCalls onto ModelContext
       Fake Model: nextInvestigationAction(state)   // observation policy
       selectPreferredToolCall:
         if preferred tool_call is legal → use it
         else first legal github_* → else record_claim → else final
         if preferred is final, it is ignored whenever any legal github_* remains
  → tool execute / ingestObservation → new Evidence
  → next step
```

Baseline uses the same Fake Model (`nextInvestigationAction`) with `legalInvestigationActions` unset. When the observation policy returns `final`, baseline stops. Strategy cannot emit that `final` unless the legal list is already empty.

Verifier is not consulted inside the loop. Recovery Planner runs only after AgentLoop ends. Negative evidence and “enough to stop” are therefore invisible as stop conditions unless they happen to empty `proposeCandidateActions`.

Primary files:

- `src/investigation/investigation-agent.ts` — `InvestigationLoopModel.decide`, `runInvestigationAttempts`
- `src/investigation/candidate-actions.ts` — `proposeCandidateActions`, collectors, `applyBudgetFilter`
- `src/investigation/evidence-gap.ts` — `computeEvidenceGap`, `unresolvedRequiredGaps`
- `src/evaluation/strategy-evaluation.ts` — `selectPreferredToolCall`, `createStrategyEvaluationModel`
- `src/investigation/test-driver.ts` — `nextInvestigationAction`
- `src/agent/agent-loop.ts` — `decisionFromBlock` maps `NO_LEGAL_INVESTIGATION_ACTION` → `strategy_exhausted`
- `src/domain/requirement-eval.ts` — condition outcomes
- `src/domain/queries.ts` — `buildVerificationResult` verdict
- `src/agent/llm-runtime.ts` — `LlmRuntimeGuard.llmCallsSent` increments only on OpenAI HTTP `authorizeCall()`

---

## 3. C01 — `verified_complete` → `insufficient_evidence`

Expected / baseline: `verified_complete`. Strategy: `insufficient_evidence`, missing `resolution-effect`.

### 4.1 Why baseline completed and Strategy did not

Issue `microsoft/vscode#258694` title: “Terminal suggestions aren't dismissed when terminal is resized or moved”. Body contains `Testing #258293`. Timeline names two real PRs:

| PR | Snapshot fact |
|---|---|
| #258293 | not a PR in this snapshot (issue mention) |
| #275576 | closed, `merged=false`, title aligns with the bug |
| #284149 | `merged=true`, the actual resolution (ground truth) |

Baseline `nextInvestigationAction` fetched every unfetched `candidatePrs` entry, including #284149:

1. `github_get_issue`
2. `github_get_issue_timeline`
3. `github_get_pull_request` #258293 — FAIL (404, `not_found`)
4. `github_get_pull_request` #275576 — OK, unmerged
5. `github_get_pull_request` #284149 — OK, merged
6. files of #284149
7. commits of #284149
8. `record_claim`

Verifier landed path: **merged PR #284149** plus commit `67f18f`. `resolution_effect` passed: “shares 3/6 issue problem terms” (`describeResolutionAlignment` over PR title/body + files + commits).

Strategy stopped proposing `github_get_pull_request` after #275576. `collectPullActions` requires `resolution_candidate` **missing** or `resolution_merged` **missing** (and not rejected):

```280:284:src/investigation/candidate-actions.ts
  const candidateMissing = isMissing(gap, "resolution_candidate");
  const mergedMissing = isMissing(gap, "resolution_merged") && !isRejected(gap, "resolution_merged");
  if (!candidateMissing && !mergedMissing) {
    return;
  }
```

After ingesting unmerged #275576, `evalResolutionCandidate` is **satisfied** (PR with a `references`/`fixes` edge counts; `RESOLUTION_CANDIDATE_RELATIONS` includes `references`). `evalResolutionMerged` is **rejected** (“Candidate PR exists but merged=false”), which is not `missing`. Remaining PR #284149 is therefore **illegal**.

Strategy then used `collectCodeActions` over `candidatePrs` (because `mergedPrs` is empty) and fetched files/commits for #258293, #275576, and #284149 **without** ever ingesting PR #284149 as pull-request evidence.

Landed path became **direct commit `67f18f`** whose message is only `fixes #258694`. Closing-keyword lines are stripped in `describeResolutionAlignment.stripClosingLines`. Alignment then fails: “Landed resolution does not share enough issue problem terms”. Check status `unknown` → `buildVerificationResult` → `insufficient_evidence`.

### 4.2 Tools Strategy actually chose

Re-run of `runStrategyEvaluation({ mode: "evidence_gap" })` for C01:

| Step | Tool | Target | Success |
|---:|---|---|---|
| 1 | `github_get_issue` | #258694 | OK |
| 2 | `github_get_issue_timeline` | #258694 | OK |
| 3 | `github_get_pull_request` | #258293 | FAIL |
| 4 | `github_get_pull_request` | #275576 | OK |
| 5 | `github_get_pull_request_files` | #258293 | FAIL |
| 6 | `github_list_commits` | #258293 | FAIL |
| 7 | `github_get_pull_request_files` | #275576 | OK |
| 8 | `github_list_commits` | #275576 | OK |
| 9 | `github_get_pull_request_files` | #284149 | OK |
| 10 | `github_list_commits` | #284149 | OK |
| 11 | `record_claim` | claims | OK |

Then `legalActions.length === 0` → `strategy_exhausted`. No 12th inner model call (blocked in `InvestigationLoopModel` before `inner.decide`).

### 4.3 Requirement / condition mapping

| Call | Intended gap in `proposeCandidateActions` | What actually moved |
|---|---|---|
| get_issue | `issue_identity`, `issue_closed`, `eligible_closure` | satisfied |
| timeline | `resolution_candidate` (exploratory discovery) | added candidate PRs |
| get_pr #258293 | `resolution_candidate` / `resolution_merged` | nothing (404) |
| get_pr #275576 | same | candidate satisfied; merged **rejected** |
| files/commits #258293 | `resolution_code_evidence` / `resolution_effect` | nothing (404) |
| files/commits #275576 | same | files/commits on an unmerged PR |
| files/commits #284149 | same | commit `67f18f` linked to the issue via closing keyword → direct-commit landed path; **not** merged-PR evidence |
| record_claim | `claim_support` | claims recorded; does not evaluate effect |

### 4.4 Calls that could shrink the gap

- get_issue / timeline: necessary identity and discovery.
- get_pr #284149: the call that would have closed the C01 effect gap the same way baseline did. It was **not legal** after #275576.
- files/commits #284149: produced a landed commit, but that commit text is only a closing keyword, so they could not satisfy `resolution_effect`.

### 4.5 Repeated / low-value calls

- get_pr + files + commits on #258293: issue-body `#258293` treated as a PR number (`mentionPullNumbers` / `extractMentionedNumbers`).
- files + commits on unmerged #275576: cannot create a landed PR path; extra code evidence on a rejected merge.

### 4.6 Why `resolution_effect` remains

`evalResolutionEffect` delegates to `describeResolutionAlignment`. Strategy’s landed candidate is commit `67f18f` (`fixes #258694`). After stripping closing lines, comparable resolution text is empty. PR #284149 title (“relayout suggest widget on resize of terminal”) never entered the graph. File evidence for #284149 is related to `pr:284149`, which does not exist, so those filenames are not attached to the landed commit via `codeEvidenceForCandidates`.

This is a **semantic / descriptive-alignment gap on the wrong landed object**, not “files were never fetched”.

### 4.7 Why the verdict flipped

`buildVerificationResult` (`src/domain/queries.ts`):

- required check `resolution_effect` status `unknown` (unsatisfied, not `rejected`)
- no required check `fail`
- → `insufficient_evidence`

`falseCompletionRate` 0 → 1 because `buildDriverClaims` still emitted a critical `polarity: "resolved"` claim (“direct-commit resolution candidate”) while the verifier did not pass (`isFalseCompletion`).

IndependentCompletionVerifier did not change. The graph it scored changed: no merged PR #284149 record.

---

## 4. C05 / C06 — already `not_verified`, still investigating

Both cases: issue `stateReason: "not_planned"`. Ground truth `not_verified`. Both arms reach that verdict. Strategy adds extra tool calls after `record_claim`.

### How `not_planned` enters Evidence

`github_get_issue` → `ingestIssue` stores the issue payload, including `stateReason`. `issueFact()` reads `stateReason`. `evalEligibleClosure` rejects when `isExplicitNonResolutionReason` (`EXPLICIT_NON_RESOLUTION_REASONS = ["not_planned"]`).

Verifier: `checkStatus` maps `rejected` → check `fail`. `buildVerificationResult`: any required `fail` → `not_verified`. That path is already available **as soon as the issue observation exists**. The loop does not ask the verifier until AgentLoop ends.

### Why Strategy continues

1. `proposeCandidateActions` treats `isMissing(...)` only. **Rejected `eligible_closure` is not a stop.** `collectIssueActions` returns early once identity/closed/eligible are not missing, but discovery/code collectors still chase missing `resolution_*` conditions.

2. After get_issue, `resolution_candidate` is still `missing`. C05 issue body mentions `#616` (a PR in another repo). C06 body mentions `#123` / `#273`. Those numbers become `candidatePrs`. Snapshot `pullRequests` is `{}`. get_pr 404s; `investigatedResources` still records the pull key.

3. There is **no** candidate-action rule “negative evidence is enough for `not_verified`”. `unresolvedRequiredGaps` includes every non-optional item whose outcome is not `satisfied`, so rejected `eligible_closure` plus missing resolution chain all stay “open”.

4. Fake Model stop condition is `nextInvestigationAction` → `final` after `record_claim`. Baseline honors that because `legalInvestigationActions` is absent.

5. Strategy `selectPreferredToolCall` **ignores `final`** if any legal `github_*` remains. C05/C06 traces after `record_claim` still have `collectCodeActions` proposing files/commits for those phantom candidate PRs (`mergedPrs.size === 0` → iterate `candidatePrs`). Recorded reasons are literally:

   > Claims recorded; end the investigation without declaring VERIFIED_COMPLETE.

   and the executed tools are 404 `github_get_pull_request_files` / `github_list_commits`.

C05 extra: files #616, commits #616 (both FAIL).  
C06 extra: files+commits #123 and #273 (all FAIL).

The agent never “knows” that `not_verified` is already supported. Gap evaluation sees `eligible_closure=rejected` and still lists missing positive resolution requirements. Candidate Actions only know how to fetch more GitHub objects for those missing positives.

---

## 5. C08 — extra calls and budget exhaustion

Expected / both arms: `verified_complete`. Strategy: `budgetExhaustion=true`, `strategyExhausted=false`, `agentDecision` absent.

### 6.1 Why Strategy called more tools

Same prefix as baseline through `record_claim` (issue, timeline, three 404 get_pr on mentioned numbers 597/293/596, comments, repo `github_list_commits`). Repo commits already satisfy the resolution chain (direct commits `e70118a`, etc.). `resolution_effect` passes on that commit evidence.

After `record_claim`, baseline emits `final`. Strategy still has legal `github_get_pull_request_files` / `github_list_commits` on unused candidate PR numbers (`collectCodeActions` with `expansion = !codeMissing && !effectMissing` still adds unused files/commits as `exploratory: true`). `selectPreferredToolCall` therefore continues.

Observed extra calls (all FAIL, snapshot has no those PRs): files+commits #597, files+commits #293. `exploratoryActions` 3 → 7.

### 6.2 Why `budgetExhaustion` fired

Not `LLM_CALL_BUDGET_EXCEEDED`. Default `maxLlmCalls` is 8, but Fake Model never calls `LlmRuntimeGuard.authorizeCall()`. `llmCallsSent` stays 0.

C08 strategy executed **12** tool calls. `AgentLoop` `maxSteps` default in evaluation is 12. Loop returns `MAX_STEPS_REACHED` without `decision`. `budgetExhausted()` in `strategy-evaluation.ts` treats `agentResult.output === MAX_STEPS_REACHED` as `budgetExhaustion`.

This is the **step budget**, not the LLM call budget.

### 6.3 Extra actions

Post-`record_claim`: `github_get_pull_request_files` / `github_list_commits` for leftover `candidatePrs`.

### 6.4 Why they stayed legal

`collectCodeActions` does not exit when resolution gaps are satisfied. If `codeMissing` and `effectMissing` are both false, it still proposes unused files/commits as exploratory expansion. `resourceAvailable` only hides already-investigated keys. 404 get_pr marked `pull:N` investigated, but `files:N` / `commits:N` were still free.

`collectClaimAction` skips once claims are recorded and `claim_support` is satisfied. That removes `record_claim` but not the github expansion set.

### 6.5 Does remaining call budget participate in selection?

Two roles exist in code:

1. **Filter:** `applyBudgetFilter` / tight-budget skip of `record_claim` when `remainingLlmCalls <= 2`.
2. **Information:** `context.remainingLlmCalls` and `formatStateForModel` hint JSON.

`remainingCalls` is `maxLlmCalls - llmCallsSent`. Fake Model path never increments `llmCallsSent` (`LlmRuntimeGuard` documents: counter applies only to real OpenAICompatModel HTTP requests). In this experiment `remainingLlmCalls` is stuck at 8 (or at 2 for synthetic `tight_budget`, also stuck, which is why that case’s filter stays on every step).

For C08, remaining is always 8 `> 2`, so the budget filter **does not run**. Remaining budget is attached as context but does not shrink the legal set.

### 6.6 Why Strategy did not stop near budget exhaustion

There is no “steps remaining” input to `proposeCandidateActions`. The only Strategy stop is empty `legalActions`. Exploratory leftover actions kept the list non-empty until `maxSteps`.

---

## 6. `strategy_exhausted` (17/18)

### Observable terminal

`strategyExhausted` is `report.agentResult?.decision === "strategy_exhausted"`. That decision is **only** produced by `AgentLoop.decisionFromBlock("NO_LEGAL_INVESTIGATION_ACTION")`, which is **only** returned when `planned.legalActions.length === 0`.

So at the **terminal step**, 17/18 strategy runs are:

> **A. NO LEGAL ACTION**

C08 is the exception: legal actions still existed; the loop hit `maxSteps`. C08 is not A.

Phase 8.8.2.1 metrics do **not** record the legal set on every step. Distinguishing A/B/C **during** the trajectory required re-running `runStrategyEvaluation` and reading `investigationSteps` (done for C01/C05/C06/C08). For the other 14 cases, only the terminal decision plus final `missingRequirementIds` are reliable.

### Terminal split using 8.8.2.1 missingRequirements

**A, and final missing required gaps are empty** (empty legal set after the fetch chain; substitute for baseline `final`):

| Case | Notes |
|---|---|
| missing_resolution_evidence | verified; llmCalls −1 vs baseline (no extra `final` decide) |
| issue_already_satisfied | identical to the case above |
| missing_commit_evidence | verified |
| missing_code_evidence | verified |
| recovery | verified after recovery |
| tight_budget | verified; legal list emptied by stuck `remainingLlmCalls=2` filter |
| C02, C03, C04, C09 | verified; same or similar tool prefix as baseline, then empty legal set |

These 10 are A. Calling them “SHOULD STOP but continued” would be wrong: they stopped. Exhaustion is the constrained-arm name for “no further legal fetch”.

**A, and a required gap is still open** (empty legal set **and** the remaining gap has no mapped unused action) — this is A at the stop **and** B as the failure mode:

| Case | Still missing | Notes |
|---|---|---|
| resolution_effect_gap | `resolution_effect` | 8.8.2.1 also flagged `missing_candidate_mapping`; both arms `record_claim` only |
| no_legal_action | `req-pr`, `pr-merged`, `req-commit`, `resolution-effect` | fixture cannot supply a resolution path |
| C01 | `resolution-effect` | get_pr #284149 was made illegal; leftover files/commits did not close effect |
| C05 | `eligible_closure` + resolution chain | after extra 404 files/commits |
| C06 | same as C05 | after extra 404 files/commits |
| C07 | `resolution_effect` | both arms; semantic mismatch on landed PR #7256 |
| C10 | `req-pr`, `pr-merged`, `req-commit`, `resolution-effect` | closed/completed without a linked resolution path |

**C. SHOULD STOP, but Strategy still required continue** — observed only where traces show leftover legal github actions **after** a sufficient stop signal:

| Case | Stop signal that was ignored | What continued |
|---|---|---|
| C05 | `eligible_closure` rejected after get_issue; Fake Model `final` after `record_claim` | 404 files/commits #616 |
| C06 | same | 404 files/commits #123/#273 |
| C08 | resolution chain already satisfied; Fake Model `final` | exploratory files/commits until `maxSteps` |

C01 is not primarily C: the observation policy still wanted `github_get_pull_request` #284149. The constraint made that illegal and substituted files/commits. That is B (actions that exist cannot close the current effect gap / the useful action was removed), not “should have stopped”.

For C02–C04, C07, C09, C10, and the synthetics other than `resolution_effect_gap`, **per-step legal sets were not exported in 8.8.2.1**. Intermediate C vs B is **not reliably observable** from that report alone.

`tight_budget` is a special A: `remainingLlmCalls` is constantly 2, so `applyBudgetFilter` stays on and can empty the list before `record_claim`. Verifier still returned `verified_complete` from seeded + fetched evidence.

---

## 7. `resolution_effect` — SEMANTIC GAP, not MISSING TOOL

`resolution_effect` is not a GitHub fact that another tool returns. `evalResolutionEffect` requires a landed candidate, then `describeResolutionAlignment`:

- compares issue title identifiers / problem tokens to PR title/body and commit/file text
- explicitly “descriptive alignment, not semantic proof”
- missing alignment → requirement `missing` / check `unknown` → `insufficient_evidence`
- it does **not** by itself produce `not_verified`

Candidate Actions can only emit:

- issue / comments / timeline
- get_pr
- get_pr_files
- list_commits
- record_claim

Once those objects are in the graph, more copies of the same tools cannot prove “this change actually fixes the reported failure”. C07 is the clean example: both arms fetch the merged PR that `Closes #4490`; `resolution_effect` stays missing because the PR’s described effect does not share the issue’s problem terms. Ground truth is `not_verified` (semantic mismatch / wrong target). The harness currently reports `insufficient_evidence`. That mismatch is older than Evidence-Gap Strategy; the strategy cannot close it.

C01 shows the same evaluator, triggered by fetching the **wrong** landed object (keyword-only commit instead of merged PR #284149). Extra files/commits did not repair alignment.

`record_claim` is documented in its own candidate objective: it “does not verify completion and cannot close a resolution evidence gap.” Synthetic `resolution_effect_gap` repeats `record_claim` three times; both arms still miss `resolution_effect`.

**Label: SEMANTIC GAP** (descriptive-alignment / effect proof), **not MISSING TOOL**.

---

## 8. Root Cause Matrix

| Case / Pattern | Observed Failure | Immediate Cause | Root Cause | Evidence |
|---|---|---|---|---|
| C01 | `verified_complete` → `insufficient_evidence`; `resolution_effect` missing; false completion 0→1 | `collectPullActions` dropped get_pr #284149 after unmerged #275576 satisfied `resolution_candidate` and rejected `resolution_merged`; alignment ran on commit `67f18f` (`fixes #258694` only) | Legal actions encode “fetch next missing kind”, not “inspect remaining unfetched candidates”. First linked PR freezes discovery. | Re-run steps 3–10; `candidate-actions.ts` `collectPullActions`; `requirement-eval.ts` `evalResolutionMerged` rejected unmerged; baseline get_pr #284149; verifier messages |
| C05 | Extra investigation after `not_verified` is already determined | `eligible_closure` rejected is ignored as a stop; after `record_claim`, `selectPreferredToolCall` overrides Fake Model `final` with leftover files/commits on body-mention #616 (404) | No sufficiency/stop on negative evidence; legal list stays non-empty while any `resolution_*` is missing | `evalEligibleClosure`; C05 steps 7–8 reasons “Claims recorded; end…”; snapshot `stateReason: not_planned`; `pullRequests: {}` |
| C06 | Same as C05, two phantom PRs | Same mechanism on #123 and #273 | Same | C06 steps 8–11 all FAIL files/commits |
| C08 | `budgetExhaustion`; +4 tools, +4 exploratory; still `verified_complete` | After gaps were already satisfied, `collectCodeActions` kept unused candidate files/commits legal; loop hit `maxSteps=12` | Empty legal list is the only Strategy stop; leftover exploratory actions are still legal; Fake Model `final` is ignored | C08 steps 9–12; `collectCodeActions` `expansion`; `MAX_STEPS_REACHED`; `llmCallsSent` unused |
| strategy_exhausted 17/18 | Constrained arm almost never emits Agent `final` | `legalActions.length === 0` → `NO_LEGAL_INVESTIGATION_ACTION` → `strategy_exhausted`; verifier still runs | Stop = “no remaining fetch”, not “evidence is sufficient” or “gap is unresolvable by these tools” | `InvestigationLoopModel` empty-list branch; `agent-loop.ts` `decisionFromBlock`; 8.8.2.1 table: every strategy run except C08 |
| resolution_effect | Cannot be closed by current Candidate Actions once GitHub objects are present | `describeResolutionAlignment` is token overlap on landed text; collectors only fetch PR/files/commits/timeline | SEMANTIC GAP, not MISSING TOOL | `resolution-alignment.ts`; C07 both arms; synthetic `resolution_effect_gap`; C01 wrong landed object |

---

## 9. Conclusions

### 1. Primary root cause

**The Evidence-Gap Strategy’s only stop condition is “no remaining legal investigation action.” It does not judge whether current evidence is already sufficient to end the investigation, or whether the remaining legal actions can close the open gap.**

That single mechanism produces: C01 (useful get_pr removed, useless files/commits remain), C05/C06 (continue after `not_planned`), C08 (continue after the chain is already satisfied), and 17/18 `strategy_exhausted` (empty list, including healthy completions).

### 2. Secondary causes

1. **PR discovery freezes on the first linked candidate.** `collectPullActions` treats a satisfied `resolution_candidate` plus a rejected `resolution_merged` as “no more get_pr”, so later merged PRs become illegal (C01 #284149).
2. **Negative evidence is not a stop.** Rejected `eligible_closure` (`not_planned`) does not clear missing `resolution_*` fetches (C05/C06).
3. **Leftover candidate files/commits stay legal after the gap is closed or after `record_claim`.** `selectPreferredToolCall` then ignores Fake Model `final`. In this evaluation `remainingLlmCalls` does not decrement (`LlmRuntimeGuard` HTTP-only counter), so `applyBudgetFilter` never cuts C08.
4. **`resolution_effect` is descriptive alignment, not a tool-deliverable fact.** Current Candidate Actions cannot close it by fetching more of the same GitHub kinds (C07, synthetic `resolution_effect_gap`, C01 after the wrong landed object).

### 3. What the next problem is (problem definition only)

- Current investigation strategy lacks a mechanism to decide that existing evidence is already sufficient to terminate investigation.
- Current legal-action generation lacks a mechanism to keep unfetched resolution candidates available after an earlier candidate has been observed and rejected as unmerged.
- Current legal-action generation lacks a mechanism to treat explicit non-resolution (`not_planned`) as terminating rather than as “still missing a positive resolution path”.
- Current Candidate Actions have no way to close `resolution_effect` when the needed GitHub objects are already in the graph, because that condition is not a missing tool observation.

No implementation plan is specified here. This phase does not enter Phase 8.8.3.
