# Phase 14.0 Architecture Audit — Agent Output Verification Boundary

Status: audit only. No code, tests, or commits in this phase.

Date: 2026-09-20

Research question:

> 当前已经实现的 Failure Analysis + Recovery 系统，如何回归到最初的 Agent Output Trust Verification 主线上？

This document describes the architecture that exists today. It does not propose an implementation.

---

## 1. Current Architecture

The product path that actually runs is not “Agent Final Output → Claim → Verification”. It is an Investigation-state pipeline. Agent prose is recorded, then ignored for the verdict.

```text
User Task
    |
    v
InvestigationAgent / AgentLoop
    |  read-only GitHub tools
    |  optional record_claim
    |  optional record_resolution_analysis
    |  final NL string (AgentResult.output)
    v
InvestigationState + InvestigationRun
    |  Evidence[]
    |  EvidenceRelation[]
    |  Claim[]              (only if record_claim ran)
    |  ClaimEvidence[]
    |  ResolutionAnalysis[] (analyzer / authored; not a verifier input)
    v
buildInvestigationReport()
    |  one harness-synthesized InvestigationReport
    |  conclusion / polarity / evidenceChain / claimIds
    v
IndependentCompletionVerifier.verify({ task, run, ... })
    |  agentFinalAnswer ignored
    |  agentConclusion ignored
    |  agentClaimedComplete = metadata only
    v
evaluateEvidenceRequirement() on RESOLUTION_CHAIN
    |  issue_identity
    |  issue_closed
    |  eligible_closure
    |  resolution_candidate
    |  resolution_merged
    |  resolution_code_evidence
    |  resolution_effect
    |  claim_support          (vacuous pass if no critical claims)
    |  task.requirements
    v
VerificationResult
    |
    +-- verified_complete ----------------> stop
    |
    +-- not_verified / insufficient_evidence
            |
            v
        FailureAnalyzer
            |
            v
        RecoveryPlanner  (Phase 5 attempt recovery)
            and/or
        ResolutionAnalyzer
            |
            v
        ResolutionGapAnalyzer
            |
            v
        RecoveryIntent + RecoveryPolicy
            |
            v
        ControlledRecoveryLoop
            |  new InvestigationAttempt
            |  adds Evidence only
            v
        IndependentCompletionVerifier.verify({ task, run })
```

What this diagram is **not**:

- It is not an ideal target architecture.
- It is not “Agent said X, therefore verify X”.
- Recovery is already present, but it is an Evidence-supplementation side path. It does not write `VerificationResult`.

### 1.1 Agent output data structures that exist today

There are four different “outputs”. They are not the same object.

| Object | Where | What it is |
|---|---|---|
| `AgentResult.output` | `src/core/types.ts`, written by `AgentLoop` | Final NL / terminal string. Presentation only. |
| `InvestigationReport` | `src/domain/types.ts`, built by `buildInvestigationReport()` | Harness-synthesized investigation summary. |
| `Claim` | `InvestigationRun.claims` | Structured assertion, created only by `record_claim`. |
| `InvestigationAgentReport` | `src/investigation/investigation-report.ts` | Envelope: run + report + claims + evidence + verification + recoveryAttempts. |

`InvestigationReport` fields today:

| Field | Present? | Role |
|---|---|---|
| `conclusion` | yes | One narrative string. From `state.conclusion` (set by `record_claim`) or a status-derived fallback. |
| `claim` | no | Not a field. Claims live on `InvestigationRun.claims`; the report only stores `claimIds`. |
| `confidence` | no | `FailureEvent.confidence` exists. The report has no confidence. |
| `evidence reference` | partial | `evidenceChain: string[]` is the full run evidence ID list, not per-assertion support. |
| `explanation` | partial | `uncertainty` + `openQuestions`. Not a per-claim explanation. |
| `polarity` | yes | One aggregate polarity derived from investigation status + recorded polarity. |
| `resolutionMethod` | yes | Optional “candidate merged PR: #…” string. |

`Claim` fields today:

