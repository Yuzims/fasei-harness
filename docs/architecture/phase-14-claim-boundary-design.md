# Phase 14.0 Claim Boundary Design Review

Status: design only. No code, tests, schema, or commits in this phase.

Date: 2026-09-20

Related audit: [`phase-14-output-verification-audit.md`](./phase-14-output-verification-audit.md)

Research constraint:

> Agent conclusion is not truth. Agent output must pass Evidence-based Verification.

This document decides how Agent Output enters the **existing** verification pipeline. It does not add a second verifier.

Invariants this design must keep:

1. Evidence is the only source of fact.
2. Agent Claim is not fact.
3. `IndependentCompletionVerifier` is the final judge.
4. Recovery only supplements Evidence.
5. No LLM Judge, semantic retrieval, RL, or self-healing.

Forbidden in later implementation as well:

- `AgentClaim`
- `ClaimVerifier`
- `ClaimGraph`

---

## 1. Current Architecture

The runtime path today is an Investigation-state pipeline. Structured `Claim` already exists, but Agent final output is not required to become one.

```text
User Task
    |
    v
InvestigationAgent / AgentLoop
    |  read-only GitHub tools          → Evidence + EvidenceRelation
    |  optional record_claim           → Claim + ClaimEvidence
    |  optional record_resolution_analysis → ResolutionAnalysis (not verifier input)
    |  final NL string                 → AgentResult.output (presentation)
    v
InvestigationState + InvestigationRun
    |  evidence[]
    |  relations[]
    |  claims[]            (empty unless record_claim / test driver ran)
    |  claimEvidence[]
    |  resolutionAnalyses[]
    v
buildInvestigationReport()
    |  harness-synthesized InvestigationReport
    |  conclusion / polarity / evidenceChain / claimIds
    v
IndependentCompletionVerifier.verify({ task, run, agentFinalAnswer, agentClaimedComplete })
    |  agentFinalAnswer ignored
    |  agentConclusion ignored
    |  agentClaimedComplete = metadata only
    |
    +-- Completion Contract (RESOLUTION_CHAIN + task.requirements)
    |     issue_identity
    |     issue_closed
    |     eligible_closure
    |     resolution_candidate
    |     resolution_merged
    |     resolution_code_evidence
    |     resolution_effect
    |     claim_support          ← vacuous pass if no critical Claim
    |     task.requirements
    v
VerificationResult
    |
    +-- verified_complete → stop
    |
    +-- not_verified / insufficient_evidence
            |
            v
        FailureAnalyzer
            |
            +-- Phase 5 RecoveryPlanner → new InvestigationAttempt
            |
            +-- ResolutionAnalyzer
                    |
                    v
                ResolutionGapAnalyzer
                    |
                    v
                RecoveryIntent + RecoveryPolicy
                    |
                    v
                ControlledRecoveryLoop
                    |  adds Evidence only
                    v
                IndependentCompletionVerifier.verify({ task, run })
```

Code anchors:

| Object | File | Role today |
|---|---|---|
| `Claim` | `src/domain/types.ts` | `{ id, text, polarity, critical }` |
| `ClaimEvidence` | same | `{ claimId, evidenceId, role }` |
| `createClaim` | `src/domain/factories.ts` | Default `critical: true` |
| `record_claim` | `src/investigation/investigation-tools.ts` | Only production writer of Claim + ClaimEvidence |
| `claimSupportStatus` | `src/domain/evidence-graph.ts` | `supported` / `unsupported` / `contradicted` |
| `evalClaimSupport` | `src/domain/requirement-eval.ts` | `claim_support` requirement |
| `IndependentCompletionVerifier` | `src/verification/independent-completion-verifier.ts` | Sole completion authority |
| `InvestigationReport` | `src/investigation/investigation-report.ts` | Harness summary, not a Claim list |
| `ControlledRecoveryLoop` | `src/investigation/controlled-recovery-loop.ts` | Evidence supplementation, then re-verify |

### 1.1 What Claim is today

```text
Claim { id, text, polarity, critical }
ClaimEvidence { claimId, evidenceId, role: supports | contradicts | contextual }
```

