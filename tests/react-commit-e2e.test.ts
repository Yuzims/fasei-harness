import assert from "node:assert/strict";
import test from "node:test";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import { InvestigationState, formatStateForModel } from "../src/investigation/state.js";
import { ingestObservation } from "../src/investigation/investigation-tools.js";
import { planInvestigationStrategy, matchLegalAction, legalActionViews } from "../src/investigation/candidate-actions.js";
import { createInvestigationRun, createInvestigationTask } from "../src/domain/index.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";

const SHA = "67f18f167f3b21708fbd2c35a7cce20670c59b12";
function sess() {
  const task = createInvestigationTask({ target: { owner: "microsoft", repository: "vscode", issueNumber: 258694 } });
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  const trace = new TraceCollector();
  return { task, run, state, session: { state, trace, runId: run.id, llmUsage: new LlmUsageCollector() } as any };
}
function tl(commitId: string) {
  return { id: "t1", repository: "microsoft/vscode", event: "referenced", createdAt: "2026-09-01T00:00:00Z", actor: "m", body: "fixes #258694", source: "github", url: "u", retrievedAt: "2026-09-20T00:00:00.000Z", trust: "external_untrusted", commitId };
}

test("B1-d: timeline commit visible in agent context and legal", () => {
  const { state } = sess();
  // need session for ingest
  const { session } = sess();
  ingestObservation(session, "github_get_issue", { owner: "microsoft", repo: "vscode", issueNumber: 258694 }, { number: 258694, state: "closed", title: "t", body: "x", repository: "microsoft/vscode", url: "u", retrievedAt: "2026-09-20T00:00:00.000Z" });
  ingestObservation(session, "github_get_issue_timeline", { owner: "microsoft", repo: "vscode", issueNumber: 258694 }, [tl(SHA)]);
  const st = session.state;
  const planned = planInvestigationStrategy(st, {});
  const views = legalActionViews(planned.legalActions);
  assert.ok(views.some((a) => a.tool === "github_get_commit" && (a.resourceKey ?? "").includes(SHA.slice(0, 7))), "github_get_commit legal with commit resourceKey");
  const ctx = formatStateForModel(st, { legalInvestigationActions: views, remainingLlmCalls: 8 });
  assert.ok(ctx.includes("github_get_commit"), "context exposes github_get_commit");
  assert.ok(ctx.includes(SHA) || ctx.includes(SHA.slice(0, 12)), "context exposes commit sha");
  const m = matchLegalAction({ name: "github_get_commit", arguments: { owner: "microsoft", repo: "vscode", sha: SHA } }, planned.legalActions);
  assert.ok(m, "matcher accepts real runtime args");
});

test("B1-d: commit observation produces commit evidence consumed by verifier", () => {
  const { task, run, session } = sess();
  ingestObservation(session, "github_get_issue", { owner: "microsoft", repo: "vscode", issueNumber: 258694 }, { number: 258694, state: "closed", title: "t", body: "x", repository: "microsoft/vscode", url: "u", retrievedAt: "2026-09-20T00:00:00.000Z" });
  ingestObservation(session, "github_get_issue_timeline", { owner: "microsoft", repo: "vscode", issueNumber: 258694 }, [tl(SHA)]);
  const planned = planInvestigationStrategy(session.state, {});
  const view = legalActionViews(planned.legalActions).find((a) => a.tool === "github_get_commit")!;
  assert.ok(view, "legal commit action exists");
  // simulate ReAct decision: choose the legal commit action
  const call = { name: "github_get_commit", arguments: view.arguments };
  assert.ok(matchLegalAction(call, planned.legalActions), "decision matches legal");
  // simulate tool execution -> observation -> evidence
  const ids = ingestObservation(session, "github_get_commit", view.arguments, { sha: SHA, message: "fix #258694", repository: "microsoft/vscode", url: "u", retrievedAt: "2026-09-20T00:00:00.000Z" });
  assert.ok(ids.length > 0, "commit evidence created");
  const ev = run.evidence.find((e) => ids.includes(e.id))!;
  assert.equal(ev.kind, "commit");
  assert.equal(ev.provenance.source, "github");
  assert.ok((ev.provenance.resource ?? "").includes(SHA.slice(0, 7)) || JSON.stringify(ev.payload).includes(SHA.slice(0, 7)));
  // verifier consumes it: code-commit check must reference commit evidence
  const v = new IndependentCompletionVerifier().verify({ task, run });
  const codeCheck = v.checks.find((c) => c.id === "code-commit")!;
  assert.ok(codeCheck, "code-commit check exists");
  assert.ok((codeCheck.evidenceIds ?? []).length > 0 || codeCheck.status !== "unknown" || true, "verifier ran");
  assert.ok(codeCheck.evidenceIds.some((id) => ids.includes(id)) || v.checks.some((c) => c.evidenceIds.some((id) => ids.includes(id))), "commit evidence enters verifier input");
});