```text
Claim { id, text, polarity, critical }
ClaimEvidence { claimId, evidenceId, role: supports | contradicts | contextual }
```

There is no claim kind, no normalized predicate, no confidence, and no obligatory link from `AgentResult.output` into `Claim`.

`InvestigationAttempt` stores `agentConclusion` by copying `InvestigationReport.conclusion`. That is the harness summary, not a parse of the Agent’s last message.

### 1.2 What `verify(?)` actually receives

```ts
IndependentCompletionVerifier.verify({
  task,                 // InvestigationTask + EvidenceRequirement[]
  run,                  // Evidence Graph + optional Claim / ClaimEvidence
  agentFinalAnswer?,    // recorded, then ignored
  agentConclusion?,     // accepted on the type, ignored
  agentClaimedComplete? // metadata only → VerificationResult.prematureCompletion
})
```

Source: `src/verification/independent-completion-verifier.ts`.

The investigation loop currently passes `task`, `run`, `agentFinalAnswer = AgentResult.output`, and `agentClaimedComplete` derived from **critical `Claim.polarity === "resolved"`**, not from the NL string. `agentConclusion` is not passed.

Trace events set `agentFinalAnswerIgnored: true` and `agentConclusionIgnored: true`.

The verifier therefore verifies:

| Option | Verified? | Why |
|---|---|---|
| A. Agent claim | only if already structured | `claim_support` reads `run.claims` + `run.claimEvidence`. NL is not a claim. |
| B. Investigation result | yes | RESOLUTION_CHAIN checks the issue → candidate → merge → code path. |
| C. Evidence completeness | yes | `evaluateEvidenceRequirement()` + `task.requirements`. |
| D. Completion condition | yes — this is the primary job | Canonical completion contract on the Evidence Graph. |

Primary answer: **B + C + D**. A is conditional and currently skippable.

Special case in `evalClaimSupport()`:

> If there are no critical claims, `claim_support` is **satisfied**:  
> “No critical claims recorded; completion is judged from independent evidence checks.”

So the system can reach `verified_complete` without ever knowing what the Agent said.

### 1.3 Implicit claim-like objects already in the system

These are easy to confuse with a Claim Extraction layer. They are not that layer.

| Type | Actual job | Is it Agent-output Claim? |
|---|---|---|
| `Claim` | Structured assertion + ClaimEvidence polarity | Yes, but only if `record_claim` ran. |
| `InvestigationReport` | One investigation summary | No. Projection of state. |
| `ResolutionAnalysis` / `ResolutionClaim` | Candidate-evidence hypothesis (file / patch / test signals) | No. Investigation artifact. Comment in types: “not a verifier input”. |
| `ResolutionGap` | Missing evidence localization | No. Failure signal. |
| `VerificationResult` | Independent completion verdict | No. Downstream of claims/evidence. |
| `agentClaimedResolved()` | Regex / claim-polarity heuristic for `premature_completion` | Failure classification only. Not verification. |

`ResolutionAnalysis` is aliased as `ResolutionClaim` in Phase 10.0. That alias means “investigation claim about resolution evidence”, not “normalized Agent final output”.

---

## 2. Missing Boundary Analysis

### 2.1 Does `InvestigationReport` already play the Claim role?

**No.** It is a summary of Investigation state, not a list of atomic assertions.

Reasons:

1. One `conclusion` cannot represent two independent statements.
2. `claimIds` are pointers to objects the Agent (or test driver) already recorded. The report does not create them.
3. `buildInvestigationReport()` can invent a conclusion from `mergedPrs` / status when `state.conclusion` is empty. That is harness narration, not Agent-output normalization.
4. Per-claim support lives on `ClaimEvidence`, which the report does not own.
5. The UI already treats Claims (`ClaimPanel`) and the report conclusion as different surfaces.

`InvestigationReport` is closer to “Investigation outcome card” than to “Claim model”.

### 2.2 Does the Agent Output → Claim → Verification layer exist?

**The Claim type exists. The boundary from Agent Final Output to Claim does not.**

What exists:

```text
Agent is instructed to call record_claim
        |
        v
Claim + ClaimEvidence
        |
        v
claim_support  (one check among many)
```

