# Phase 18 — Resolution Attribution Hardening

## Status

Direction approved by owner 2026-09-22 (prescan + attribution invariants +
unlinked-fix hints + completeness). Implementation not started. Motivated by
the react/react#37610 misattribution found by independent GitHub cross-check
on 2026-09-22.

## Problem statement

The verifier certifies that records are internally consistent, but the
resolution **attribution** (which PR fixes this issue) is currently produced by
mechanical but semantically unsound derivation, and nothing downstream rejects
causally impossible candidates.

### Case study: react/react#37610 (live run 2026-09-22)

Ground truth (direct GitHub API):

- Issue opened `2026-09-12`, still open; label `Status: Unconfirmed`; reporter
  regression later reproduced in comments (free text).
- PR #34069 merged `2025-08-15` — **13 months before the issue existed**. Its
  title matches the issue subject; a comment states the regression *originates
  from* the validation added in #34069. It is the cause, not the fix.
- PR #37626 (`2026-09-14`) is the real fix candidate: **open, unmerged**, and it
  is the *only* PR with a structured `closingIssuesReferences` link to #37610.
- Issue REST timeline contains **zero** `cross-referenced` events; the
  authoritative link lives only in GraphQL `closingIssuesReferences`.

Harness output: `not_verified` (right direction, wrong reasons), with
`resolution-candidate=pass`, `pr-merged=pass ("Resolution path landed")`,
`code-commit=pass`, `claims-supported=pass` — all on the causally wrong PR.
#37626 was never discovered (LLM budget 8/8 exhausted on the title match).

## Root causes (anchored)

1. **`fixes` is derived from "is a candidate AND merged".**
   `src/investigation/investigation-tools.ts` `linkIssueGraph` /
   `linkPullGraph`: `relate(pr, issue, merged ? "fixes" : "references")`.
   Any fetched merged PR becomes a resolution claim regardless of timing or
   structured corroboration.
2. **No temporal invariant.** Neither relation building nor
   `src/verification/independent-completion-verifier.ts` (`pr-merged`,
   `resolution-candidate`) compares candidate merge/creation time against
   `issue.createdAt`. The refutation is pure field comparison — zero NLP.
3. **Candidate discovery is unbounded-but-shallow.** The agent stops at the
   first title match; enumeration sources that are finite and machine-readable
   (GraphQL `closingIssuesReferences`, timeline cross-references) are not used
   as the candidate feed.
4. **Completeness is invisible.** A verdict assembled from an unfinished
   investigation is indistinguishable (to users) from one where the structured
   evidence chain was exhausted. Budget exhaustion currently masquerades as
   convergence.
5. Timestamp capture exists but is not surfaced to decisions:
   `src/github/normalize.ts` keeps `createdAt`/`closedAt`, but PR
   `mergedAt`/issue-`created_at` do not participate in any check and (some) are
   absent from the DTO.

## Principles

- **Text proposes, fields dispose.** Free text (titles, bodies, comments) may
  only *rank or explain candidates*; certification consumes only structured
  machine records. This keeps [[project-core-architecture-invariants]] intact.
- **Exhaustion is achievable on the structured side.** The authoritative
  reference sets are finite API queries with no LLM cost. "We ran out of
  budget" must never hide a candidate that a deterministic query would have
  found.
- **Hypothesis typing, not rule stacking.** We are not adding rule #472; we are
  demoting one class of guess (`agent-asserted fixes`) to `hypothesis` status
  and letting the existing fail-priority machinery do the rest.

## Scope

### 18-A — Deterministic resolution-reference pre-scan (no LLM)

Before the agent loop runs, a structured pass performs:

1. GraphQL `issue.timelineItems`/`closingIssuesReferences` (inverse: PRs whose
   closing refs point at the target issue) → authoritative candidate list.
2. REST issue timeline `cross-referenced` events → additional candidates.
3. Fetch minimal PR facts for each candidate: `state`, `merged`, `mergedAt`,
   `base.ref`, `created_at`.

Ingested as evidence with `source: harness_structured`; candidates feed the
agent as *known* so LLM budget goes to semantics, not rediscovery.

