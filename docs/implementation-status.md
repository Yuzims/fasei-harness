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

## Not started

Phase 7.3+ waits for a new task.