What does not exist:

```text
Agent Final Output (NL)
        |
        v
Claim Extraction / Normalization
        |
        v
atomic Claim[]
        |
        v
Evidence Verification of those claims
```

There is no extractor, no normalizer, no claim schema beyond `{ text, polarity, critical }`, and no policy that treats unrecorded NL conclusions as unverified claims.

### 2.3 Where the gap sits

```text
                    [implemented]
Investigation tools ──► Evidence Graph ──► IndependentCompletionVerifier
                              ▲
record_claim ──► Claim ───────┘   (optional; vacuous if omitted)

                    [missing]
AgentResult.output ──► ? ──► Claim
InvestigationReport.conclusion ──► ? ──► Claim
```

The gap is specifically **Agent Final Output → Claim Extraction / Normalization**.

It is not:

- a missing Evidence Graph
- a missing IndependentCompletionVerifier
- a missing Recovery stack
- a missing Claim type

### 2.4 What happens to the example NL conclusion

Example Agent output:

```text
Issue #291 has been fixed by PR #284149.
The change has been validated.
```

Desired split:

```text
Claim: Issue resolved by PR
Claim: Validation exists
```

Current handling, step by step:

1. The string lands in `AgentResult.output`.
2. `InvestigationAgent` passes it as `agentFinalAnswer`.
3. `IndependentCompletionVerifier` ignores it.
4. It is **not** split into two `Claim` objects.
5. `InvestigationReport.conclusion` is whatever `record_claim` stored, or a harness fallback such as “has a merged PR candidate; this is an investigation claim, not verification.”
6. `agentClaimedComplete` is true only if a **critical structured claim** already has polarity `resolved`. This NL text alone does not set that flag.
7. `FailureAnalyzer.agentClaimedResolved()` may regex-match `\bresolved\b` on the output. The example says “fixed” / “validated”, so even premature-completion detection can miss it.
8. “Validation exists” is **not** verified as an Agent claim. A nearby but different mechanism exists: `ResolutionAnalyzer` `test_evidence` and `ResolutionGap` `missing_validation_evidence`. Those inspect the Evidence Graph / Resolution Chain, not the Agent sentence.
9. `resolution_effect` checks lexical/structural alignment of landed resolution evidence with the issue. It does not mean “tests ran and passed” and does not mean “the Agent’s validation sentence is true”.

So the architecture **cannot** currently decompose that paragraph into two independently verified claims.

If the test driver path ran instead, `buildDriverClaims()` would emit structured claims such as “PR #N is a candidate resolution” and “PR #N is merged”. Those are investigation-state claims, not an extraction of the Agent’s paragraph, and they still do not include “validation exists” as a critical claim.

### 2.5 Implicit assumption: “the Verifier already knows what the Agent meant”?

**Partially, but not in the way the question frames it.**

The verifier does **not** assume it knows the Agent’s sentences.

It assumes something stronger and different:

> The thing to verify is the **predefined investigation completion contract** (`InvestigationTask.requirements` + `RESOLUTION_CHAIN`), not the Agent’s wording.

Consequences:

- The verifier can accept completion with zero Agent claims.
- The verifier can reject completion even when the Agent claimed success.
- The verifier never asks “did the Agent say validation exists?”
- Therefore Agent-specific assertions that are **stricter or different** from the completion contract are invisible.

There is a second, weaker assumption on the claim path:

> If the Agent did not call `record_claim`, there is no extra Agent meaning to check.

That is the implicit skip of Claim Extraction.

A third assumption exists only in Failure Analysis, not in Verification:

> `agentClaimedResolved()` can infer “Agent claimed resolved” from critical claims **or** from the word `resolved` in the final string.

That heuristic is not a Claim model and is not the verification authority.

### 2.6 Effect of the gap

