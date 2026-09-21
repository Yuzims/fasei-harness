import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../src/agent/agent-loop.js";
import { parseChatCompletion } from "../src/agent/openai-compat-model.js";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import { LlmUsageCollector } from "../src/agent/llm-usage.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { AgentResult, Task, ToolResult } from "../src/core/types.js";
import {
  claimSupportStatus,
  createEvidence,
  createInvestigationRun,
  createInvestigationTask,
} from "../src/domain/index.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  captureAgentClaims,
  investigate,
  record_claim,
  toAgentReport,
} from "../src/investigation/index.js";
import { createRecordClaimTool } from "../src/investigation/investigation-tools.js";
import type { InvestigationSession } from "../src/investigation/investigation-tools.js";
import { InvestigationState } from "../src/investigation/state.js";
import { TraceCollector } from "../src/trace/trace-collector.js";
import { IndependentCompletionVerifier } from "../src/verification/independent-completion-verifier.js";

function captureSession() {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
  });
  const run = createInvestigationRun({ task });
  const state = new InvestigationState(task, run);
  const trace = new TraceCollector();
  const session: InvestigationSession = {
    state,
    trace,
    runId: run.id,
    llmUsage: new LlmUsageCollector(),
  };
  return { task, run, state, trace, session };
}

function addEvidence(session: InvestigationSession, id: string) {
  session.state.addEvidence(
    createEvidence({
      id,
      kind: "issue",
      provenance: { source: "snapshot", retrievedAt: "2026-01-01T00:00:00.000Z", trust: "external_untrusted" },
      summary: `evidence ${id}`,
    }),
  );
  return session.state.run.evidence.find((item) => item.id === id)!;
}

function finalModel(message: string, claims?: AgentResult["claims"]): Model {
  return {
    async decide(
      _task: Task,
      _history: HistoryMessage[],
      _toolResults: ToolResult[],
    ): Promise<ModelResponse> {
      return { type: "final", message, claims };
    },
  };
}

test("Test 1: Agent output claim 进入 run.claims", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    model: finalModel("Issue fixed by PR #123", [
      { text: "Issue fixed by PR #123", polarity: "resolved" },
    ]),
    maxAttempts: 1,
    investigationActionConstraint: "unconstrained",
  });

  assert.equal(result.run.claims.length, 1);
  assert.equal(result.run.claims[0]?.text, "Issue fixed by PR #123");
  assert.equal(result.run.claims[0]?.polarity, "resolved");
  assert.equal(result.claims[0]?.id, result.run.claims[0]?.id);
  assert.equal(result.agentResult?.claims?.[0]?.text, "Issue fixed by PR #123");
});

test("Test 2: capture 路径调用 record_claim", () => {
  const { run, session, trace } = captureSession();
  const recorded = record_claim(
    session,
    [{ text: "Issue fixed by PR #123", polarity: "resolved" }],
    { source: "record_claim" },
  );
  assert.equal(recorded.claimIds.length, 1);
  assert.deepEqual(recorded.duplicateClaimIds, []);
  assert.equal(run.claims.length, 1);
  assert.equal(run.claims[0]?.id, recorded.claimIds[0]);

  const captured = captureAgentClaims(session, {
    claims: [{ text: "The change has been validated.", polarity: "partial" }],
  });
  assert.equal(captured.claimIds.length, 1);
  assert.equal(captured.duplicateClaimIds.length, 0);
  assert.equal(run.claims.length, 2);
  assert.equal(run.claims[1]?.text, "The change has been validated.");

  const events = trace.getEvents().filter((event) => event.type === "claim_recorded");
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]?.data, {
    claimId: recorded.claimIds[0],
    source: "record_claim",
    type: "claim",
  });
  assert.deepEqual(events[1]?.data, {
    claimId: captured.claimIds[0],
    source: "agent_result",
    type: "claim",
  });
  assert.equal("verification" in events[0]!.data, false);
  assert.equal("success" in events[0]!.data, false);
});

test("Test 3: Claim capture 不改变 verifier result", () => {
  const { task, run, session } = captureSession();
  const verifier = new IndependentCompletionVerifier();
  const before = verifier.verify({ task, run });

  const captured = captureAgentClaims(session, {
    claims: [{ text: "Issue fixed by PR #123", polarity: "unknown", critical: false }],
  });

  assert.equal(run.claims.length, 1);
  assert.equal("verification" in captured, false);
  assert.equal(run.status, "in_progress");

  const after = verifier.verify({ task, run });
  assert.equal(after.status, before.status);
  assert.deepEqual(
    after.checks.map((item) => ({ id: item.id, status: item.status })),
    before.checks.map((item) => ({ id: item.id, status: item.status })),
  );
  assert.deepEqual(after.unsupportedClaimIds, before.unsupportedClaimIds);
  assert.notEqual(after.status, "verified_complete");
});