There is no `kind`, no `source`, no `origin`, no confidence, no obligatory link from `AgentResult.output`.

`record_claim`:

- Requires `text`, `polarity`, and `evidenceIds`.
- Rejects unknown Evidence IDs. It cannot invent Evidence.
- Defaults `critical` to true unless the caller sets `critical: false`.
- May also write `state.conclusion` / `state.polarity` / unresolved questions.
- Tool description already says it does not verify and cannot set `VERIFIED_COMPLETE`.

`claim_support` (`evalClaimSupport`):

- Orphan `ClaimEvidence` → rejected.
- **Zero critical claims → satisfied** (“completion is judged from independent evidence checks”).
- Critical `resolved` / `partial` claims need a `supports` link and no `contradicts` link / graph `contradicts` edge.
- Critical `unresolved` / `unknown` claims are not required to be supported.

`VerificationResult` already carries `unsupportedClaimIds`. The verifier already reads `run.claims` and `run.claimEvidence` through `graphFromRun(run)`. Claims are not a missing verifier input. They are a skippable Agent input.

### 1.2 What Claim is not today

| Nearby object | Actual job | Is it Claim? |
|---|---|---|
| `Evidence` | Observation with provenance. The only fact. | No |
| `InvestigationReport` | One harness-synthesized summary card | No |
| `AgentResult.output` | Final NL / terminal string | No |
| `ResolutionAnalysis` / `ResolutionClaim` | Candidate-evidence hypothesis. Comment: not a verifier input | No |
| `ResolutionGap` | Missing resolution-evidence localization | No |
| `VerificationResult` | Independent completion verdict | No |

`ResolutionClaim` is an alias for `ResolutionAnalysis`. It means “investigation claim about resolution evidence”, not Agent-output Claim.

---

## 2. Problem Definition

### 2.1 Why Agent Output does not enter Verification

The original product boundary is:

```text
Agent Output → Structured Claim → Evidence-backed Verification
```

The implemented boundary is:

```text
Evidence Graph + Completion Contract → Verification
         ▲
optional record_claim ──┘
```

Three objects are easy to confuse, and only one of them is a Claim:

```text
AgentResult.output          NL final. Ignored by verifier.
InvestigationReport         Harness narration. Pointers only (claimIds).
Claim                       Structured assertion. Created only if record_claim ran.
```

If the Agent never calls `record_claim`, `claim_support` vacuous-passes. The system can reach `verified_complete` without knowing what the Agent said.

That is the boundary gap. It is not a missing Evidence Graph, verifier, or Recovery stack.

### 2.2 Current Claim responsibility — can it be reused?

**Yes. Reuse existing `Claim`. Do not introduce a parallel type.**

Current `Claim` already means:

> A structured, polar assertion that Evidence may support, contradict, or leave unsupported.

It is **already** the Agent-assertion type when `record_claim` runs.

It is **not** currently all of the following, and it should not become them:

| Candidate meaning | Current reality | Keep? |
|---|---|---|
| Agent assertion | Yes, if `record_claim` ran | Yes — this is the intended job |
| Investigation observation | No. Observations are `Evidence` | Must not absorb this |
| Internal reasoning artifact | No. That is `ResolutionAnalysis` / NL | Must not absorb this |
| Harness completion summary | No. That is `InvestigationReport` | Must not absorb this |
| Verification verdict | No. That is `VerificationResult` | Must not absorb this |

The type is thin on purpose: `{ text, polarity, critical }` plus optional Evidence links. That is enough for `claim_support`. The defect is capture policy, not the schema.