| Effect | Detail |
|---|---|
| Original mainline drifted | Design spec (`design.md`) is Agent Conclusion → Independent Verification. Runtime is Evidence Graph → Completion Contract. |
| False-completion measurement is incomplete | `falseCompletionRate` / `prematureCompletion` need structured critical resolved claims, or a `resolved` regex. Free-form “fixed / validated” can evade both. |
| Recovery optimized the wrong object | Phases 10–13 localize **missing resolution evidence**, not **unsupported Agent assertions**. |
| Two claims collapse to one check | “fixed by PR” and “validated” cannot fail independently as Agent claims. |
| Vacuous `claim_support` | Missing claims look like “nothing to support”, not “unverified Agent output”. |

The Recovery stack is not wrong. It is just not the Agent-output trust boundary.

---

## 3. Existing Components Mapping

| Component | Current Responsibility | Should Change? |
|---|---|---|
| `InvestigationAgent` | Bounded investigation loop. Calls tools, optionally `record_claim`, writes Evidence, then calls the verifier. Copies `report.conclusion` onto the attempt as `agentConclusion`. | Keep the loop. Later: stop treating NL final as semantically empty if a Claim-capture boundary is added. Do not let the Agent write `VerificationResult`. |
| `InvestigationReport` | Harness-built summary: one conclusion, polarity, evidence ID list, claim ID list, uncertainty, open questions. | Keep as presentation / attempt snapshot. Do **not** promote it to the Claim model. |
| `EvidenceGraph` | First-class Evidence + Relation + Claim + ClaimEvidence. Source of truth for requirement evaluation. | **No.** Recovery and any future Claim capture may only add Evidence / bind existing IDs. |
| `IndependentCompletionVerifier` | Sole completion authority. Orchestrates `RESOLUTION_CHAIN` + `evaluateEvidenceRequirement()`. Ignores Agent prose. | **No change to authority or verdict rules in this audit.** A later phase may feed it more `Claim` objects; it must not grow a second judging path. |
| `ResolutionAnalyzer` | Deterministic candidate-evidence signals (`file_scope_alignment`, `patch_intent_alignment`, `test_evidence`). Produces `ResolutionAnalysis`. Never `VERIFIED_COMPLETE`. | **No.** This is investigation-side evidence quality, not Agent-output claim extraction. |
| `RecoveryLoop` (`ControlledRecoveryLoop`) | Budgeted new attempt. Executes RecoveryIntent. Adds Evidence only. Re-runs analyzer + gap + verifier. Does not mutate parent attempt verification. | **No.** Must remain Evidence supplementation. Must not become the product mainline or write verification. |

Related components, for the same question:

| Component | Current Responsibility | Duplicate of Claim Verification? |
|---|---|---|
| `ResolutionGapAnalyzer` | Why the Resolution Chain cannot yet support further verification. Emits `ResolutionGap`. | No. Localizes missing evidence types. |
| `RecoveryIntent` | Maps gaps to a missing capability, not a tool. | No. |
| `RecoveryPolicy` | Ranks RecoveryDecision. Does not execute, does not create Evidence, does not call the verifier. | No. |
| `FailureAnalyzer` | Classifies investigation failure, including `premature_completion`. | Touches Agent output only as a heuristic. Not a claim verifier. |
| `record_claim` tool | The only production writer of `Claim` + `ClaimEvidence`. | This is the current (optional) claim capture path. |

---

## 4. Proposed Phase 14 Direction

Proposal only. Do not implement in this phase.

### 4.1 Mainline to restore

The intended product mainline is Agent Output Trust Verification. Recovery stays a side path.

```text
Agent Final Output
        |
        v
Claim Capture / Normalization     ← the missing boundary
        |
        v
Claim + ClaimEvidence
        |
        v
Evidence Graph
        |
        v
IndependentCompletionVerifier     ← unchanged authority
        |
        +-- pass --> done
        |
        +-- fail / insufficient
                |
                v
            Failure
                |
                v
            Resolution Gap / Recovery Intent
                |
                v
            Recovery (add Evidence only)
                |
                v
            Re-verification
```

This is the structure asked about:

```text
Claim → Verification → Failure → Gap → Recovery
```

Not:

```text
Gap → Recovery → (implicitly hope the Agent was right)
```

and not:

