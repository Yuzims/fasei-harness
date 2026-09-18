# Final Frontend / Backend / API / Integration Audit

Date: 2026-09-18

Audit started from checkpoint `83366e6977bb31d24c01ae2c7af380f3c456bd08` (`feat: validate closed-loop recovery`) on `main`, clean working tree. Conclusions below are from current source, tests, a live `npm run api` + `npm run web` session, and browser interaction. They are not inferred from file names.

## 1. Repository State

| Field | Value |
|---|---|
| Start commit | `83366e6977bb31d24c01ae2c7af380f3c456bd08` |
| Branch | `main` (tracks `origin/main`) |
| Working tree at start | clean |
| Node | v22.14.0 |
| `npm test` after wiring | **218 pass / 0 fail** |
| `npm run build` after wiring | **pass** (`tsc` + Vite `web/dist`) |
| Live API | `http://127.0.0.1:8787/api/health` |
| Live UI | `http://localhost:5173/` (Vite proxies `/api` → `:8787`) |

At the checkpoint, Investigation Runtime / Verifier / Recovery / Real-v1 Benchmark already existed and were covered by tests and CLI (`npm run benchmark:real`, `npm run benchmark:recovery`). The HTTP API and React app were still the older Workspace Agent console. That was a real disconnect, not a missing backend.

This audit phase added a **thin** Investigation API + UI that calls the existing `executeScenario()` / `investigate()` path. It did not add a second runtime, a second verifier, new failure types, or a second benchmark evaluator.

## 2. Architecture

What actually exists now:

```text
React UI  (web/)
  InvestigationView  (default)
  Workspace Agent views  (legacy console)
        ↓  fetch /api/*
Hono API  (src/server/app.ts)
        ↓
Investigation service  (src/server/investigation-service.ts)
        ↓
executeScenario() / investigate()
        ↓
SnapshotGitHubProvider  (recorded Real-v1 / fixtures)
        ↓
AgentLoop + investigation tools
        ↓
Evidence Graph / Claims
        ↓
IndependentCompletionVerifier
        ↓
FailureAnalyzer → RecoveryPlanner → applyRecovery → new Attempt
        ↓
Re-verification
        ↓
InvestigationSessionDTO → UI
```

Legacy path, still wired and tested, is **not** the Investigation product path:

```text
Workspace Agent UI
  ↓
/api/agent/run(/stream)  /api/runs  /api/benchmark  /api/retrieval
  ↓
Workspace Harness + WorkspaceCompletionVerifier + src/legacy recovery
```

CLI Benchmark remains the evaluator for Real-v1:

```text
npm run benchmark:real
  → Dataset loader → Scenario → investigate() → Evaluator (ground-truth.json)
  → benchmark-results/real-v1/latest.json
  → GET /api/fasei-benchmark/real-v1  (read-only display)
```

Components that do **not** exist: investigation persistence (`GET /api/investigations/:id`), live GitHub Investigation API, a second Benchmark evaluator in the UI.

## 3. Backend Audit

| Capability | Status | Evidence |
|---|---|---|
| Investigation | PASS | `investigate()` in `src/investigation/investigation-agent.ts` creates a task/run, loops attempts, returns `InvestigationAgentReport`. Live `POST /api/investigations` for `microsoft/vscode#258694` returned `catalogId=C01`, `actor=test_driver`, `verification.status=verified_complete`. |
| Agent Loop | PASS | Same `AgentLoop` as production. Snapshot driver / injected recovery models decide tools; tools write evidence. UI showed `github_get_issue` → timeline → PRs → files → commits → `record_claim` for C01. |
| Evidence | PASS | Evidence objects + relations produced by investigation tools. C01 UI listed issue/PR/commit evidence from the snapshot, not hardcoded copy. |
| Verification | PASS | `IndependentCompletionVerifier` only. C01 UI showed `verified_complete` and independent checks. Agent conclusion in the report still says claims are hypotheses. |
| Failure Analysis | PASS | Production `FailureAnalyzer`. tool-failure UI: Attempt 1 `Failure: tool_failure — injected timeout for benchmark tool_failure`. |
| Recovery | PASS | Production `RecoveryPlanner` + `applyRecoveryPlan`. tool-failure UI: Attempt 1 `retry_with_backoff`, Attempt 2 `strategy: retry_failed_tool`, parent `attempt-1`, final `verified_complete`. |
| Benchmark | PASS | Real-v1 and recovery suites run through the same Harness. CLI: `npm run benchmark:real` / `npm run benchmark:recovery`. Tests cover dataset isolation from ground truth. Real-v1 last CLI result: 8/10 evaluator pass, `taskSuccessRate=0.6`, `recoveryRate=0`. |

