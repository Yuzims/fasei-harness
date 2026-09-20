# Implementation status

Canonical design spec: [`../design.md`](../design.md).

## Phase 1 — Domain Model — DONE

Investigation domain in `src/domain/`. Agent conclusions are claims to verify, not truth.

## Phase 2 — GitHub Data Layer — DONE

`GitHubDataProvider` with live REST and snapshot replay. Fixtures in `fixtures/github/`.

## Phase 3A — Investigation Agent — DONE

`src/investigation/` runs a bounded investigation through AgentLoop + GitHub tools. The agent cannot set `VERIFIED_COMPLETE`.

## Phase 4 — Independent Completion Verifier — DONE

Independent, deterministic completion verification.

```text
Investigation Agent
        |
        | observations / evidence / claims
        v
    Harness State
        |
        v
Independent Completion Verifier
        |
        v
VerificationResult
```

**Agent conclusion ≠ verification result.**

`VerificationResult` is produced independently by the Harness (`IndependentCompletionVerifier`). The agent may investigate, collect evidence, and record claims. It cannot set `verified_complete`. Tool success and Agent prose are not completion.

Deterministic checks:

1. Issue identity (repository + number)
2. Issue state (`closed` is not `resolved`)
3. Resolution candidate (issue → timeline/relations → PR)
4. Pull request merged (`merged === true`, no contradictory merge facts)
5. Code / commit evidence linked to that PR (`derived_from` / `parents` / `merges`)
6. Critical claims supported without contradiction (`ClaimEvidence` role)
7. `EvidenceRequirement` coverage (optional gaps do not block)

Outcomes:

| Status | Meaning |
|---|---|
| `verified_complete` | All required checks pass |
| `not_verified` | Enough evidence to reject completion |
| `insufficient_evidence` | Key evidence missing; cannot prove completion |

Fixture behavior:

| Fixture | Target | Result |
|---|---|---|
| `fixtures/github/resolved.json` | acme/box#42 | `verified_complete` |
| `fixtures/github/closed-unmerged.json` | acme/box#99 | `not_verified` |
| `fixtures/github/insufficient-evidence.json` | acme/box#7 | `insufficient_evidence` |

GitHub issue/comment bodies remain `external_untrusted`. Prompt injection in fixture #7 does not become a Harness instruction.

Trace events: `verification_started`, `verification_check`, `verification_completed`.

Existing workspace `WorkspaceCompletionVerifier` (file/count/citation for synthetic demos) is legacy. Product path uses `IndependentCompletionVerifier`.

## Phase 5 — Failure Analyzer + Failure-Specific Recovery Planner — DONE

Investigation failures are classified, then recovered by type. Not:

```text
if failure: retry()
```

```text
Investigation Agent
        |
        v
Independent Completion Verifier
        |
        v
FailureAnalyzer  →  FailureEvent (Phase 1 taxonomy)
        |
        v
RecoveryPlanner  →  RecoveryPlan
        |
        v
Harness executes plan as a new append-only InvestigationAttempt
        |
        v
Agent continues / stops
        |
        v
Verifier runs again
```

`FailureAnalyzer` and `RecoveryPlanner` in `src/investigation/` use the Phase 1 domain types (`FailureType`, `FailureEvent`, `RecoveryPlan`). They do not call GitHub or the LLM.

Workspace injection (`src/legacy/failure` + `src/legacy/recovery`) still serves the synthetic Harness / benchmark. That path is **Legacy Failure Injection**, not Investigation Recovery. See [`architecture-cleanup.md`](architecture-cleanup.md).

Classification uses structured tool metadata, investigation state, fingerprints, and `VerificationResult` — not `error.message.includes(...)`.

| Failure | Typical recovery |
|---|---|
| `tool_failure` (timeout / 429 / 5xx / network) | `retry_with_backoff` (bounded) |
| `tool_failure` (401 / 404 / non-retryable) | `stop` (no blind retry) |
| `retrieval_failure` | `change_retrieval_strategy` / `refine_query` |
| `premature_completion` | `continue_investigation` + missing requirements |
| `loop_failure` (same-state / repeated actions) | `replan` once, then `stop` |
| `insufficient_evidence` | `gather_missing_evidence`, or `stop` if no sources remain |
| `invalid_evidence` | `revalidate_evidence` (discard; never upgrade to trusted) |
| `wrong_target` | `recheck_target` (reset evidence; do not keep collecting on the wrong issue) |

Bounds: `RECOVERY_BOUNDS.maxInvestigationAttempts` / `maxRecoveryAttempts` / `maxToolRetries`.

Trace events: `failure_detected`, `failure_analyzed`, `recovery_planned`, `recovery_started`, `recovery_completed`.

Recovery never writes `verified_complete`. After recovery the verifier runs on the new evidence.

## Phase 5 cleanup — Unify Failure / Recovery — DONE

Public `FailureAnalyzer` / `RecoveryPlanner` / `FailureType` / `RecoveryPlan` names now mean the Investigation path. Workspace injection lives under `src/legacy/`. Details: [`architecture-cleanup.md`](architecture-cleanup.md).

## Phase 6 — Evidence Graph & Verification Formalization — DONE

Evidence relationships are first-class domain data. The verifier does not reconstruct the graph by guessing from arbitrary payload fields.

```text
GitHub Tool Result
        ↓
Evidence
        ↓
Evidence Graph
   ┌────┴─────┐
   ↓          ↓
Evidence    Claim
   ↓          ↓
Relation   ClaimEvidence
   └────┬─────┘
        ↓
Evidence Requirements
        ↓
Independent Completion Verifier
```