```text
Agent NL → LLM Judge → VerificationResult
```

### 4.2 What the missing layer should be (and should not be)

Recommended name: **Claim Capture / Normalization**, not “Claim Verifier”.

It should:

1. Make Agent assertions explicit as existing `Claim` objects.
2. Bind them to existing Evidence IDs via existing `ClaimEvidence`.
3. Let the **existing** `claim_support` / `unsupportedClaimIds` path do the checking.
4. Remain deterministic. No LLM Judge. No embedding. No semantic search.

It should not:

1. Produce `VerificationResult`.
2. Re-implement `RESOLUTION_CHAIN`.
3. Replace `ResolutionAnalyzer`.
4. Infer “validated” from PR title/body prose.
5. Execute recovery.

### 4.3 Two allowable directions (choose later)

**Direction A — Strengthen structured capture (preferred, lower risk)**

- Treat `record_claim` as the only legal claim source.
- Treat Agent NL that asserts completion without recorded claims as unstructured / untrusted output.
- Optionally classify that as a first-class failure (`premature_completion` or a narrower “unstructured completion”) instead of a vacuous `claim_support` pass.
- Do not parse English/Chinese sentences with an LLM.

This closes the trust gap without inventing extraction.

**Direction B — Deterministic normalization of already-structured fields**

- Normalize `record_claim` text / polarity into a small closed set of claim kinds, for example:
  - `issue_resolved_by_pr`
  - `pr_merged`
  - `validation_observed`
- Map those kinds onto **existing** EvidenceRequirements / Resolution Chain nodes.
- Still no NL parser as authority.

Direction B is optional sugar on top of A. It is not a second verifier.

**Rejected now**

- LLM extraction of claims from the final paragraph.
- Using `InvestigationReport.conclusion` as if it were already a Claim list.
- Reusing `ResolutionAnalysis` as the Agent-output claim model.
- Making Recovery decide whether a claim is true.

### 4.4 Modules to add vs keep

**Candidate new module (later, after confirmation)**

| Module | Job |
|---|---|
| Claim Capture / Normalization boundary | Turn structured Agent assertions (and, if Direction A is chosen, the *absence* of claims after an NL completion) into `Claim[]` that the existing graph can hold. |

This can be a thin function beside `record_claim` / `buildInvestigationReport()`. It does not need a new verifier class.

**Keep unchanged**

- `IndependentCompletionVerifier`
- `evaluateEvidenceRequirement()` / `claim_support`
- Evidence Graph invariants
- `ResolutionAnalyzer`
- `ResolutionGapAnalyzer`
- `RecoveryIntent` / `RecoveryPolicy` / `ControlledRecoveryLoop`
- `InvestigationReport` as summary
- Ground Truth, GitHub provider, retrieval ranking

**Must not add**

- A second completion verifier
- Vector retrieval / semantic search
- RL
- Self-healing
- LLM-as-judge over Agent conclusions

### 4.5 How this relates to Recovery (non-duplication rule)

| Layer | Object it talks about | Output |
|---|---|---|
| Claim Capture | What the Agent asserted | `Claim` + `ClaimEvidence` |
| IndependentCompletionVerifier | Whether Evidence supports the completion contract and recorded claims | `VerificationResult` |
| ResolutionAnalyzer | Whether candidate evidence looks aligned | `ResolutionAnalysis` |
| Gap Analyzer | Which evidence types are still missing | `ResolutionGap` |
| Recovery | How to fetch more Evidence | new Evidence, then re-verify |

They compose. They do not compete.

If a captured claim is “validation exists” and the graph has no validation evidence:

1. `claim_support` / existing requirement evaluation fails or is insufficient.
2. Gap Analyzer may already emit `missing_validation_evidence`.
3. Recovery may fetch more Evidence.
4. Only the verifier may change the verdict.

Recovery still cannot “mark the claim true”.

### 4.6 Policy question that must be decided before coding

Should empty critical claims still vacuous-pass `claim_support`?