GitHub data: Snapshot Provider is the demo/API path. `LiveGitHubProvider` exists for the Workspace Agent GitHub tools and for capture scripts. The Investigation HTTP API **refuses** unknown issues instead of silently calling live GitHub.

## 4. API Audit

Framework: **Hono** on `@hono/node-server`. Start: `npm run api` / `npm run start` (`src/server/listen.ts`, port 8787). Dev UI: `npm run web` or `npm run dev`.

| Method | Endpoint | Purpose | Runtime | Frontend | Status |
|---|---|---|---|---|---|
| GET | `/api/health` | liveness | none | none | PASS |
| GET | `/api/investigations/catalog` | Real-v1 + fixture + recovery catalog | dataset loader + scenario lists | InvestigationView | PASS |
| POST | `/api/investigations` | run one investigation | `executeScenario()` → `investigate()` | InvestigationView | PASS |
| GET | `/api/fasei-benchmark/real-v1` | last Real-v1 CLI JSON | reads `benchmark-results/real-v1/latest.json` | InvestigationView | PASS (display only) |
| GET | `/api/agent/status` | LLM config | `describeLlm` | AgentView | PASS (legacy) |
| GET | `/api/agent/examples` | workspace examples | static | AgentView | PASS (legacy) |
| POST | `/api/agent/run` | workspace agent | Workspace `Harness` + `WorkspaceCompletionVerifier` | none (stream used) | PASS (legacy) |
| POST | `/api/agent/run/stream` | workspace agent SSE | same as `/api/agent/run` | AgentView | PASS (legacy) |
| GET | `/api/scenarios` | injection scenarios | `src/eval/cases.ts` | RunView | PASS (legacy) |
| POST | `/api/runs` | injection run | `src/eval/benchmark.ts` | RunView | PASS (legacy) |
| GET | `/api/benchmark` | injection 3-mode scores | `runBenchmark()` | OverviewView / BenchmarkView | PASS (legacy) |
| GET | `/api/retrieval` | retrieval ablation | `runRetrievalAblation()` | RetrievalView | PASS (legacy) |

Investigation request: `{ issue }` or `{ caseId }` or `{ scenarioId }` (also `owner` / `repository` / `issueNumber`). Response is `InvestigationSessionDTO` derived from the real `InvestigationAgentReport` (evidence payloads stripped; summaries / ids / verifier checks / attempts kept). Errors: 400 for missing identity, 404 for unknown snapshot / scenario. No mock body.

Not present, on purpose:

- No `GET /api/investigations/:id` store.
- No live GitHub Investigation route.
- No `POST /api/fasei-benchmark/real-v1` that re-runs the evaluator in the request path.

Tests added in `tests/server.test.ts` cover C01 `verified_complete`, tool-failure two-attempt recovery, unknown issue 404, and Real-v1 JSON read.

## 5. Frontend Audit

Entry: `web/src/main.tsx` → `App.tsx`. Default hash route is Investigation (`#/`). Workspace Agent remains at `#/agent`.

| Capability | Status | Notes |
|---|---|---|
| Issue Input | PASS | Text area accepts `owner/repo#n`. Default `microsoft/vscode#258694`. |
| Start Investigation | PASS | `Start Investigation` → `POST /api/investigations`. Catalog chips for C01–C10 and recovery scenarios. |
| Progress | PASS | Attempts, strategy, tool-call list from runtime steps. |
| Evidence | PASS | Rendered from API evidence list (kind / summary / trust). |
| Claims | PASS | Rendered from API claims. |
| Verification | PASS | Independent verifier status + checks. C01 live UI: `verified_complete`. |
| Failure | PASS | Attempt panel shows `failureType` / reason. |
| Recovery | PASS | Attempt panel shows recovery action / next strategy / parent attempt. |
| Final Report | PASS | Conclusion + uncertainty + open questions from runtime report. |
| Benchmark | PARTIAL | Real-v1 last CLI result is displayed. UI does not re-run Real-v1. Legacy injection benchmark UI still exists under 对照 / 评测. |

UX-only: recovery scenarios that use `modelFactory` are labeled `actor=llm` even though the model is a deterministic injected driver (`src/investigation/investigation-agent.ts`). The run is still the production loop, not a fake JSON blob.

## 6. Integration Test

Executed in the browser against the live Vite + Hono processes.

**Input:** `microsoft/vscode#258694` → Start Investigation

**Data source:** Real-v1 **Snapshot** `fixtures/benchmark/dataset/real-v1/cases/C01/snapshot.json` (not live GitHub)

**Call chain observed:**

