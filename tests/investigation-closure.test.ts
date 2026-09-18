/**
 * Phase 8.8.2.3 — Strategy stop and closure semantics.
 * Deterministic: no live LLM / GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
  createRelation,
} from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  GAP_CLOSED_REASON,
  IndependentCompletionVerifier,
  computeEvidenceGap,
  decideInvestigationClosure,
  investigate,
  planInvestigationStrategy,
  proposeCandidateActions,
} from "../src/investigation/index.js";
import { InvestigationState, resourceKey } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import type { Model, ModelResponse } from "../src/agent/model.js";

const now = "2026-09-18T00:00:00.000Z";

function provenance(resource: string) {
  return {
    source: "github" as const,
    repository: "acme/box",
    resource,
    url: `https://github.com/acme/box/${resource}`,
    retrievedAt: now,
    trust: "external_untrusted" as const,
  };
}

function makeState(issueNumber = 42): InvestigationState {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber },
  });
  return new InvestigationState(task, createInvestigationRun({ task }));
}

function addClosedIssue(
  state: InvestigationState,
  extra?: { body?: string; title?: string; stateReason?: string; state?: "open" | "closed" },
) {
  const number = state.task.target.issueNumber;
  const evidence = createEvidence({
    kind: "issue",
    summary: `Issue #${number} is ${extra?.state ?? "closed"}`,
    payload: {
      number,
      repository: "acme/box",
      state: extra?.state ?? "closed",
      stateReason: extra?.stateReason,
      title: extra?.title ?? "Null pointer when saving empty cart",
      body: extra?.body ?? "Saving an empty cart throws. Please fix.",
    },
    provenance: provenance(`issues/${number}`),
    contentRef: resourceKey("issue", String(number)),
  });
  state.addEvidence(evidence);
  state.investigatedResources.add(resourceKey("issue", String(number)));
  state.issueState = extra?.state ?? "closed";
  return evidence;
}

function addPr(
  state: InvestigationState,
  issueId: string,
  pullNumber: number,
  merged: boolean,
  extra?: { title?: string; body?: string },
) {
  const pr = createEvidence({
    kind: "pull_request",
    summary: `PR #${pullNumber} merged=${merged}`,
    payload: {
      number: pullNumber,
      repository: "acme/box",
      merged,
      state: merged ? "closed" : "open",
      title: extra?.title ?? (merged ? "Fix empty cart save" : "WIP empty cart"),
      body: extra?.body ?? `Fixes #${state.task.target.issueNumber}`,
    },
    provenance: provenance(`pull/${pullNumber}`),
    contentRef: resourceKey("pr", String(pullNumber)),
  });
  const merge = createEvidence({
    kind: "pull_request",
    summary: `PR #${pullNumber} merged=${merged}`,
    payload: { number: pullNumber, merged, mergeCommitSha: merged ? "abc123" : null },
    provenance: provenance(`pull/${pullNumber}`),
    contentRef: resourceKey("pr-merge", String(pullNumber)),
  });
  state.addEvidence(pr);
  state.addEvidence(merge);
  state.addRelation(createRelation({ fromEvidenceId: pr.id, toEvidenceId: issueId, type: "fixes" }));
  state.addCandidatePr(pullNumber);
  state.investigatedResources.add(resourceKey("pull", String(pullNumber)));
  if (merged) {
    state.mergedPrs.add(pullNumber);
  } else {
    state.unmergedPrs.add(pullNumber);
  }
  return pr;
}

function addFileAndCommit(
  state: InvestigationState,
  prId: string,
  pullNumber: number,
  extra?: { filename?: string; message?: string },
) {
  const file = createEvidence({
    kind: "file",
    summary: `PR #${pullNumber} modified ${extra?.filename ?? "src/cart.ts"}`,
    payload: { filename: extra?.filename ?? "src/cart.ts", status: "modified" },
    provenance: provenance(`pull/${pullNumber}/files/${extra?.filename ?? "src/cart.ts"}`),
    contentRef: resourceKey("file", `${pullNumber}:${extra?.filename ?? "src/cart.ts"}`),
  });
  const commit = createEvidence({
    kind: "commit",
    summary: extra?.message ?? "Commit abc123: Fix empty cart save",
    payload: {
      sha: `abc${pullNumber}def456`,
      repository: "acme/box",
      message: extra?.message ?? "Fix empty cart save\n\nFixes #42",
    },
    provenance: provenance(`commit/abc${pullNumber}`),
    contentRef: resourceKey("commit", `abc${pullNumber}def456`),
  });
  state.addEvidence(file);
  state.addEvidence(commit);
  state.addRelation(createRelation({ fromEvidenceId: file.id, toEvidenceId: prId, type: "derived_from" }));
  state.addRelation(createRelation({ fromEvidenceId: commit.id, toEvidenceId: prId, type: "derived_from" }));
  state.investigatedResources.add(resourceKey("files", String(pullNumber)));
  state.investigatedResources.add(resourceKey("commits", String(pullNumber)));
  state.filesByPr.set(pullNumber, [extra?.filename ?? "src/cart.ts"]);
  return { file, commit };
}

function firstLegalModel(): Model {
  return {
    async decide(_task, _history, _toolResults, context): Promise<ModelResponse> {
      const legal = context?.legalInvestigationActions ?? [];
      const github = legal.find((item) => item.tool.startsWith("github_"));
      if (!github) {
        return { type: "final", message: "No legal GitHub investigation actions remain. Not verified." };
      }
      return {
        type: "tool_call",
        call: {
          id: "next-legal",
          name: github.tool,
          arguments: github.arguments,
        },
      };
    },
  };
}

test("GAP_CLOSED when required evidence is already sufficient", () => {
  const state = makeState();
  const issue = addClosedIssue(state);
  const pr = addPr(state, issue.id, 7, true);
  addFileAndCommit(state, pr.id, 7);
  state.claimsRecorded = true;
  const planned = planInvestigationStrategy(state);
  assert.equal(planned.closure, "GAP_CLOSED");
  assert.equal(planned.legalActions.length, 0);
  assert.equal(planned.closureReason, GAP_CLOSED_REASON);
});

test("GAP_CLOSED leftover candidate files are not a reason to continue", () => {
  const state = makeState();
  const issue = addClosedIssue(state);
  const pr = addPr(state, issue.id, 7, true);
  addFileAndCommit(state, pr.id, 7);
  state.addCandidatePr(99);
  state.addCandidatePr(100);
  state.claimsRecorded = true;
  const legal = proposeCandidateActions(state);
  assert.equal(
    legal.some(
      (item) =>
        item.tool === "github_get_pull_request_files" ||
        (item.tool === "github_list_commits" && item.arguments.pullNumber !== undefined),
    ),
    false,
  );
  const planned = planInvestigationStrategy(state);
  assert.equal(planned.closure, "GAP_CLOSED");
  assert.equal(planned.legalActions.length, 0);
});

test("GAP_CLOSED on explicit non-resolution (not_planned)", () => {
  const state = makeState();
  addClosedIssue(state, { stateReason: "not_planned" });
  state.addCandidatePr(616);
  const gap = computeEvidenceGap(state.task, state.run);
  assert.equal(
    gap.rejectedRequirements.some((item) => item.condition === "eligible_closure"),
    true,
  );
  const legal = proposeCandidateActions(state, { gap });
  assert.equal(legal.some((item) => item.tool.startsWith("github_")), false);
  const planned = planInvestigationStrategy(state, { gap });
  assert.equal(planned.closure, "GAP_CLOSED");
  assert.equal(planned.legalActions.length, 0);
});

test("GAP_OPEN_ACTIONABLE while an unused candidate can still advance the gap", () => {
  const state = makeState();
  addClosedIssue(state);
  const planned = planInvestigationStrategy(state);
  assert.equal(planned.closure, "GAP_OPEN_ACTIONABLE");
  assert.equal(
    planned.legalActions.some(
      (item) =>
        item.tool === "github_get_issue_timeline" ||
        item.tool === "github_get_issue_comments" ||
        item.tool === "github_list_commits",
    ),
    true,
  );
});

test("first unmerged candidate does not freeze later unfetched PRs", () => {
  const state = makeState();
  const issue = addClosedIssue(state);
  addPr(state, issue.id, 275576, false, {
    title: "Terminal suggest widget",
    body: "References #42",
  });
  state.addCandidatePr(284149);
  const gap = computeEvidenceGap(state.task, state.run);
  assert.equal(
    gap.items.find((item) => item.condition === "resolution_candidate")?.outcome,
    "satisfied",
  );
  assert.equal(
    gap.items.find((item) => item.condition === "resolution_merged")?.outcome,
    "rejected",
  );
  const legal = proposeCandidateActions(state, { gap });
  const nextPr = legal.find(
    (item) => item.tool === "github_get_pull_request" && item.arguments.pullNumber === 284149,
  );
  assert.ok(nextPr);
  assert.equal(
    legal.some((item) => item.tool === "github_get_pull_request" && item.arguments.pullNumber === 275576),
    false,
  );
  const planned = planInvestigationStrategy(state, { gap });
  assert.equal(planned.closure, "GAP_OPEN_ACTIONABLE");
  assert.equal(
    planned.legalActions.some(
      (item) => item.tool === "github_get_pull_request" && item.arguments.pullNumber === 284149,
    ),
    true,
  );
});

test("GAP_OPEN_UNRESOLVABLE when landed code exists but resolution_effect stays missing", () => {
  const state = makeState();
  const issue = addClosedIssue(state, {
    title: "Null pointer when saving empty cart",
    body: "Saving an empty cart throws.",
  });
  const pr = addPr(state, issue.id, 7, true, {
    title: "Update changelog formatting",
    body: "Docs only. Fixes #42",
  });
  addFileAndCommit(state, pr.id, 7, {
    filename: "CHANGELOG.md",
    message: "Update changelog formatting\n\nFixes #42",
  });
  state.claimsRecorded = true;
  const gap = computeEvidenceGap(state.task, state.run);
  assert.equal(gap.items.find((item) => item.condition === "resolution_merged")?.outcome, "satisfied");
  assert.equal(gap.items.find((item) => item.condition === "resolution_effect")?.outcome, "missing");
  const planned = planInvestigationStrategy(state, { gap });
  assert.equal(planned.closure, "GAP_OPEN_UNRESOLVABLE");
  assert.equal(planned.legalActions.length, 0);
  const decided = decideInvestigationClosure({
    gap,
    legalActions: proposeCandidateActions(state, { gap }),
    state,
  });
  assert.equal(decided.status, "GAP_OPEN_UNRESOLVABLE");
});

test("NO_LEGAL_ACTION when the gap is still open and no mapped action remains", () => {
  const state = makeState(7);
  addClosedIssue(state);
  state.investigatedResources.add(resourceKey("timeline", "7"));
  state.investigatedResources.add(resourceKey("comments", "7"));
  state.investigatedResources.add(resourceKey("commits", "repo"));
  state.claimsRecorded = true;
  const planned = planInvestigationStrategy(state);
  assert.equal(planned.closure, "NO_LEGAL_ACTION");
  assert.equal(planned.legalActions.length, 0);
  assert.ok(planned.gap.missingRequirements.length > 0);
});

test("not_planned stops the loop without chasing phantom PR files", async () => {
  const stateSeed = makeState();
  addClosedIssue(stateSeed, { stateReason: "not_planned" });
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    model: firstLegalModel(),
    trace,
    maxAttempts: 1,
    prepareSession: (session) => {
      session.state.addEvidence(stateSeed.run.evidence[0]!);
      session.state.investigatedResources.add(resourceKey("issue", "42"));
      session.state.issueState = "closed";
      session.state.addCandidatePr(616);
    },
  });
  assert.equal(result.agentResult?.decision, "gap_closed");
  assert.notEqual(result.agentResult?.decision, "final");
  assert.equal(
    result.investigationSteps.some(
      (step) =>
        step.tool === "github_get_pull_request_files" ||
        step.tool === "github_list_commits" ||
        step.tool === "github_get_pull_request",
    ),
    false,
  );
  assert.notEqual(result.verification?.status, "verified_complete");
  const independent = new IndependentCompletionVerifier().verify({
    task: result.task,
    run: result.run,
  });
  assert.equal(result.verification?.status, independent.status);
  const blocked = trace.getEvents().find((event) => event.type === "investigation_blocked");
  assert.equal(blocked?.data.code, "GAP_CLOSED");
});