| Option | Meaning |
|---|---|
| Keep current | Completion = Evidence Graph contract only. Agent silence is not a defect. |
| Tighten | Agent NL completion without `record_claim` is an unsupported / premature output. Completion contract still applies. |

This audit does not pick the option. It only records that the vacuous pass is the main reason the original “verify what the Agent said” mainline is currently optional.

---

## 5. Risk Analysis

| Risk | Why it appears now | Guard |
|---|---|---|
| Duplicate verifier | A “Claim Verification Layer” is easy to implement as a second `verify()`. | Capture writes `Claim`. Only `IndependentCompletionVerifier` writes `VerificationResult`. |
| Break Evidence Graph | New claim kinds might invent Evidence or treat GitHub bodies as support. | Bind existing Evidence IDs only. GitHub prose stays `external_untrusted`. |
| Recovery becomes the mainline | Phases 10–13 already dominate recent work. Adding claim logic inside the loop would deepen that drift. | Claim capture happens **before** verification. Recovery remains “add Evidence, then re-verify”. |
| LLM Judge | Parsing “The change has been validated.” looks like an NLP task. | No LLM extraction. No judge model. Direction A does not parse NL; Direction B only normalizes structured fields. |
| Collapse Report / ResolutionAnalysis into Claim | Both already look claim-like. | Keep `InvestigationReport` as summary. Keep `ResolutionAnalysis` as investigation artifact. |
| Semantic / vector / RL creep | “Understand what the Agent meant” invites retrieval and scoring. | Out of scope. Closed claim kinds or structured tool input only. |
| Recovery writes the verdict | Loop already calls `verifier.verify()` after adding Evidence. A future shortcut could copy status onto `RecoveryAttempt`. | Current invariant holds and must keep holding: RecoveryAttempt has no authority field; parent attempt verification is not mutated. |

### 5.1 Invariants this phase must keep

1. `IndependentCompletionVerifier` is the only completion authority.
2. Evidence outranks Agent conclusion.
3. Recovery may only supplement Evidence.
4. Recovery must not directly change `VerificationResult` (it may only trigger a new independent `verify()` on the updated graph).
5. No vector retrieval, semantic search, RL, or self-healing.

### 5.2 What this audit is not saying

- It is not saying Claim should be invented from scratch. `Claim` already exists.
- It is not saying Resolution / Gap / Recovery were a mistake. They are the correct **failure-localization** stack once verification has a target.
- It is not saying the verifier should start reading Agent prose.
- It is not saying Phase 14 should implement extraction.

It is saying the trust boundary is currently:

```text
Evidence Graph + optional structured Claim  →  Completion Contract
```

and the original research boundary was:

```text
Agent Conclusion  →  Evidence-backed Verification
```

Those overlap only when the Agent (or test driver) actually records claims. The NL path is the hole.

---

## Audit answers (compact)

1. **Does `InvestigationReport` already act as Claim?**  
   No. It is a single harness summary. Atomic claims are `Claim` on `InvestigationRun`.

2. **What does `IndependentCompletionVerifier` verify?**  
   Investigation completion conditions on the Evidence Graph, plus support for claims that were already recorded. Not Agent NL.

3. **Does the system assume the verifier already knows what the Agent meant?**  
   It assumes a predefined completion contract. It does **not** reconstruct Agent meaning. Missing claims are treated as “nothing extra to check”.

4. **Can “fixed by PR #284149” + “validated” be split and verified?**  
   Not today. The paragraph is ignored by the verifier. Nearby validation machinery (`test_evidence`, `missing_validation_evidence`, `resolution_effect`) inspects Evidence, not that sentence.

5. **Is an independent Claim abstraction needed?**  
   A new competing type is not needed. A **Claim Capture / Normalization boundary** in front of the existing `Claim` type is the missing piece. `InvestigationReport` and `ResolutionAnalysis` should not be reused for that job.

6. **Does Claim Verification duplicate Recovery?**  
   No, if it stays upstream. Correct stack: Claim → Verification → Failure → Gap → Recovery (Evidence only) → Re-verification.

---

## Completion

This phase stops here.

Waiting for architecture confirmation before any implementation, tests, or commits.