```text
UI issue field
  → POST /api/investigations  { issue: "microsoft/vscode#258694" }
  → match Real-v1 C01
  → convertCaseToScenario()  (no ground-truth copy)
  → executeScenario() → SnapshotGitHubProvider → investigate({ useTestDriver: true })
  → Evidence + Claims + IndependentCompletionVerifier
  → InvestigationSessionDTO
  → UI
```

**Frontend result (live):**

- `microsoft/vscode#258694 · snapshot C01 · actor=test_driver`
- Tool calls: `github_get_issue`, timeline, PR `#275576` / `#284149`, files, commits, `record_claim`
- Verifier: `verified_complete`
- Report uncertainty still states that the Agent conclusion is not verification

`actor=test_driver` is correct: this is the same deterministic Snapshot Investigation Driver used by Real-v1 / tests. It is not a hidden LLM and not a hardcoded frontend string.

## 7. Recovery Integration

Executed in the browser: chip `tool-failure` → `POST /api/investigations { scenarioId: "tool-failure" }`.

**Data source:** synthetic fixture snapshot `fixtures/github/resolved.json` plus existing benchmark-boundary timeout injection. Not Real-v1. Not live GitHub.

**Observed in UI:**

```text
Attempt 1 · failed
  strategy: observe_issue
  Failure: tool_failure — injected timeout for benchmark tool_failure
  Recovery: retry_with_backoff
  Verifier: insufficient_evidence
  tool: github_get_issue fail

Attempt 2 ← attempt-1 · verified
  strategy: retry_failed_tool
  Verifier: verified_complete
  tool: github_get_issue ok → timeline → PR #7 files/commits → record_claim
```

Backend capability: PASS. Frontend visibility: PASS for this synthetic closed-loop. Real-v1 itself still often stops at one attempt (`recoveryRate=0` in latest.json); that is existing benchmark behavior, not a UI gap.

## 8. Demo Readiness

### What works

- Snapshot Investigation from the Web UI (Real-v1 C01–C10 and the three GitHub fixtures).
- Independent verification rendered separately from Agent prose.
- Failure → Recovery → Attempt 2 → re-verification for Phase 7.3 synthetic scenarios.
- Real-v1 last CLI metrics on the same page.
- Existing Workspace Agent console still runs for write / retrieval / calculator demos.
- Tests + production build succeed.

### What is partially implemented

- Benchmark in the UI is **display of the last CLI run**, not a button that re-executes Real-v1.
- Investigation API is request/response, not a persisted investigation store.
- README still describes the older Workspace Agent product (not rewritten in this phase).

### What is missing

- Live GitHub Investigation from the Web UI (unknown issues return 404 on purpose).
- Live LLM Investigation from the Web UI (snapshot demo uses `test_driver`).
- `GET /api/investigations/:id` history.
- A dedicated Real-v1 “Run benchmark” API (CLI remains `npm run benchmark:real`).

### What blocks a complete live-GitHub / live-LLM demo

- No Investigation API path to `LiveGitHubProvider` + `OpenAICompatModel`. Backend already supports that combination in `investigate()` when a key is configured and a provider is passed; the HTTP layer does not expose it.

That does **not** block a snapshot-based interview demo of the product loop.

### What is optional

- Polishing copy, streaming Investigation SSE, deleting the legacy Workspace tabs, rewriting README.

## 9. Final Status

**Backend: PASS**

Investigation create/execute, Agent Loop, Snapshot Provider, Evidence, Independent Verifier, Failure Analyzer, Recovery Planner, apply recovery, new attempt, re-verification, and Benchmark all exist as one production path and were executed for real (tests + live API + UI).

**API: PASS**

Hono routes for Investigation catalog / run / Real-v1 result display call the existing runtime or the recorded CLI result. They are not mock handlers. Legacy Workspace routes remain and still work. Completeness is snapshot-oriented: no persistence, no live GitHub Investigation endpoint.

**Frontend: PASS**

A user can enter a recorded GitHub Issue, start an Investigation, and see status, tools, evidence, claims, verification, failure, recovery, and the final report. Benchmark visibility is the last Real-v1 CLI file. The old Workspace console is still available as a secondary tab.

**Integration: PASS**

Live browser run: UI → `POST /api/investigations` → `executeScenario`/`investigate` → Snapshot runtime → DTO → UI, for both C01 success and tool-failure recovery. Values in the UI matched the runtime (`snapshot C01`, `test_driver`, `verified_complete`, Attempt 1/2 recovery).

**Demo: PASS**

A GitHub README / interview demo can run `npm run api` + `npm run web`, open Investigation, play `microsoft/vscode#258694`, then `tool-failure`. The loop is real and snapshot-based. It is not a live-LLM GitHub crawler, and the README has not been rewritten to match this UI yet.
