# Phase 14.1 — Claim Capture Boundary

## Evaluation Scope

This phase closes the missing edge between Agent structured output and the existing Claim system.

It answers:

> Can Agent-declared structured claims enter `InvestigationRun.claims` through `record_claim()`, without parsing natural language and without changing IndependentCompletionVerifier?

It does **not** tighten empty-claim `claim_support`. It does **not** change Recovery. It does **not** extract claims from `AgentResult.output`.

`IndependentCompletionVerifier` remains the only completion authority. Evidence remains the only fact source. Capture writes Claims; it does not judge them.

Evaluated:

- Unit / boundary contracts in `tests/claim-capture.test.ts`
- AgentLoop passthrough of optional `claims` in `tests/agent-loop.test.ts`
- Full suite regression: existing fixtures and verifier outcomes unchanged

Independent Completion Verifier verdict logic, Completion Contract / `RESOLUTION_CHAIN`, Evidence Graph schema, Recovery Loop, Resolution Analyzer, Retrieval / Ranking, and Ground Truth were not modified.

No LLM Claim Extraction. No natural-language parser. No `AgentClaim` type.

## Environment

| Item | Value |
|---|---|
| Date | 2026-09-20 |
| Evaluation version | `14.1` |
| Node | v22.14.0 |
| npm | 10.9.2 |
| OS | Windows 10 (10.0.26200) |
| Test command | `npm test` — 639 passed, 0 failed |
| Build command | `npx tsc --noEmit` — pass |
| GitHub API | not called for claim-capture tests |
| OpenAI / DashScope / Qwen | not called |

## 1. What changed

| Area | Change |
|---|---|
| `ClaimInput` / `AgentResult.claims?` | Optional structured claims on Agent runtime result (`src/core/types.ts`) |
| `ModelResponse` final | Optional `claims?: ClaimInput[]` (`src/agent/model.ts`) |
| `AgentLoop` | Forwards `response.claims` onto `AgentResult` |
| `record_claim()` | Shared writer in `src/investigation/claim-capture.ts`; tool + capture both call it |
| `captureAgentClaims()` | Reads `AgentResult.claims` only; ignores answer text |
| Investigation loop | After AgentLoop returns, calls `captureAgentClaims` before verify |
| Trace | Emits `claim_recorded` with `{ claimId, source, type }` only |

## 2. Data-flow change

Before:

```text
Agent Result { output }
        |
        X   (no obligatory path into Claim)
        |
optional record_claim tool
        |
        v
InvestigationRun.claims
```

After:

```text
Agent Result { output, claims? }
        |
        +-- output          → presentation only (untrusted NL)
        |
        +-- claims[]        → captureAgentClaims()
                                    |
                                    v
                              record_claim()
                                    |
                                    v
                              InvestigationRun.claims
                                    |
                                    v
                              Existing IndependentCompletionVerifier
```

Legal writers of Claim remain:

1. `record_claim` tool (Agent / test driver during investigation)
2. `captureAgentClaims` → same `record_claim()` when `AgentResult.claims` is present

Illegal (still forbidden):

- Parse `AgentResult.output` with LLM or regex into Claim
- Promote `InvestigationReport.conclusion` into Claim
- Mint Evidence from Claim text
- Set `supported=true` at capture time
- Fold Evidence IDs into Claim identity (identity is `text + polarity + critical`)

## 2.1 Claim identity and the Evidence relation

Claim identity is the Agent's structured assertion only:

```text
Claim identity = text + polarity + critical
```

Evidence is **not** part of Claim identity. `claimFingerprint()` (`src/investigation/claim-capture.ts`) hashes exactly those three literal fields — no semantic similarity, no embedding, no LLM, no fuzzy matching.

Evidence relationships are carried by the separate `ClaimEvidence` relation:

```text
Claim
  ↓
ClaimEvidence  { claimId, evidenceId, role }
  ↓
Evidence
```

Consequences, all covered by `tests/claim-capture.test.ts`:

| Input | Result |
|---|---|
| Same `text`/`polarity`/`critical`, different `evidenceIds` | 1 Claim + 2 `ClaimEvidence` |
| Same Claim + same `evidenceId` written twice | 1 Claim + 1 `ClaimEvidence` |
| Different `text` | different Claim |
| Different `polarity` | different Claim |
| Different `critical` | different Claim |

Because identity never reads `run.claimEvidence`, a Claim's identity cannot drift when Evidence bindings grow, when Recovery runs, or when Evidence is reset.

Do **not** put Evidence back into the Claim fingerprint. It would merge a relation into a primary key and let one Agent assertion be counted twice by `claim_support` / `claimedComplete`.

Capture remains side-effect free outside Claim writing: it never sets `state.claimsRecorded`, never calls `attachClaimsToResolutionAnalyses`, and never creates Evidence. `record_claim` tool keeps its own semantics, including throwing on unknown Evidence IDs; the untrusted `AgentResult.claims` path drops such claims instead of throwing so verification is never skipped.

## 3. Modules not changed

| Module | Status |
|---|---|
| `IndependentCompletionVerifier` verdict rules | Unchanged |
| Completion Contract / `RESOLUTION_CHAIN` | Unchanged |
| `evalClaimSupport` vacuous pass | Unchanged (14.2) |
| Evidence Graph schema | Unchanged |
| Controlled Recovery Loop | Unchanged |
| Resolution Analyzer / Gap Analyzer | Unchanged |
| Retrieval / Ranking | Unchanged |
| Ground Truth | Unchanged |

Invariants kept:

- Evidence > Claim
- Verifier > Agent
- Recovery > Evidence only

## 4. Test results

| Test | Result |
|---|---|
| Agent output claim enters `run.claims` | Pass |
| Capture path calls `record_claim` / emits `claim_recorded` | Pass |
| Capture does not change verifier result (non-critical claim) | Pass |
| Claim exists without Evidence and is not `supported` | Pass |
| Capture does not create fake Evidence | Pass |
| NL final answer alone does not become Claim | Pass |
| `InvestigationReport.conclusion` is not promoted to Claim | Pass |
| AgentLoop forwards optional `claims` | Pass |
| B1 Case A — tool claim + identical final claim stays one Claim | Pass |
| B1 Case B — repeated capture of one `AgentResult` stays one Claim | Pass |
| B1 — different text / polarity / critical stay distinct Claims | Pass |
| B1 — same Claim bound to different Evidence → 1 Claim + 2 `ClaimEvidence` | Pass |
| B1 — same Claim + same Evidence repeated → 1 Claim + 1 `ClaimEvidence` | Pass |
| B1 — dedupe leaves `ClaimEvidence` and support status correct | Pass |
| B2 — `record_claim` tool still rejects unknown Evidence IDs | Pass |
| B2 — capture drops invalid claims, never throws | Pass |
| B2 — invalid final claim still reaches `verify()` | Pass |
| B3 — capture does not set `claimsRecorded` | Pass |
| B3 — capture does not mutate Resolution Analysis | Pass |
| B1 — dedupe does not change verifier result | Pass |
| Full suite | 639 passed, 0 failed |

## 5. Acceptance

```text
Agent Output
        |
        v
Structured Claim (ClaimInput / record_claim)
        |
        v
Existing Claim Storage (InvestigationRun.claims)
        |
        v
Existing Verifier
```

Phase 14.1 stops here. Phase 14.2 (empty-claim handling / claim_support tightening) and recovery integration wait for the next review.