test("Test 4: 没有 Evidence 时 Claim 仍存在且不是 supported", () => {
  const { run, session } = captureSession();
  captureAgentClaims(session, {
    claims: [{ text: "Issue fixed by PR #123", polarity: "resolved" }],
  });

  const claim = run.claims[0];
  assert.ok(claim);
  assert.equal(run.evidence.length, 0);
  assert.equal(run.claimEvidence.length, 0);
  assert.equal(claimSupportStatus(claim.id, run.claimEvidence, run.evidence), "unsupported");
  assert.notEqual(claimSupportStatus(claim.id, run.claimEvidence, run.evidence), "supported");
});

test("Test 5: Claim capture 不创建 fake Evidence", () => {
  const { run, session } = captureSession();
  const evidenceBefore = run.evidence.length;
  captureAgentClaims(session, {
    claims: [{ text: "Issue fixed by PR #123", polarity: "resolved" }],
  });

  assert.equal(run.evidence.length, evidenceBefore);
  assert.equal(run.evidence.length, 0);
  assert.equal(run.relations.length, 0);
  assert.equal(
    run.claimEvidence.some((link) => !run.evidence.some((item) => item.id === link.evidenceId)),
    false,
  );
});

test("Agent 终答自然语言不会被解析成 Claim", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    model: finalModel("Issue #42 has been fixed by PR #123. The change has been validated."),
    maxAttempts: 1,
    investigationActionConstraint: "unconstrained",
  });

  assert.equal(result.run.claims.length, 0);
  assert.equal(result.agentResult?.output, "Issue #42 has been fixed by PR #123. The change has been validated.");
  assert.equal(result.agentResult?.claims, undefined);
});

test("InvestigationReport.conclusion 不会被提升为 Claim", () => {
  const { state } = captureSession();
  state.conclusion = "Issue fixed by PR #123";
  const report = toAgentReport({ state, actor: "llm" });
  assert.equal(report.report.conclusion, "Issue fixed by PR #123");
  assert.equal(report.run.claims.length, 0);
  assert.equal(report.claims.length, 0);
});

test("B1 Case A: record_claim tool 与 final.claims 的同一 Claim 不重复写入", async () => {
  const { run, session, trace } = captureSession();
  addEvidence(session, "ev-pr");
  const duplicated = {
    text: "Issue #42 was resolved by PR #123.",
    polarity: "resolved",
    evidenceIds: ["ev-pr"],
  };

  await createRecordClaimTool(session).execute({ claims: [duplicated] });
  assert.equal(run.claims.length, 1);

  const captured = captureAgentClaims(session, { claims: [duplicated] });

  assert.equal(run.claims.length, 1);
  assert.deepEqual(captured.claimIds, []);
  assert.deepEqual(captured.duplicateClaimIds, [run.claims[0]!.id]);
  assert.equal(run.claimEvidence.length, 1);
  assert.equal(run.claimEvidence[0]?.claimId, run.claims[0]?.id);
  assert.equal(
    trace.getEvents().filter((event) => event.type === "claim_recorded").length,
    1,
  );
});

test("B1: Evidence 不参与 Claim identity — 同一 Claim 绑定不同 Evidence", async () => {
  const { run, session } = captureSession();
  addEvidence(session, "ev1");
  addEvidence(session, "ev2");
  const text = "Issue #291 was resolved.";

  await createRecordClaimTool(session).execute({
    claims: [{ text, polarity: "resolved", critical: true, evidenceIds: ["ev1"] }],
  });
  const captured = captureAgentClaims(session, {
    claims: [{ text, polarity: "resolved", critical: true, evidenceIds: ["ev2"] }],
  });

  assert.equal(run.claims.length, 1);
  assert.deepEqual(captured.duplicateClaimIds, [run.claims[0]!.id]);
  assert.equal(run.claimEvidence.length, 2);
  assert.equal(run.claimEvidence[0]?.claimId, run.claims[0]?.id);
  assert.equal(run.claimEvidence[1]?.claimId, run.claims[0]?.id);
  assert.deepEqual(
    run.claimEvidence.map((link) => link.evidenceId).sort(),
    ["ev1", "ev2"],
  );
});

test("B1: 相同 Claim + 相同 Evidence 重复写入不增加 binding", () => {
  const { run, session } = captureSession();
  addEvidence(session, "ev1");
  const claim = { text: "Issue #291 was resolved.", polarity: "resolved", evidenceIds: ["ev1"] };

  captureAgentClaims(session, { claims: [claim] });
  captureAgentClaims(session, { claims: [claim] });
  captureAgentClaims(session, { claims: [claim] });

  assert.equal(run.claims.length, 1);
  assert.equal(run.claimEvidence.length, 1);
});