Resolution evidence chain for the current GitHub Issue investigation:

```text
Issue
 ↓
Issue is closed
 ↓
Resolution candidate PR  (fixes / references)
 ↓
PR is merged             (merged fact or merges relation)
 ↓
Commit / changed-file    (derived_from)
 ↓
Claim: "The Issue was resolved by this change."
 ↓
ClaimEvidence (supports, without contradicts)
```

**Agent conclusion is not truth.** Verification is based on independently checkable evidence, not the Agent's final answer. This does not prove arbitrary software issues are solved; it checks the GitHub issue-resolution evidence chain.

| Check id | Meaning |
|---|---|
| `issue-identity` | Target owner/repository/number |
| `issue-state` | Issue is closed (closed ≠ resolved) |
| `resolution-candidate` | PR linked to the issue in the Evidence Graph |
| `pr-merged` | Candidate PR `merged === true`, without contradiction |
| `code-commit` | Commit/file/code evidence derived from that PR |
| `claims-supported` | Critical claims have ClaimEvidence support, not contradicted |
| `evidence-requirements` | Required requirements present; optional gaps do not block |

Fixture behavior is unchanged:

| Fixture | Target | Result |
|---|---|---|
| `fixtures/github/resolved.json` | acme/box#42 | `verified_complete` |
| `fixtures/github/closed-unmerged.json` | acme/box#99 | `not_verified` |
| `fixtures/github/insufficient-evidence.json` | acme/box#7 | `insufficient_evidence` |

```text
Evidence Graph
      ↓
EvidenceRequirement
      ↓
evaluateEvidenceRequirement
      ↓
IndependentCompletionVerifier
      ↓
VerificationResult
```

EvidenceRequirement conditions are evaluated by a canonical deterministic `evaluateEvidenceRequirement()`. IndependentCompletionVerifier orchestrates checks and the final verdict; it does not reimplement `issue_closed` / `resolution_candidate` / `resolution_merged` / `resolution_code_evidence` / `claim_support`.

GitHub issue/comment/PR/commit prose remains `external_untrusted`. Prompt injection in fixture text does not become trusted completion evidence.

## Phase 7.0 — Benchmark Foundation — DONE

Deterministic Benchmark/Evaluation Harness around the existing investigation pipeline. Measurement infrastructure only — this phase does not claim that the Harness improves Agent performance.

```text
BenchmarkScenario
        ↓
SnapshotGitHubProvider
        ↓
investigate() + SnapshotInvestigationDriver
        ↓
IndependentCompletionVerifier
        ↓
FailureAnalyzer / RecoveryPlanner (existing)
        ↓
ScenarioResult
        ↓
BenchmarkReport + metrics
```

Location: `src/benchmark/`. The benchmark depends on the production Harness. Investigation / verifier / domain / GitHub code do not import the benchmark.

Contract:

- `BenchmarkScenario` — id, description, fixture, target, expectedOutcome
- `ScenarioResult` — expected vs observed verifier status, passed, attempts, tool calls, failure types
- `BenchmarkReport` — name/version, scenario counts, metrics, per-scenario results
- `BenchmarkMetrics` — `taskSuccessRate`, `falseCompletionRate`, `insufficientEvidenceRate`, `evidenceCoverage`, `unsupportedClaimRate`, `recoveryRate`, `averageAttempts`, `averageToolCalls`

`taskSuccessRate` uses `VerificationResult.status === verified_complete`. Agent prose is not success.

`falseCompletionRate` counts:

```text
critical Claim polarity === resolved
        AND
verifier status !== verified_complete
```

Current:

```text
3 deterministic snapshot scenarios
```