### 18-B — Attribution invariants in relations + verifier

- `fixes` is only stamped from **structured corroboration** (18-A sources).
  `linkIssueGraph`/`linkPullGraph` "merged ⇒ fixes" is removed; a
  merged-but-uncorroborated PR link degrades to `candidate` (new relation type)
  or `references`.
- Agent-proposed `fixes` (via `add_relation`) enter the graph typed as
  `hypothesis_fixes` — never counted by the verifier as proof.
- **Temporal guard** in verifier `resolution-candidate` / `pr-merged`
  evaluation: a candidate whose `mergedAt` (or PR `created_at`) precedes
  `issue.created_at` cannot satisfy resolution attribution → check `fail` with
  structured explanation fields; DTO carries the timestamps through
  (`src/api/dto.ts` additions).
- **Unlinked-fix candidate hints (exhaustive, hypothesis-only).** When no
  structured corroboration exists (silent-fix case), enumerate mechanically:
  commits on the base branch with `committer date ∈ [issue.created_at, HEAD]`
  whose changed files intersect the file set of the investigated candidates
  (e.g. #37626's files). Present as 「时间窗内 N 个 commit 触及涉事文件」 with
  links — narrows the user's search, never feeds any check. Constraint stated
  honestly: with zero candidate PRs (nothing fetched), the file set degrades
  to files named in structured evidence only (timeline refs, PR files of
  unmerged candidates); no title/text similarity participates.

### 18-C — Completeness dimension on the verdict

- Session gains `attributionCoverage`: `{ prescanCompleted, candidatesEnumerated,
  candidatesAdjudicated }`; prescan completion is machine-decidable.
- Verifier output distinguishes `not_verified (attribution exhausted)` from
  `insufficient_evidence (prescan incomplete / budget exhausted)`.
- Presentation (17-B2 hero): when the structured chain was exhausted and all
  merged candidates were refuted on fields, the narrative may state
  「已合并候选均被排除，修复仍在未合并 PR 中」; when not exhausted, hero must
  label itself 中间结论 with a 「继续调查」 affordance (resume reuses collected
  evidence; no re-investigation from zero).

## Non-goals

- No NLP/embedding judgment in the verifier (comments stay untrusted evidence).
- No unlimited retry of LLM discovery; budget stays per-run, coverage flag
  carries the honesty.
- No behavioral/repro evidence (that is the deferred Resolution-Effect channel;
  18-C wording must stay compatible with it).

## Acceptance criteria

1. Regression fixture captured from react/react#37610 (issue 2026-09-12 open;
   #34069 merged 2025-08-15; #37626 open + closingIssuesReferences) replays to:
   `pr-merged` not pass on #34069 (temporal guard fail with explanation),
   #37626 enumerated by prescan without any LLM call, verdict `not_verified`
   with narrative 「修复候选仍未合并」.
2. Unit: `merged ⇒ fixes` no longer produces certified attribution; hypothesis
   relations cannot flip `claims-supported`/`pr-merged`.
3. Unit: prescan-incomplete sessions cannot produce exhausted vocabulary;
   exhausted + all-refuted sessions can.
3b. Unit: unlinked-fix hint list is exhaustive over the time-window ∩ file-set
   intersection and cannot flip any verifier check (hypothesis typing asserted).
4. Existing 772-test suite green; snapshot fixtures re-captured only where
   `fixes` derivation changes verdicts (justify each diff).
5. Live smoke: react#37610 through the workbench; hero must not display
   「已合并 Pull Request ✓」 for #34069.

## Risks

- GraphQL adds a second API surface (auth scope, rate limits, and react/react's
  301 rename shows owner/repo resolution must be normalized first).
- Silent-merge repos (fixes with zero structured refs) will land in
  `insufficient_evidence` more often — accepted: honesty over false
  convergence, and the behavioral channel is the designated upgrade path.
- 18-C resume semantics touch session lifecycle; if complexity grows, ship
  18-A + 18-B first and gate 18-C's 「继续调查」 behind a follow-up sub-phase.