test("B1: 去重不改变 Verifier 结果", () => {
  const { task, run, session } = captureSession();
  addEvidence(session, "ev1");
  const verifier = new IndependentCompletionVerifier();
  const claim = {
    text: "Issue #291 was resolved.",
    polarity: "resolved" as const,
    critical: true,
    evidenceIds: ["ev1"],
  };

  captureAgentClaims(session, { claims: [claim] });
  const once = verifier.verify({ task, run });
  captureAgentClaims(session, { claims: [claim] });
  captureAgentClaims(session, { claims: [{ ...claim, evidenceIds: ["ev1"] }] });
  const deduped = verifier.verify({ task, run });

  assert.equal(run.claims.length, 1);
  assert.equal(run.claimEvidence.length, 1);
  assert.equal(deduped.status, once.status);
  assert.deepEqual(
    deduped.checks.map((item) => ({ id: item.id, status: item.status })),
    once.checks.map((item) => ({ id: item.id, status: item.status })),
  );
  assert.deepEqual(deduped.unsupportedClaimIds, once.unsupportedClaimIds);
});

test("B1 Case B: 同一 AgentResult 重复 capture 不复制 Claim", () => {
  const { run, session, trace } = captureSession();
  const result: AgentResult = {
    status: "completed",
    output: "Issue fixed.",
    steps: 3,
    claims: [{ text: "Issue #42 was resolved.", polarity: "resolved", critical: true }],
  };

  const first = captureAgentClaims(session, result);
  const second = captureAgentClaims(session, result);
  const third = captureAgentClaims(session, result);

  assert.equal(run.claims.length, 1);
  assert.equal(first.claimIds.length, 1);
  assert.equal(second.claimIds.length, 0);
  assert.deepEqual(third.duplicateClaimIds, first.claimIds);
  assert.equal(
    trace.getEvents().filter((event) => event.type === "claim_created").length,
    1,
  );
  assert.equal(
    trace.getEvents().filter((event) => event.type === "claim_recorded").length,
    1,
  );
});

test("B1: 不同 Claim 不因去重被合并", () => {
  const { run, session } = captureSession();
  captureAgentClaims(session, {
    claims: [
      { text: "Issue #291 was resolved.", polarity: "resolved", critical: true },
      { text: "PR #597 changed the relevant code.", polarity: "resolved", critical: true },
    ],
  });

  assert.equal(run.claims.length, 2);
  assert.deepEqual(
    run.claims.map((claim) => claim.text),
    ["Issue #291 was resolved.", "PR #597 changed the relevant code."],
  );
});

test("B1: 同文本但 polarity / critical 不同保持独立", () => {
  const { run, session } = captureSession();
  captureAgentClaims(session, {
    claims: [
      { text: "Issue #42 was resolved.", polarity: "resolved", critical: true },
      { text: "Issue #42 was resolved.", polarity: "partial", critical: true },
      { text: "Issue #42 was resolved.", polarity: "resolved", critical: false },
    ],
  });

  assert.equal(run.claims.length, 3);
});

test("B1: 去重复用现有 Claim 且不破坏 Evidence binding", () => {
  const { run, session } = captureSession();
  addEvidence(session, "ev-pr");
  const claim = { text: "PR #123 merged the fix.", polarity: "resolved", evidenceIds: ["ev-pr"] };

  const first = captureAgentClaims(session, { claims: [claim] });
  captureAgentClaims(session, { claims: [claim] });

  assert.equal(run.claims.length, 1);
  assert.equal(run.claimEvidence.length, 1);
  assert.equal(run.claimEvidence[0]?.claimId, first.claimIds[0]);
  assert.equal(run.claimEvidence[0]?.evidenceId, "ev-pr");
  assert.equal(claimSupportStatus(first.claimIds[0]!, run.claimEvidence, run.evidence), "supported");
});

test("B2: record_claim tool 对非法 Evidence ID 仍然抛错", async () => {
  const { run, session } = captureSession();
  await assert.rejects(
    () =>
      createRecordClaimTool(session).execute({
        claims: [{ text: "Issue #42 was resolved.", polarity: "resolved", evidenceIds: ["ev-fake"] }],
      }),
    /unknown evidence ids: ev-fake/,
  );
  assert.equal(run.claims.length, 0);
  assert.equal(run.claimEvidence.length, 0);
});