The test driver (`buildDriverClaims`) already restates some Investigation-state facts as Claims (“PR #N is merged”). That is a compatibility shim for the Agent stand-in. It is a duplication risk, not a reason to add `source: investigation`. Formalizing investigation-sourced Claims would turn Claim into a second Evidence system.

### 2.3 Agent Output Boundary — are report fields already Agent Claims?

`InvestigationReport` fields today:

| Field | What it actually is | Agent Claim? |
|---|---|---|
| `conclusion` | `state.conclusion` from `record_claim`, or a harness fallback such as “has a merged PR candidate; this is an investigation claim, not verification.” | No. One narrative string, often harness-written |
| `polarity` | `derivePolarity(status, state.polarity)` — investigation status can override recorded polarity | No. Aggregate projection |
| `evidenceChain` | Every Evidence ID on the run | No. Not per-assertion support |
| `claimIds` | Pointers to `run.claims` | No. The report does not create Claims |

`InvestigationAttempt.agentConclusion` copies `InvestigationReport.conclusion`. That is still the harness summary, not a parse of the Agent’s last message.

`agentClaimedComplete` is true only if a **critical structured Claim** already has polarity `resolved`. NL text such as “fixed” / “validated” does not set it. `FailureAnalyzer.agentClaimedResolved()` may regex-match `\bresolved\b` on the final string; that is failure classification, not verification.

What is missing:

1. A capture rule: completion-facing Agent output must exist as `Claim[]` before `verify()`.
2. A policy for the case “Agent produced a final answer and recorded zero Claims”.
3. A prohibition on treating `InvestigationReport.conclusion` as that Claim list.

The report remains an investigation outcome card. Atomic assertions stay on `InvestigationRun.claims`.

---

## 3. Claim Boundary Proposal

### 3.1 Claim vs Completion Contract

These answer different questions. They must not be merged.

```text
Completion Contract
    “Did this Investigation satisfy the system’s completion conditions?”
    Object: InvestigationTask.requirements + RESOLUTION_CHAIN
    Authority: IndependentCompletionVerifier
    Fact source: Evidence Graph

Claim
    “What verifiable fact did the Agent assert to the outside?”
    Object: Claim + ClaimEvidence
    Authority: still IndependentCompletionVerifier (claim_support)
    Fact source: still Evidence Graph
```

A Claim can be stricter, weaker, or simply different from the contract. Example:

- Contract may pass `resolution_merged` from PR merge Evidence.
- Agent may also assert “the change has been validated.”
- Those are two questions. Only the first is currently checked unless a Claim was recorded for the second.

They already share one verifier. They must keep sharing one verdict object: `VerificationResult`.

### 3.2 How both enter the Verifier

**Current (Claim optional / often absent):**

```text
Completion Contract
        |
        v
    Verifier
```

`claim_support` is on the contract, but with zero critical Claims it does not constrain the verdict.

**Future (Claim captured, then both judged together):**

```text
Claim
        |
        +
        |
Completion Contract
        |
        v
    Verifier
```

At the call-site level this is still:

```text
record_claim / capture boundary
        |
        v
InvestigationRun.claims + InvestigationRun.claimEvidence
        |
        +  InvestigationRun.evidence + relations
        |  InvestigationTask.requirements
        v
IndependentCompletionVerifier.verify({ task, run })
        |
        +-- RESOLUTION_CHAIN including claim_support
        +-- task.requirements
        v
VerificationResult
```

Do **not** change the signature to `verify(task, run, claims, evidence)`.

Claims and Evidence already live on `run`. A second claims argument would create two sources of truth, force every test call site to choose which list is real, and invite a rewrite of `IndependentCompletionVerifier`. The existing path is:

```ts
IndependentCompletionVerifier.verify({
  task,
  run,                     // already contains claims, claimEvidence, evidence, relations
  agentFinalAnswer?,       // recorded, ignored for verdict
  agentConclusion?,        // accepted on the type, ignored
  agentClaimedComplete?,   // metadata → prematureCompletion only
})
```

### 3.3 The missing layer is Capture, not Extraction

Recommended name: **Claim Capture Boundary**.

It should:

1. Make Agent assertions explicit as existing `Claim` objects.
2. Bind them to **existing** Evidence IDs via existing `ClaimEvidence`.
3. Let existing `claim_support` / `unsupportedClaimIds` do the checking.
4. Treat “final NL without `record_claim`” as unstructured / untrusted output, not as a hidden Claim list.
5. Stay deterministic.

It should not:

1. Parse `AgentResult.output` with an LLM.
2. Promote `InvestigationReport.conclusion` into `Claim[]`.
3. Produce `VerificationResult`.
4. Re-implement `RESOLUTION_CHAIN`.
5. Execute Recovery.
6. Invent Evidence from GitHub prose.

The arrow “Agent Output → Structured Claim” is realized by **requiring the completion-facing Agent output to be the `record_claim` tool call**, not by transforming the final paragraph.

```text
Legal capture
─────────────
Agent calls record_claim(text, polarity, evidenceIds)
        |
        v
Claim + ClaimEvidence
        |
        v
Existing claim_support

Illegal capture
───────────────
AgentResult.output  ──LLM extract──► Claim
InvestigationReport.conclusion ──promote──► Claim
ResolutionAnalysis ──reuse as──► Agent Claim
```

### 3.4 Claim lifecycle

```text
Claim Created
    ↓
Evidence Linked
    ↓
Verification
    ↓
Supported / Unsupported / Contradicted
    ↓
Failure Localization
    ↓
Recovery
    ↓
Re-verification
```

| Stage | Exists today? | Where | Gap |
|---|---|---|---|
| Claim Created | Yes, optional | `record_claim` → `state.addClaim` | Not obligatory after Agent final output |
| Evidence Linked | Yes | `ClaimEvidence` via `createClaimEvidenceBinding` | Agent may pass an empty `evidenceIds` array; then the Claim exists but is unsupported |
| Verification | Yes | `evalClaimSupport` + `buildVerificationResult` | Vacuous pass when no critical Claims |
| Supported / Unsupported | Yes | `ClaimSupportStatus`, `unsupportedClaimIds` | Only computed for recorded critical `resolved` / `partial` Claims |
| Failure Localization | Partial | `FailureAnalyzer` copies `unsupportedClaimIds` into `premature_completion`. `ResolutionGapAnalyzer` localizes **resolution Evidence**, not Agent Claims | Missing-Claim is not a `ResolutionGap` (and must not become one) |
| Recovery | Yes, Evidence-only | Phase 5 planner + `ControlledRecoveryLoop` | Loop is driven by Resolution Gaps. It copies `claimIds`; it does not create, edit, or delete Claims. `resetEvidence` in `applyRecoveryPlan` currently **clears** Claims — that is a Claim-lifecycle hazard, not a recovery feature |
| Re-verification | Yes | `verifier.verify({ task, run })` after new Evidence | Must remain the only way a verdict changes |

What to add later: Capture obligation + a distinct handling of “no Claim recorded”. What not to add: a Claim editor, a Claim graph, or Recovery that rewrites Claim text / polarity / support status.

Two different gaps must stay distinct:

```text
Capture gap
    Agent finished without a structured Claim.
    Recovery cannot fix this by fetching GitHub data.
    Recovery must not call record_claim to invent the assertion.
    This is a capture-boundary failure, then (if the Agent continues) a new investigation attempt may record_claim.

Support gap
    Claim exists; supporting Evidence is missing or contradictory.
    Recovery may fetch more Evidence.
    Re-verification may then change claim_support.
    Recovery still cannot mark the Claim true.
```

### 3.5 Do we need a new Claim type or `source` / `origin`?

**No new type.** Reuse `Claim`.

**Do not add `source: agent_output | investigation`.**

That discriminator would invite storing investigation observations on Claim. Observations already have a type: `Evidence`. `source: investigation` is how Claim becomes a second Evidence system (Risk 2).

**Do not add `origin` in 14.1.** All Claims should be treated as Agent-facing assertions. The test driver is the Agent stand-in; its `record_claim` calls are still Claims, not harness facts.

**Optional later (only if a later phase proves a real mix-up):**

```text
origin?: "agent_tool" | "test_driver"
```

That is provenance of the **writer**, not a second meaning of Claim. It must never include `system_generated_from_report` or `extracted_from_nl`.

If “no Claim was captured” needs a signal, that signal is a **verification / capture check outcome**, not a synthetic Claim whose text is “the Agent claimed nothing.”

### 3.6 Verifier — minimal modification

Keep:

```ts
verify({ task, run, agentFinalAnswer?, agentConclusion?, agentClaimedComplete? })
```

Do not rewrite `IndependentCompletionVerifier`. It should remain the orchestrator of `RESOLUTION_CHAIN` + `evaluateEvidenceRequirement()`.

Minimal intrusion, in order of invasiveness:

| Change | Where | Why it is small |
|---|---|---|
| Capture boundary function | Beside `record_claim` / `toAgentReport()`, not inside the verifier class | Writes or detects `Claim[]`. Does not write `VerificationResult` |
| Stop treating empty critical Claims as an automatic pass **when a completion-facing Agent output exists** | `evalClaimSupport` in `requirement-eval.ts` | Existing check, existing `VerificationCheck` id `claims-supported` |
| Or, if mixing “capture” and “support” in one evaluator is too loaded: add `claim_capture` as one `EvidenceRequirementCondition` | `RESOLUTION_CHAIN` spec list + one evaluator | New check, same verifier class, same verdict builder |
| Keep ignoring Agent NL for the verdict | already true | Do not start reading `agentFinalAnswer` as meaning |

Preferred 14.2 behavior:

- `claim_support` remains “are recorded critical Claims supported without contradiction?”
- Capture failure is either:
  - `claim_support` outcome `missing` when a completion-facing output exists and critical Claims are empty, or
  - a sibling `claim_capture` check with the same `VerificationResult` destination.

Either way, `IndependentCompletionVerifier.verify` stays one function, one class, one verdict.

`agentClaimedComplete` can later be derived from captured Claims as today. It must not become a back door that lets NL complete the run.

### 3.7 Recovery relationship

Target chain:

```text
Claim
    ↓
Verification
    ↓
Failure
    ↓
Gap
    ↓
Recovery
    ↓
New Evidence
    ↓
Verification
```

Existing pieces:

| Component | Keep? | Change needed? |
|---|---|---|
| Resolution Analyzer | Yes | No. Candidate-evidence quality, not Agent-output capture |
| Resolution Gap Analyzer | Yes | No new `missing_claim` gap type. That would confuse Capture gap with Evidence gap |
| Recovery Intent / Policy | Yes | No. Still maps Evidence gaps to a missing capability |
| Controlled Recovery Loop | Yes | No write path for Claim / ClaimEvidence / VerificationResult. Continue to copy `claimIds` only |
| Phase 5 FailureAnalyzer / RecoveryPlanner | Yes | May **read** `unsupportedClaimIds`. Must not rewrite Claims. `resetEvidence` clearing Claims is a later caution, not a 14.0 code change |

Rules Recovery must keep:

- May add Evidence.
- May trigger a new independent `verify()` on the updated graph.
- Must not modify Claim text, polarity, or `critical`.
- Must not modify `ClaimEvidence` roles to “make the Claim true.”
- Must not modify `VerificationResult` in place.
- Must not call `record_claim` to backfill what the Agent failed to assert.
- Must not bypass the verifier.

If a captured Claim is “validation exists” and the graph has no validation Evidence:

1. `claim_support` fails or is insufficient.
2. Gap Analyzer may already emit `missing_validation_evidence` from the Resolution Chain.
3. Recovery may fetch test/patch Evidence.
4. Only the next `verify()` may change the verdict.

---

## 4. Component Impact

| Component | Change Needed | Reason |
|---|---|---|
| **Claim** | Reuse. No new type. No `source: investigation`. No 14.1 schema field required | Already the Agent-assertion model. Extending meaning would duplicate Evidence |
| **Evidence Graph** | No structural change. Capture may only bind existing Evidence IDs | Evidence remains the only fact. ClaimEvidence is a link, not a new fact kind |
| **Verifier** | Do not rewrite. Do not add `claims` / `evidence` parameters. Later: tighten empty-claim `claim_support` (or add sibling `claim_capture`) in `evaluateEvidenceRequirement` | Claims already sit on `run`. Authority must stay singular |
| **Recovery** | No new recovery product. Do not localize “missing Claim” as a ResolutionGap. Do not let the loop write Claims | Recovery only supplements Evidence, then re-verifies |
| **Agent Output** | Capture boundary: completion-facing output must go through `record_claim`. `InvestigationReport` stays a summary. `AgentResult.output` stays untrusted NL | This is the actual missing edge |

Related, unchanged in role:

| Component | Change Needed | Reason |
|---|---|---|
| `record_claim` | Keep as the only legal Claim writer | Already the capture API |
| `InvestigationReport` | Keep as presentation / attempt snapshot | `conclusion` / `polarity` / `evidenceChain` / `claimIds` are not Claims |
| `ResolutionAnalysis` | Keep as investigation hypothesis | Not Agent-output Claim, not verifier input |
| FailureAnalyzer | Later may consume capture-boundary signals; no new judge | Already reads `unsupportedClaimIds` for `premature_completion` |

---

## 5. Implementation Plan

Do not start these phases until this design is confirmed.

### Phase 14.1 — Capture Boundary (no verdict change)

**Goal:** Make the Agent Output → Claim edge explicit without changing completion outcomes.

**Modify:**

- A small capture-boundary helper next to `record_claim` / report assembly.
- Trace / report metadata that records: Claims present or absent after Agent final.
- Tests for: `record_claim` produces Claim; NL final without `record_claim` is “not captured”; `InvestigationReport.conclusion` is not treated as Claim.

**Do not modify:**

- `Claim` schema
- `evalClaimSupport` vacuous pass
- `IndependentCompletionVerifier` check list or verdict rules
- Recovery loop, Gap Analyzer, Resolution Analyzer
- Evidence Graph invariants

**Verify:**

- Existing `verified_complete` fixtures still pass (including vacuous `claim_support`).
- Capture-absent is observable, but does not yet fail the run by itself.
- No LLM, no NL parser, no new verifier class.

### Phase 14.2 — Wire Capture into Existing `claim_support`

**Goal:** Empty critical Claims no longer look like “nothing to check” when the Agent produced a completion-facing output.

**Modify (pick one, not both):**

1. Preferred small change: `evalClaimSupport` returns `missing` instead of `satisfied` when critical Claims are empty **and** a completion-facing Agent output / captured-complete signal exists.
2. Alternative: add `claim_capture` as one more `RESOLUTION_CHAIN` condition, still evaluated by `evaluateEvidenceRequirement`, still folded into the same `VerificationResult`.

Also in 14.2:

- Keep `verify({ task, run, ... })`.
- Keep ignoring NL for semantic content.
- Update the specific verifier / requirement tests that encode the current vacuous pass.
- Test driver already calls `record_claim`; it should remain green if capture is present.

**Do not modify:**

- Verifier class structure / second `verify()` path
- Recovery writers
- Claim text schema (`source`, `AgentClaim`, kinds unless a closed kind list is separately approved)
- LLM extraction

**Verify:**

- Run with Evidence contract passing and zero Claims + Agent final output → not `verified_complete`.
- Run with Evidence contract passing and supported critical Claims → `verified_complete` unchanged.
- Contradicted Claims still `not_verified`.
- Full suite: expect a bounded set of failures only where tests relied on vacuous `claim_support`. Fix those tests to record Claims or to assert the new capture miss. Do not blanket-weaken the check.

### Phase 14.3 — Failure Localization Alignment (Recovery still Evidence-only)

**Goal:** Unsupported or missing Claims flow through Failure → (Evidence) Gap → Recovery → Re-verify without Recovery owning Claim.

**Modify:**

- FailureAnalyzer may distinguish capture-miss vs support-miss using existing `unsupportedClaimIds` plus 14.1 capture metadata.
- Phase 5 `continue_investigation` may still allow the **Agent** to call `record_claim` on a new attempt (Agent acting, not Recovery writing).
- Document / later tighten: `ControlledRecoveryLoop` must not invoke `record_claim`; `resetEvidence` must not be used as a quiet Claim editor.

**Do not modify:**

- Resolution Gap types (no `missing_claim`)
- RecoveryPolicy ranking object
- Verifier internals beyond 14.2
- Claim objects during recovery execution
- Parent attempt `VerificationResult`

**Verify:**

- Support gap: Recovery adds Evidence, parent attempt verification is unchanged, new `verify()` may pass `claim_support`.
- Capture gap: Recovery does not create a Claim; run does not become `verified_complete` by fetching more GitHub data alone.
- RecoveryAttempt still has no authority field.
- No path writes `VerificationResult` except `IndependentCompletionVerifier.verify()`.

---

## 6. Risk Analysis

### Risk 1 — Claim duplicates the Completion Contract

**Why it appears:** `claim_support` is already a `RESOLUTION_CHAIN` node. Test-driver Claims often restate “PR merged” / “candidate resolution”, which `resolution_merged` already checks.

**Guard:**

- Contract checks Evidence Graph topology (issue → candidate → merge → code → effect).
- Claim checks **what the Agent asserted**, linked to Evidence, not a second copy of the chain.
- Do not auto-generate Claims from `RESOLUTION_CHAIN` nodes.
- Do not add `source: investigation`.
- `buildDriverClaims` stays a test-actor shim in 14.1/14.2; do not promote it to a harness Claim factory for live Agents.

If a Claim merely repeats “PR is merged”, both checks can pass together. That is overlap, not a second verdict. The valuable Claims are Agent assertions the contract does not already ask, or the same assertion used to detect premature completion.

### Risk 2 — Claim becomes another Evidence system

**Why it appears:** Claim has text, polarity, and Evidence links. It looks like a labeled observation.

**Guard:**

- Evidence has provenance, kind, trust, payload. Claim does not.
- Claim cannot be created from GitHub bodies.
- `record_claim` cannot mint Evidence IDs.
- Recovery cannot add Claims as if they were observations.
- No `ClaimGraph`. Relations stay on Evidence.

### Risk 3 — LLM Claim Extraction becomes uncontrollable

**Why it appears:** The motivating example is a paragraph (“Issue #291 has been fixed by PR #284149. The change has been validated.”) that humans want split into two Claims.

**Guard:**

- No extractor.
- No judge model.
- No embedding / semantic split of the final answer.
- Capture = `record_claim` or explicit absence.
- If the Agent said “validated” only in NL and never recorded a Claim, that sentence is not verified — same as today, except 14.2 will no longer treat silence as a pass when a completion-facing output exists.

Splitting “fixed by PR” and “validated” is the Agent’s job via two `record_claim` entries, not the harness’s job via NLP.

### Risk 4 — Breaking 600+ tests

**Why it appears:** Vacuous `claim_support` is load-bearing. Many verifier tests and fixture runs complete without caring whether Claims exist. Tightening it in the same PR as a rewrite would cascade.

**Guard:**

- 14.1 changes no verdicts.
- 14.2 changes one evaluator outcome (or adds one check), not the verifier architecture.
- Do not add `claims` to `verify()` (would touch every call site at once).
- After 14.2, run the full suite and fix only tests that encoded the vacuous pass.
- Test driver path already records Claims; live fixture `investigate(..., useTestDriver: true)` should remain the stable completion path.
- Recovery tests must keep asserting: parent `VerificationResult` is not mutated; Recovery adds Evidence IDs only.

---

## 7. Design Decisions (for confirmation)

| # | Decision | Choice |
|---|---|---|
| D1 | Reuse existing `Claim` | Yes |
| D2 | New `AgentClaim` / `ClaimVerifier` / `ClaimGraph` | No |
| D3 | Treat `InvestigationReport` as Claim | No |
| D4 | LLM / NL extraction | No |
| D5 | `verify(task, run, claims, evidence)` | No. Keep `verify({ task, run, ... })` |
| D6 | `source: agent_output \| investigation` | No |
| D7 | `origin` field | Not in 14.1; only later as writer provenance, never as meaning |
| D8 | Vacuous `claim_support` | Keep in 14.1. Tighten in 14.2 when completion-facing output exists without critical Claims |
| D9 | Recovery writes Claims or verdicts | No |
| D10 | Missing Claim as `ResolutionGap` | No. Capture gap ≠ Evidence gap |
| D11 | Legal Claim writer | `record_claim` only (test driver uses the same tool) |

---

## Completion

This phase stops here.

Waiting for architecture confirmation before Phase 14.1 implementation, tests, schema changes, or commits.