| Scenario | Fixture | Expected |
|---|---|---|
| `resolved` | `fixtures/github/resolved.json` (acme/box#42) | `verified_complete` |
| `closed-unmerged` | `fixtures/github/closed-unmerged.json` (acme/box#99) | `not_verified` |
| `insufficient-evidence` | `fixtures/github/insufficient-evidence.json` (acme/box#7) | `insufficient_evidence` |

Runnable without `GITHUB_TOKEN` or an LLM API key (`useTestDriver: true` + recorded snapshots). Same fixture + same scenario + same Harness version → same benchmark result (verifier outcomes, pass/fail, metrics).

This is a regression/evaluation foundation, not a representative real-world GitHub benchmark.

Future:

```text
larger real-world GitHub snapshot benchmark
```

CLI: `npm run fasei-benchmark` prints a JSON `BenchmarkReport`.

## Phase 7.1 — Benchmark Scenario & Failure Scenario Model — DONE

Scenario contract extension on the Phase 7.0 foundation. Measurement/contract only — not a 30+ real GitHub issue dataset.

```text
Benchmark Scenario
       ↓
Scenario Environment / Fixture
       ↓
Production Harness
       ↓
Observed Result
       ↓
Benchmark Evaluator
       ↓
Metrics
```

Scenario fields added:

- `kind`: `normal` | `failure`
- `failureMode`: scenario intent / classification (what the case is designed to exercise)
- `expectedOutcome.failureModes`: expected observed production failure(s); not filled from `failureMode`
- `expectedOutcome.recovery.required`

The evaluator (`src/benchmark/evaluate.ts`) compares expected verification / failure-mode presence / recovery-attempted against observed Harness output. It does not reimplement verification, failure analysis, or recovery planning.

Failure injection (`src/benchmark/injection.ts`) is a benchmark-boundary adapter: wrap `GitHubDataProvider` and/or supply a deterministic test Model via existing `investigate({ modelFactory, provider })`. Production modules do not import `src/benchmark/`.

Current benchmark:

```text
small deterministic regression/failure suite
```

| Scenario | Kind | Contract |
|---|---|---|
| `resolved` | normal | `verified_complete` |
| `closed-unmerged` | normal | `not_verified` |
| `insufficient-evidence` | failure | `insufficient_evidence` |
| `wrong-target` | failure | `wrong_target` + `not_verified` |
| `tool-failure` | failure | `tool_failure` present; recovery required |
| `premature-completion` | failure | `premature_completion`; false completion (claimed resolved + verifier rejects) |
| `retrieval-failure` | failure | `retrieval_failure` present; recovery required |

Phase 7.0 metrics are unchanged.

Future:

```text
30+ real GitHub snapshot cases
```

This suite is not representative of real-world GitHub workloads.

## Phase 7.2A — Benchmark Dataset Pipeline — DONE

Stable, reproducible dataset input for the existing Benchmark. This phase does not add Agent capability, and it does not redesign Verification / Failure Analysis / Recovery.

```text
Real GitHub Issue
      ↓
Snapshot
      ↓
Normalized GitHub Data
      ↓
Benchmark Scenario
      ↓
Harness Run
      ↓
Independent Verification
      ↓
Benchmark Metrics
```

Current development Dataset includes:

- `synthetic-v1` — fixture pipeline validation
- `real-v1` — first 10 curated real GitHub issues

Real Dataset Cases are recorded snapshots. They are not live GitHub state.

### Dataset architecture

```text
BenchmarkDataset
BenchmarkDatasetCase
BenchmarkDatasetMetadata
        ↓
Dataset Loader / Validation
        ↓
Scenario Adapter
        ↓
Benchmark Runner (existing Harness + Verifier)
```

Location: `src/benchmark/dataset/`. Dataset is an evaluator/experiment input layer. It calls production `GitHubDataProvider` snapshot APIs and the existing Benchmark Runner. It does not copy Independent Completion Verifier, Failure Analyzer, or Recovery Planner.

Dependency direction is unchanged:

```text
domain → github/data → investigation → verification → failure/recovery → benchmark → dataset
```

Domain does not import benchmark or dataset. Benchmark runtime does not call `api.github.com`.

### Dataset manifest

`fixtures/benchmark/dataset/synthetic-v1/benchmark-dataset.json`

```text
datasetVersion  (content version, currently "v1")
schemaVersion   (manifest schema, currently "1")
kind            ("synthetic" | "real")
cases[]
```

`datasetVersion` and `schemaVersion` are separate: changing cases does not imply a schema change.

Each case:

```text
caseId
source.type / source.repository / source.issueNumber
snapshotPath
scenarioId
kind / optional failureMode
```

Synthetic manifests may include `expectedOutcome` as an inline evaluation contract. The loader stores it on `dataset.evaluationOutcomes`, not on `BenchmarkDatasetCase`. Real manifests must not include `expectedOutcome` or `expectedFailureModes`; those live in `ground-truth.json`.

Reserved optional fields (stored, not a second evaluation contract): `tags`, `difficulty`, `sourceMetadata`, `notes`.

Evaluation uses `expectedOutcome` from synthetic `evaluationOutcomes` or real `ground-truth.json`. `scenario.failureMode` is experiment intent. `expectedOutcome.failureModes` is the observed production failure the evaluator checks. There is no fallback from `failureMode`.

### Snapshot strategy

Do not redesign Phase 2. Recorded snapshots are normalized `InvestigationSnapshot` files. Loader validates them with existing `loadSnapshot` / `validateSnapshot`. Runtime uses `SnapshotGitHubProvider` only.

```text
GitHub API
    ↓
GitHubDataProvider
    ↓
Normalized GitHub Data
    ↓
Recorded Snapshot
    ↓
SnapshotGitHubProvider
```

Dataset snapshots live under `fixtures/benchmark/dataset/` and are distinct from `fixtures/github/`. Files are git-versioned, contain no tokens, and do not require live GitHub state.

### Loader / validation

`loadDataset()` / `validateDataset()` / `loadCase()` / `loadSnapshot()` fail fast:

- unique `caseId`
- snapshot file exists and is a valid InvestigationSnapshot
- scenario fields present (`scenarioId`, `kind`)
- synthetic `expectedOutcome.verificationStatus` / `failureModes` / `recovery` are legal and stored as `evaluationOutcomes`
- real cases must not include `expectedOutcome` or `expectedFailureModes`; `ground-truth.json` must cover every case
- repository / issue identity complete (`github` + `owner/name` + positive issue number)
- snapshot identity matches case identity (owner / repository / issue number)
- supported `schemaVersion`

Errors throw `BenchmarkDatasetError`. Invalid cases are not skipped.

### Dataset → Scenario → Harness

```text
Dataset Loader
      ↓
Dataset Case
      ↓
convertCaseToScenario()
      ↓
BenchmarkScenario (snapshotPath, not live GitHub)
      ↓
runBenchmarkCase() → existing executeScenario / investigate / verifier
```

`BenchmarkScenario.snapshotPath` is the dataset-resolved recorded snapshot. Existing Phase 7.0/7.1 scenarios still use `fixture`. Metrics semantics from Phase 7.0 are unchanged.

### Reproducibility

Same `datasetVersion` + `caseId` reloads the same snapshot input. Deterministic fixture-mode Harness runs are stable for verifier outcome / pass. This phase requires Dataset Input Determinism, not full Agent-model determinism.

### Tests

`tests/benchmark-dataset.test.ts`:

1. Valid dataset loads
2. Missing snapshot fails
3. Duplicate `caseId` fails
4. Snapshot / case identity mismatch fails
5. Illegal `expectedOutcome` fails
6. Dataset version / schema version readable
7. Case converts to Benchmark Scenario
8. Runner executes a full case from snapshot
9. Same case reloads the same snapshot; fixture-mode rerun is stable

### Current limitation

`real-v1` is the first recorded real GitHub dataset. It validates that curated GitHub snapshots can enter the existing Benchmark Dataset Pipeline. It does not claim scientific validation of Harness performance. Later recapture is `real-v2`, not a silent rewrite of `real-v1`.

## Phase 7.2B — Real GitHub Benchmark Dataset — DONE

Location: `fixtures/benchmark/dataset/real-v1/`.

```text
real-v1/
  manifest.json
  ground-truth.json
  cases/C01..C10/snapshot.json
```

Agent input is the recorded `InvestigationSnapshot`. Ground truth is `ground-truth.json` and is evaluator-only. The real-v1 manifest does not contain `expectedOutcome` or `expectedFailureModes`. Snapshots do not contain `expectedOutcome`, `correct_pr`, or failure-mode gold labels. `convertCaseToScenario()` does not copy ground truth onto the scenario passed to the agent runtime.

C07 stores `expectedFailureModes: [wrong_target]` in `ground-truth.json` only. That field is not copied into the agent snapshot, dataset case, converted scenario, or observed failures. The rationale acknowledges that merged PR #7256 explicitly says `Closes #4490`, and explains why independent semantic/effect verification still does not accept that closure linkage.

## Phase 7.2C — Real Dataset Benchmark Execution — DONE

`real-v1` now runs through the existing Dataset → Scenario → Harness → Evaluator path.

```text
real-v1 snapshot
        ↓
SnapshotGitHubProvider
        ↓
investigate() + SnapshotInvestigationDriver
        ↓
Independent Completion Verifier
        ↓
FailureAnalyzer / RecoveryPlanner (existing)
        ↓
Observed Outcome
        ↓
Evaluator (ground-truth.json only)
        ↓
Phase 7.0 BenchmarkMetrics + JSON result
```

CLI: `npm run benchmark:real`. It reuses `executeScenario` / `scoreScenario` / `computeBenchmarkMetrics`. It does not add a second evaluation architecture, a live GitHub client, or an LLM provider.

Ground truth stays evaluator-only. `convertCaseToScenario()` still omits `expectedOutcome`. The agent task sees case metadata, description, target, and snapshot observations. It does not read `ground-truth.json`.

Execution is snapshot-only. The runner constructs `SnapshotGitHubProvider` and blocks `api.github.com` / `github.com` `fetch` during the real dataset run.

Result: `benchmark-results/real-v1/latest.json`. Timestamp is recorded. Canonical comparison ignores timestamp; two consecutive `npm run benchmark:real` runs matched on case count, observed outcomes, evaluation, failure classification, attempts / toolCalls, evidence/claim counts, and aggregate metrics.

Actual run (`datasetVersion` v1):

| Case | Observed | Expected | Evaluator |
|---|---|---|---|
| C01 | `verified_complete` | `verified_complete` | pass |
| C02 | `verified_complete` | `verified_complete` | pass |
| C03 | `verified_complete` | `verified_complete` | pass |
| C04 | `verified_complete` | `verified_complete` | pass |
| C05 | `insufficient_evidence` | `not_verified` | fail |
| C06 | `insufficient_evidence` | `not_verified` | fail |
| C07 | `insufficient_evidence` | `not_verified` | fail |
| C08 | `insufficient_evidence` | `verified_complete` | fail |
| C09 | `insufficient_evidence` | `verified_complete` | fail |
| C10 | `insufficient_evidence` | `not_verified` | fail |

Metrics from that run (Phase 7.0 definitions; `taskSuccessRate` is verifier `verified_complete`, not evaluator pass rate):

```text
taskSuccessRate: 0.4
falseCompletionRate: 0
insufficientEvidenceRate: 0.6
evidenceCoverage: 0.5999999999999999
unsupportedClaimRate: 0
recoveryRate: 0
averageAttempts: 1
averageToolCalls: 6.9
```

Evaluator: 4 passed / 6 failed. Numbers come from Harness execution, not hand-edited scores. There is no caseId scoring branch.

Known limitations:

- This is a recorded-snapshot regression/evaluation run with `SnapshotInvestigationDriver`. It is not a live-LLM GitHub benchmark and does not claim scientific validation of Harness performance.
- Closed-without-resolution-PR cases (C05/C10) are independently classified `insufficient_evidence`; ground truth labels them `not_verified`. The evaluator compares those statuses as-is.
- C06/C07 comments mention pull numbers that are not in the recorded snapshot (`PR 123`, `PR 3868`). The existing driver then hits `not_found` and stops with `tool_failure` before a semantic verdict. C07 therefore does not currently observe `wrong_target`.
- C08/C09 snapshots did not yield a resolution-candidate PR on the current investigation path, so the harness observed `insufficient_evidence` against ground-truth `verified_complete`.

## Phase 7.2C.1 — Benchmark Dataset Completeness & Validity Fix — DONE

This phase repaired Agent-visible snapshot completeness. It did not change Ground Truth, evaluator thresholds, or Phase 7.0 metric definitions. `datasetVersion` is now `v1.1` (same `real-v1` cases).

Generic fixes (no caseId branches):

- Capture follows `#N` mentions in issue/comment text and records a `cross-referenced` timeline event when a captured PR body/title closes the target issue but GitHub's timeline API omitted that link.
- Timeline events that only stored a commit SHA are enriched with that commit's real message.
- Non-retryable GitHub `not_found` marks the resource investigated so the driver does not repeat the same missing PR until `maxSteps`.
- When no merged/unmerged PR remains, the driver inspects referenced repository commits.

Snapshot files actually rewritten: C01, C02, C03, C07, C08, C09. C07/C09 gained a discoverable PR cross-reference. C08 timeline bodies now include commit messages (including `e70118a` / `Resolves #291`). C04, C05, C06, C10 were already complete enough and were not rewritten.

Actual run after the repair:

| Case | Observed | Expected | Evaluator | Why |
|---|---|---|---|---|
| C01 | `verified_complete` | `verified_complete` | pass | Merged PR 284149 chain is observable. |
| C02 | `verified_complete` | `verified_complete` | pass | Merged PR 14527 chain is observable. |
| C03 | `verified_complete` | `verified_complete` | pass | Merged PR 14022 chain is observable. |
| C04 | `verified_complete` | `verified_complete` | pass | Duplicate resolved by existing merged PR 14504. |
| C05 | `insufficient_evidence` | `not_verified` | fail | Snapshot is a valid negative control (closed `not_planned`, no resolution PR). Verifier missing `req-pr`/`req-commit` is `insufficient_evidence`, not `not_verified`. Issue body `#616` is not a snapshot PR; one `not_found` is classified `tool_failure` then stop. |
| C06 | `insufficient_evidence` | `not_verified` | fail | Same negative-control shape as C05. Comments mention `#123`/`#273`, which are not resolution PRs in the snapshot. Those 404s are recorded once and not retried to `maxSteps`. |
| C07 | `verified_complete` | `not_verified` | fail | PR 7256, files, and commits are now followed. The harness verifies the GitHub close/merge/file/commit chain. It does not perform the semantic/effect check Ground Truth describes, and it does not emit `wrong_target` because issue identity matches. |
| C08 | `insufficient_evidence` | `verified_complete` | fail | Commit `e70118a` is observable (`Resolves #291`). There is no merged PR candidate; independent verification still requires Issue→PR→merged→code. Direct-commit close cannot be `verified_complete`. |
| C09 | `verified_complete` | `verified_complete` | pass | PR 279 and untrusted-content files are now discoverable and fetched. |
| C10 | `insufficient_evidence` | `not_verified` | fail | Snapshot is sufficient: closed `completed` with a security write-up and no resolution PR. Closed ≠ verified. |

Metrics from that run:

```text
taskSuccessRate: 0.6
falseCompletionRate: 0
insufficientEvidenceRate: 0.4
evidenceCoverage: 0.7333333333333332
unsupportedClaimRate: 0
recoveryRate: 0
averageAttempts: 1
averageToolCalls: 7.2
```

Evaluator: 5 passed / 5 failed. Two consecutive `npm run benchmark:real` runs matched after canonicalizing timestamp.

Remaining limitations:

- Independent Completion Verifier checks the GitHub evidence chain, not whether a merged PR semantically fixes the reported bug (C07).
- Direct-commit issue closure without a PR cannot produce `verified_complete` (C08).
- Closed-without-PR cases are `insufficient_evidence`; Ground Truth labels them `not_verified` (C05/C06/C10).
- Comment/commit `#N` mentions that are not snapshot PRs still produce a single non-retryable `not_found`, which FailureAnalyzer reports as `tool_failure` even when the verification status is `insufficient_evidence`.

## Phase 7.2D — Verification Semantics & Benchmark Contract Alignment — DONE

Verification statuses are now a contract, not three labels around a PR-only chain.

```text
verified_complete
  identity matches
  issue is closed
  closure is not explicit non-resolution (not_planned)
  a resolution candidate exists (merged PR or direct commit linked to the issue)
  that path landed
  implementation evidence exists on that path
  descriptive alignment between issue problem terms and the landed resolution
  required claims / EvidenceRequirements hold
  no required-check contradiction

not_verified
  enough evidence to reject completion:
  wrong identity, open issue, closed as not_planned,
  unmerged resolution PR, or an explicit contradiction

insufficient_evidence
  not enough to prove completion and not enough to reject it
  including: no resolution path, or a landed GitHub path whose
  description does not align with the issue (effect unproven)
```

Resolution path is unified: `pr_merge` and `direct_commit` share `resolution_candidate` / `resolution_merged` / `resolution_code_evidence`. A commit is not complete merely because it exists; it must be linked to the issue (closing keywords / graph edge), have a real SHA, count as code evidence, and pass descriptive alignment.

Descriptive alignment is **not** semantic code review. It only checks issue-title identifiers or problem-term overlap after stripping closing-keyword lines. Failure is `insufficient_evidence`, not a hardcoded `wrong_target`.

Evaluator still uses exact verification-status match. `falseCompletionRate` remains Agent-side (agent claimed complete, verifier did not). New metric:

```text
verifierFalsePositiveRate
  = count(expected !== verified_complete AND observed === verified_complete)
    / count(expected !== verified_complete)
```

Ground truth stays evaluator-only.

Actual Real-v1 run after this contract:

| Case | Observed | Expected | Evaluator | Why |
|---|---|---|---|---|
| C01 | `verified_complete` | `verified_complete` | pass | Merged PR 284149 path + descriptive alignment. |
| C02 | `verified_complete` | `verified_complete` | pass | Merged PR 14527 path + descriptive alignment. |
| C03 | `verified_complete` | `verified_complete` | pass | Merged PR 14022 path + descriptive alignment. |
| C04 | `verified_complete` | `verified_complete` | pass | Duplicate resolved by landed PR 14504; PR body shares audio/TTS problem terms. |
| C05 | `not_verified` | `not_verified` | pass | Closed `not_planned` is explicit non-resolution. |
| C06 | `not_verified` | `not_verified` | pass | Same closure semantics as C05. |
| C07 | `insufficient_evidence` | `not_verified` | fail | PR 7256 is a landed GitHub path, but `listDeviceSessions` does not appear in the resolution. Effect is unproven; the harness does not claim `wrong_target`. |
| C08 | `verified_complete` | `verified_complete` | pass | Direct commit `e70118a` (`Resolves #291`) is a landed path with code evidence. |
| C09 | `verified_complete` | `verified_complete` | pass | Merged PR 279 path + untrusted-content terms. |
| C10 | `insufficient_evidence` | `not_verified` | fail | Closed `completed` with no resolution path. Closed + write-up is not enough to prove or reject completion under this contract. |

Metrics from that run:

```text
taskSuccessRate: 0.6
falseCompletionRate: 0.1
insufficientEvidenceRate: 0.2
evidenceCoverage: 0.8
unsupportedClaimRate: 0
recoveryRate: 0
averageAttempts: 1
averageToolCalls: 7.2
verifierFalsePositiveRate: 0
```

Evaluator: 8 passed / 2 failed. Two consecutive `npm run benchmark:real` runs matched after canonicalizing timestamp. `falseCompletionRate` 0.1 is C07: the test driver recorded resolved claims on the merged PR while the verifier kept `insufficient_evidence`. `verifierFalsePositiveRate` is 0 because the verifier never said `verified_complete` on a case Ground Truth says should not be verified.

Remaining limitations:

- Descriptive alignment is a conservative gate, not proof that the change fixed the bug.
- C07 Ground Truth is `not_verified` / `wrong_target`; observed `insufficient_evidence` is an exact-status miss, not a verifier false positive.
- C10 Ground Truth is `not_verified`; without explicit non-resolution the contract yields `insufficient_evidence`.
- Evaluator does not introduce a second disposition enum; exact status match remains the pass/fail rule.

## Phase 7.3 — Closed-Loop Recovery Validation — DONE

Recovery is a control mechanism inside the existing AgentLoop. It is not a second agent and not a benchmark-side simulation.

```text
Failure
  ↓
FailureAnalyzer
  ↓
RecoveryPlan
  ↓
applyRecovery → InvestigationStrategy
  ↓
new append-only Attempt
  ↓
changed investigation behavior
  ↓
new evidence
  ↓
IndependentCompletionVerifier
```

Recovery Contract:

1. Trigger: Independent verifier did not produce `verified_complete`.
2. FailureAnalyzer classifies structured investigation state into `FailureEvent`. It does not parse `error.message`.
3. RecoveryPlanner maps `FailureType` to a `RecoveryPlan` action ("what to do").
4. `applyRecoveryPlan` mutates runtime state and installs an `InvestigationStrategy` ("how the next attempt investigates").
5. The next AgentLoop iteration reads strategy + recovery context from `InvestigationState` / `ModelContext`.
6. Provenance: Attempt 2 `parentAttemptId` / `recoveryPlanId` / `failureEventId` → Attempt 1 failure/recovery.
7. Bounds remain `maxInvestigationAttempts = 3`, `maxRecoveryAttempts = 3`, `maxToolRetries = 2`. Exhaustion is `recovery_exhausted`.

Recovery action and investigation strategy are separate objects. Recovery is deterministic / policy-driven. The Harness does not learn recovery strategies.

Closed loops implemented:

| Scenario | Failure | Recovery action | Next strategy | Proof |
|---|---|---|---|---|
| TOOL_FAILURE | retryable tool error | `retry_with_backoff` | `retry_failed_tool` | Attempt 1 tool_result success=false; Attempt 2 retries the same tool |
| INSUFFICIENT_EVIDENCE | missing resolution evidence | `gather_missing_evidence` | `gather_resolution_evidence` | Attempt 2 strategy ≠ Attempt 1; new PR/commit evidence |
| PREMATURE_COMPLETION | agent claimed complete | `continue_investigation` | `continue_investigation` | Agent final answer does not stop the run; verifier rejection recovers |

Trace events added: `investigation_attempt_started`, `recovery_applied`. Existing failure/recovery events remain.

Metric added (synthetic recovery suite; not a Real-v1 scoring change):

```text
recoverySuccessRate
  = count(recoveryAttempted AND recovered to verified_complete)
    / count(recoveryAttempted)
```

Recovery invoked is not recovery success. CLI: `npm run benchmark:recovery`.

Real-v1 Dataset was not modified. Ground Truth is still evaluator-only and is not an input to FailureAnalyzer / RecoveryPlanner / applyRecovery.

Actual Real-v1 run after this phase (same outcomes as Phase 7.2D):

```text
Evaluator: 8 passed / 2 failed
taskSuccessRate: 0.6
falseCompletionRate: 0.1
insufficientEvidenceRate: 0.2
recoveryRate: 0
recoverySuccessRate: 0
averageAttempts: 1
verifierFalsePositiveRate: 0
```

C07/C10 still fail exact-status match. Recovery did not change Real-v1 attempts because primary classified failures are non-retryable `not_found` or have no remaining sources.

Known limitations:

- Recovery remains deterministic policy, not learned.
- Real-v1 still often stops after one attempt when the primary classified failure is a non-retryable tool error or no remaining sources exist.
- `recoverySuccessRate` is meaningful on the synthetic recovery suite. Real-v1 may stay near 0 without claiming that recovery is ineffective on live GitHub.

## Phase 8.7.4 — LLM Runtime Safety & Budget Guard — DONE

Live Investigation LLM usage now has an extra, executable runtime bound. This does **not** replace AgentLoop `maxSteps=12` or recovery `maxAttempts=3`.

```text
existing Agent bounds
        +
LLM runtime budget (default maxLlmCalls=8, maxWallClockMs=120_000)
```

Defaults are conservative because a Live run could otherwise issue up to `3 × 12 = 36` provider calls with no wall-clock cap, and a 300s client timeout does not cancel the DashScope request.

```text
Live Investigation
      ↓
LlmRuntimeGuard (AbortController + deadline timer)
      ↓
AgentLoop / InvestigationLoopModel
      ↓
OpenAICompatModel.decide()
      ↓
fetch(url, { signal })
```

Before each real LLM HTTP request:

1. If `llmCallsSent >= maxLlmCalls` → do not send HTTP; `FailureEvent.type = runtime_budget_exceeded`, `errorCode = LLM_CALL_BUDGET_EXCEEDED`.
2. If wall-clock deadline has passed → do not send HTTP; `errorCode = LLM_RUNTIME_TIMEOUT`.
3. Otherwise authorize the call and pass `AbortSignal` into `fetch()`. When `maxWallClockMs` elapses, `AbortController.abort()` fires so an in-flight request terminates.

Budget / timeout failures:

- enter `FailureAnalyzer` first (not `tool_failure` / `retrieval_failure` / `premature_completion`)
- `RecoveryPlanner` always returns `stop`
- investigation loop also refuses to start another attempt even if a custom planner tries to continue
- successful and failed LLM calls remain in `LlmUsageCollector`; unknown token fields stay `null`

Snapshot / Benchmark / test-driver paths do not send LLM HTTP. Budget applies only when `OpenAICompatModel` is about to call the provider.

Hono `c.req.raw.signal` is forwarded as a parent abort when present. Independent proof that every client disconnect cancels DashScope is a follow-up; this phase guarantees FASEI-owned deadline → AbortController → fetch.

## Phase 8.8.1 — Evidence-Gap-Driven Investigation Strategy — DONE

Minimal constraint layer on the live LLM investigation path. Not a second Planner and not a verifier.

```text
Evidence Requirements
        ↓
evaluateEvidenceRequirement (existing)
        ↓
Evidence Gap
        ↓
Candidate Investigation Actions (existing GitHub tools only)
        ↓
Hard legal-action constraint
        ↓
LLM selects among legal actions
        ↓
Tool Call / reject illegal tool
        ↓
New Evidence
        ↓
Recalculate Evidence Gap
```

`IndependentCompletionVerifier` remains the only producer of `verified_complete`. Strategy decides the next legal investigation direction. RecoveryPlanner / EvidenceRequirement / Ground Truth / GitHub provider semantics are unchanged.

## Phase 8.8.2 — Controlled Strategy Evaluation — DONE

Deterministic before/after evaluation of Phase 8.8.1. Strategy semantics, Verifier, EvidenceRequirement, RecoveryPlanner, FailureAnalyzer, GitHub Provider, LLM runtime budget defaults, Ground Truth, and Real-v1 snapshots are unchanged.

```text
same task / snapshot / Fake Model / tools / budgets
        ↓
A. unconstrained (evaluation boundary; approximation of pre-8.8 tool selection)
B. evidence-gap legal-action constraint (Phase 8.8.1)
        ↓
raw metrics + differences (not ranking)
```

Baseline is an approximation of pre-8.8 observation-based tool selection (`nextInvestigationAction`), not a strict live-LLM replay. Token figures are local estimates (message/tool-result chars), not provider tokens. Evaluation does not write results back into Real-v1 snapshots.

## Phase 8.8.2.3 — Strategy Stop & Closure Semantics — DONE

Evidence-Gap Strategy now distinguishes stop reasons instead of treating “legal actions remain” as “keep investigating”:

- `GAP_CLOSED` — current evidence is already enough to stop (required chain satisfied, or terminal negative evidence such as `not_planned`)
- `GAP_OPEN_ACTIONABLE` — a required gap remains and at least one mapped action can still advance it
- `GAP_OPEN_UNRESOLVABLE` — a required gap remains (typically semantic `resolution_effect`) and current GitHub actions cannot close it
- `NO_LEGAL_ACTION` — a required gap remains and no mapped action is left

Candidate PR discovery no longer freezes after the first unmerged PR. `resolution_effect` semantic alignment is not solved in this phase. Verifier / Recovery / Dataset / Ground Truth are unchanged.

## Phase 8.8.5 — Failure-to-Recovery-Target Resolution — DONE

RecoveryPlanner now derives `RecoveryPlan.nextRequirementIds` from existing InvestigationState / VerificationResult / EvidenceRequirement semantics. It still does not call GitHub, the LLM, or choose concrete tool calls.

```text
FailureAnalyzer          →  what failed
RecoveryPlanner          →  which evidence requirement(s) the next attempt must address
Evidence-Gap Strategy    →  which legal investigation actions can advance those requirements
IndependentCompletionVerifier →  only authority for verified completion
```

| Failure | Recovery target |
|---|---|
| `premature_completion` / `insufficient_evidence` / `retrieval_failure` | unchanged: verifier `missingRequirementIds` |
| `loop_failure` | current missing requirements when the verifier or Evidence Gap already names them; otherwise existing replan-once-then-stop |
| `invalid_evidence` | requirement IDs already associated with the invalid evidence (`EvidenceGap.evidenceIds`, `satisfiedBy`, or matching verification check ids); never evidence IDs |
| `tool_failure` | propagate verifier missing IDs when present; otherwise unchanged bounded retry/stop |
| `wrong_target` | never inherit requirements from the wrong issue; `resetEvidence` + `recheck_target` unchanged |

Empty / omitted `nextRequirementIds` still means unconstrained first-attempt / existing recovery behavior. `resolution_effect` is not turned into a retrieval requirement. IndependentCompletionVerifier, Ground Truth, GitHub Provider, and Evidence-Gap Strategy are unchanged.

## Phase 8.8.6 — Open-Issue Closure Semantics — DONE

`issue_closed rejected` is a verification condition, not an investigation terminal.

An open GitHub issue only proves the issue is not currently closed. It does not prove “unresolved” and must not empty `legalActions` after `get_issue`. Evidence-Gap Strategy now continues with timeline / comments / PR / files / commits while `issue_closed` remains rejected.

Terminal negative evidence is limited to `eligible_closure` (`not_planned`) and `issue_identity`. IndependentCompletionVerifier, EvidenceRequirement evaluation, Recovery, Dataset, and Ground Truth are unchanged: an open issue still cannot become `verified_complete`.

```text
Evidence Requirement rejected  ≠  Investigation Terminal Condition
issue_closed rejected          →  keep investigating
eligible_closure / identity rejected →  GAP_CLOSED
```

## Phase 9.0 — Investigation Experience / UI Information Architecture — DONE

Presentation-only rewrite of the Investigation result page. Agent investigation and Harness verification stay in separate lanes. Chinese labels are deterministic mappings, not a second LLM pass. Runtime, verifier, Evidence Graph, Recovery, Strategy, Benchmark, Ground Truth, and GitHub Provider semantics are unchanged.

## Phase 9.0.1 — Truthful Investigation Findings — DONE

Presentation-only correction of two Phase 9.0 UI inferences:

1. Evidence absence is not a negative investigation result. Findings require an actual investigation step / tool result (`session.steps`, attempt tool failure) plus the corresponding evidence. Timeline, comments, or PR-file inspection do not prove the agent retrieved related PRs. Tool failure stays in Failure / Recovery and is never rewritten as “未发现”.
2. Agent conclusion is only the authored Agent report. Missing or Harness-filled templates use a presentation fallback (“当前没有可展示的 Agent 调查结论。”) and never a first-person fake conclusion.

```text
Investigation Activity + Evidence / Result → Presentation Finding
authored Agent report → Agent conclusion
Harness verification → Harness lane
```

Finding `source` is internal: `investigation_step` | `tool_result` | `agent_report`. No new runtime events, evidence types, LLM calls, or GitHub calls.

## Phase 8.x — Retrieval Measurement Contract — DONE

Instrumentation only. Ranking, discovery, investigation budget, verifier, and recovery are unchanged.

`RETRIEVAL_TOP_K = 5` (combined Recall@K / Precision@K list) is independent of `MAX_INVESTIGATED_CANDIDATES = 5` (per source type). `promoted` is a later lifecycle state and is not investigation success.

```text
Discovery
  → Ranking
  → Retrieval Top-K          retrievalTopKCandidates
  → Investigation Budget     investigationCandidates
  → Investigation            investigatedCandidates
  → Promotion                promotedCandidates
  → Evidence
  → Verification
```

Investigation success remains: expected candidate entered the budget (`investigating` or `promoted`). Combined Recall@K can miss a candidate that is still inside the per-type budget (C08).

## Phase 10.0 — Resolution Effect Analysis MVP — DONE

Adds Candidate Resolution Evidence Analysis between Investigation Agent observations and Independent Completion Verifier. The new Resolution Analyzer produces investigation claims only.

```text
Issue
  → Candidate Retrieval
  → Investigation Agent
  → Resolution Analyzer
  → Evidence Graph provenance
  → Independent Verifier
```

Three code-constrained signals: `file_scope_alignment`, `patch_intent_alignment`, `test_evidence`. Structured status is assigned by code. LLM prose cannot set signal status, cannot produce `VERIFIED_COMPLETE`, and cannot treat merged PR or PR title/body as resolution proof.

IndependentCompletionVerifier, Ground Truth, Real-v1 snapshots, retrieval ranking, discovery, Evidence-Gap Strategy, RecoveryPlanner, and FailureAnalyzer are unchanged.

## Phase 10.2 — Resolution Gap Analyzer — DONE

Adds Failure Localization + Recovery Signal after Resolution Chain. The analyzer explains why the current Resolution Explanation cannot support further verification. It is not a verifier and cannot produce `VERIFIED_COMPLETE`.

```text
Issue
  → Investigation Agent
  → Evidence Graph
  → Resolution Analyzer
  → Resolution Chain
  → Resolution Gap Analyzer
  → Recovery Planner   (adapter only; suggestions are not executed)
```

Deterministic rules emit `ResolutionGap` values (`missing_patch_evidence`, `insufficient_resolution_context`, …). Every gap cites existing Evidence IDs. Unknown evidence is never claimed as absent. Recovery suggestions are not auto-executed. IndependentCompletionVerifier remains the only completion authority.

Evaluation: [`docs/evaluation/phase-10.2-resolution-gap.md`](evaluation/phase-10.2-resolution-gap.md)

## Not started

Later phases wait for a new task.