test("B2: capture 遇到非法 Evidence ID 跳过该 Claim 且不抛错", () => {
  const { run, session } = captureSession();
  addEvidence(session, "ev-pr");

  const captured = captureAgentClaims(session, {
    claims: [
      { text: "Valid claim.", polarity: "resolved", evidenceIds: ["ev-pr"] },
      { text: "Forged claim.", polarity: "resolved", evidenceIds: ["ev-fake"] },
    ],
  });

  assert.equal(captured.droppedUnknownEvidence, 1);
  assert.equal(run.claims.length, 1);
  assert.equal(run.claims[0]?.text, "Valid claim.");
  assert.equal(run.evidence.length, 1);
  assert.equal(run.claimEvidence.length, 1);
  assert.equal(run.claimEvidence[0]?.evidenceId, "ev-pr");
  assert.equal(
    run.claims.some((claim) => claim.text === "Forged claim."),
    false,
  );
});

test("B2: final.claims 携带非法 Evidence ID 时 investigate 仍进入 verify", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("insufficient-evidence")),
    model: finalModel("Issue fixed by PR #123", [
      { text: "Issue fixed by PR #123", polarity: "resolved", evidenceIds: ["ev-does-not-exist"] },
    ]),
    maxAttempts: 1,
    investigationActionConstraint: "unconstrained",
  });

  assert.ok(result.verification);
  assert.equal(result.run.claims.length, 0);
  assert.equal(result.run.claimEvidence.length, 0);
  assert.equal(result.run.evidence.length === 0, true);
});

test("B3: capture 不修改 claimsRecorded", () => {
  const { state, session } = captureSession();
  assert.equal(state.claimsRecorded, false);
  captureAgentClaims(session, {
    claims: [{ text: "Issue #42 was resolved.", polarity: "resolved" }],
  });
  assert.equal(state.claimsRecorded, false);
});

test("B3: shared writer 不修改 claimsRecorded，tool 路径仍然设置", async () => {
  const { session, state } = captureSession();
  addEvidence(session, "ev-issue");

  record_claim(session, [{ text: "Observed the issue.", polarity: "unresolved", evidenceIds: ["ev-issue"] }]);
  assert.equal(state.claimsRecorded, false);

  await createRecordClaimTool(session).execute({
    claims: [{ text: "Issue #42 was resolved.", polarity: "resolved", evidenceIds: ["ev-issue"] }],
  });
  assert.equal(state.claimsRecorded, true);
});

test("B3: capture 不修改 Resolution Analysis", () => {
  const { run, session } = captureSession();
  addEvidence(session, "ev-pr");
  run.resolutionAnalyses = [
    {
      id: "ra-1",
      candidateEvidenceId: "ev-pr",
      issueEvidenceId: "ev-pr",
      codeRelevance: "observed",
      behavioralAlignment: "inferred",
      testSupport: "not observed",
      unresolvedQuestions: [],
      supportingEvidenceIds: ["ev-pr"],
      claimIds: [],
    },
  ];
  const before = structuredClone(run.resolutionAnalyses);

  captureAgentClaims(session, {
    claims: [{ text: "PR #123 touched the failing module.", polarity: "partial", evidenceIds: ["ev-pr"] }],
  });

  assert.deepEqual(run.resolutionAnalyses, before);
  assert.deepEqual(run.resolutionAnalyses[0]?.claimIds, []);
  assert.deepEqual(run.resolutionAnalyses[0]?.supportingEvidenceIds, ["ev-pr"]);
});

test("Real issue claim pipeline: raw structured LLM output → parser → AgentResult.claims → Claim + ClaimEvidence", async () => {
  const { run, session } = captureSession();
  const observed = addEvidence(session, "ev-pr-123");

  const rawChatCompletion = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "PR #123 was merged and resolves the issue.",
            claims: [
              {
                text: "PR #123 resolves the issue.",
                polarity: "resolved",
                critical: true,
                evidenceIds: [observed.id],
                role: "supports",
              },
            ],
          }),
        },
      },
    ],
  };

  const parsed = parseChatCompletion(rawChatCompletion);
  const model: Model = {
    async decide(): Promise<ModelResponse> {
      return parsed;
    },
  };

  const loop = new AgentLoop(model, new ToolRegistry(), session.trace);
  const agentResult = await loop.run(
    { id: "task-1", description: "Investigate acme/box#42." },
    session.runId,
  );

  assert.equal(agentResult.status, "completed");
  assert.equal(agentResult.claims?.length, 1, "AgentResult.claims must carry the parsed claims");

  const captured = captureAgentClaims(session, agentResult);

  assert.equal(captured.claimIds.length, 1);
  assert.equal(run.claims.length, 1);
  assert.equal(run.claims[0]?.text, "PR #123 resolves the issue.");
  assert.equal(run.claimEvidence.length, 1);
  assert.equal(run.claimEvidence[0]?.claimId, run.claims[0]?.id);
  assert.equal(run.claimEvidence[0]?.evidenceId, observed.id);
  assert.equal(
    claimSupportStatus(run.claims[0]!.id, run.claimEvidence, run.evidence),
    "supported",
  );
});
