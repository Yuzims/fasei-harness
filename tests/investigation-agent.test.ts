import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { HistoryMessage, Model, ModelResponse } from "../src/agent/model.js";
import type { Task, ToolResult } from "../src/core/types.js";
import { SnapshotGitHubProvider } from "../src/github/snapshot-provider.js";
import { githubFixturePath } from "../src/github/snapshot-store.js";
import {
  FORBIDDEN_WRITE_TOOLS,
  INVESTIGATION_SYSTEM_PROMPT,
  SnapshotInvestigationDriver,
  TEST_DRIVER_NOTICE,
  investigate,
} from "../src/investigation/index.js";
import { TraceCollector } from "../src/trace/trace-collector.js";

class SpyProvider extends SnapshotGitHubProvider {
  readonly operations: string[] = [];
  fetchCalls = 0;

  private track<T>(name: string, work: Promise<T>): Promise<T> {
    this.operations.push(name);
    return work;
  }

  override getIssue(ref: { owner: string; repo: string; issueNumber: number }) {
    return this.track("getIssue", super.getIssue(ref));
  }
  override getIssueComments(ref: { owner: string; repo: string; issueNumber: number }) {
    return this.track("getIssueComments", super.getIssueComments(ref));
  }
  override getIssueTimeline(ref: { owner: string; repo: string; issueNumber: number }) {
    return this.track("getIssueTimeline", super.getIssueTimeline(ref));
  }
  override getPullRequest(ref: { owner: string; repo: string; pullNumber: number }) {
    return this.track("getPullRequest", super.getPullRequest(ref));
  }
  override getPullRequestFiles(ref: { owner: string; repo: string; pullNumber: number }) {
    return this.track("getPullRequestFiles", super.getPullRequestFiles(ref));
  }
  override getPullRequestReviews(ref: { owner: string; repo: string; pullNumber: number }) {
    return this.track("getPullRequestReviews", super.getPullRequestReviews(ref));
  }
  override listCommits(query: { owner: string; repo: string; pullNumber?: number; sha?: string }) {
    return this.track("listCommits", super.listCommits(query));
  }
}

function githubTools(steps: Array<{ tool: string }>): string[] {
  return steps.map((step) => step.tool).filter((name) => name.startsWith("github_"));
}

function after(steps: string[], tool: string): string | undefined {
  const index = steps.indexOf(tool);
  if (index < 0) {
    return undefined;
  }
  return steps[index + 1];
}

async function runFixture(
  id: "resolved" | "closed-unmerged" | "insufficient-evidence",
  issueNumber: number,
) {
  const provider = new SpyProvider(githubFixturePath(id));
  const trace = new TraceCollector();
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber },
    provider,
    trace,
    useTestDriver: true,
  });
  return { provider, trace, result };
}

test("Investigation：无 LLM Key 且未开 test driver 时返回 unconfigured，不伪装成自主 Agent", async () => {
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider: new SnapshotGitHubProvider(githubFixturePath("resolved")),
    env: { AGENT_MODEL: "mock" },
  });
  assert.equal(result.status, "unconfigured");
  assert.equal(result.actor, "unconfigured");
  assert.equal(result.run.status, "not_verified");
  assert.match(result.report.conclusion, /unconfigured/i);
  assert.match(result.report.conclusion, /test fixture/i);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.investigationSteps.length, 0);
});

test("Investigation：resolved fixture 多步调查并形成 resolution candidate claims", async () => {
  const { provider, trace, result } = await runFixture("resolved", 42);
  const tools = githubTools(result.investigationSteps);

  assert.equal(result.actor, "test_driver");
  assert.match(TEST_DRIVER_NOTICE, /not a real Investigation Agent/i);
  assert.equal(result.status, "investigated");
  assert.equal(result.run.status, "verified_complete");
  assert.equal(result.verification?.status, "verified_complete");
  assert.notEqual(result.status, "verified_complete");
  assert.ok(tools.length >= 2 && tools.length <= 8);
  assert.deepEqual(tools.slice(0, 2), ["github_get_issue", "github_get_issue_timeline"]);
  assert.equal(after(tools, "github_get_issue_timeline"), "github_get_pull_request");
  assert.ok(tools.includes("github_get_pull_request_files"));
  assert.ok(tools.includes("github_list_commits"));
  assert.ok(result.investigationSteps.some((step) => step.tool === "record_claim"));

  assert.ok(result.evidence.some((item) => item.kind === "issue"));
  assert.ok(result.evidence.some((item) => item.kind === "pull_request"));
  assert.ok(result.evidence.some((item) => item.kind === "file" && item.summary.includes("src/cart.ts")));
  assert.ok(result.evidence.some((item) => item.kind === "commit"));

  const texts = result.claims.map((item) => item.text);
  assert.ok(texts.some((text) => /PR #7 is a candidate resolution for Issue #42/i.test(text)));
  assert.ok(texts.some((text) => /PR #7 is merged/i.test(text)));
  assert.ok(texts.some((text) => /src\/cart\.ts/i.test(text)));
  assert.ok(result.claimEvidence.length > 0);
  assert.equal(result.claims.every((claim) => result.claimEvidence.some((link) => link.claimId === claim.id)), true);
  assert.ok(result.run.relations.some((item) => item.type === "fixes"));
  assert.ok(result.run.relations.some((item) => item.type === "derived_from"));
  assert.ok(result.run.relations.some((item) => item.type === "merges"));

  const merge = result.evidence.find((item) => item.summary === "PR #7 merged=true");
  assert.ok(merge);
  assert.equal(merge?.provenance.source, "github");
  assert.equal(merge?.provenance.operation, "getPullRequest");
  assert.equal(merge?.provenance.resource, "pull/7");
  assert.equal(merge?.provenance.repository, "acme/box");
  assert.ok(merge?.provenance.url);
  assert.ok(merge?.provenance.retrievedAt);
  assert.equal(merge?.provenance.trust, "external_untrusted");
  assert.ok(merge?.provenance.rawHash);
  assert.ok(merge?.payload);

  assert.ok(provider.operations.includes("getIssue"));
  assert.ok(provider.operations.includes("getPullRequest"));
  assert.equal(provider.fetchCalls, 0);
  assert.equal(
    result.investigationSteps.every((step) => !FORBIDDEN_WRITE_TOOLS.includes(step.tool as never)),
    true,
  );

  const types = new Set(trace.getEvents().map((event) => event.type));
  for (const required of [
    "investigation_started",
    "agent_step",
    "model_call",
    "tool_call",
    "tool_result",
    "evidence_added",
    "claim_created",
    "investigation_completed",
    "verification_started",
    "verification_check",
    "verification_completed",
  ]) {
    assert.equal(types.has(required as never), true, `missing trace ${required}`);
  }
  assert.equal(result.verification?.checks.some((item) => item.id === "pr-merged" && item.status === "pass"), true);
  const step = trace.getEvents().find((event) => event.type === "agent_step");
  assert.ok(typeof step?.data.reason === "string");
  assert.ok(String(step?.data.reason).length > 0);
  assert.equal(result.agentResult?.status, "completed");
  assert.ok((result.agentResult?.steps ?? 0) >= 2);
});

test("Investigation：closed-unmerged 不会因为 issue closed 就宣称 resolved", async () => {
  const { result } = await runFixture("closed-unmerged", 99);
  const tools = githubTools(result.investigationSteps);

  assert.equal(after(tools, "github_get_issue_timeline"), "github_get_pull_request");
  assert.equal(result.status, "partial");
  assert.notEqual(result.report.polarity, "resolved");
  assert.equal(result.run.status, "not_verified");
  assert.equal(result.verification?.status, "not_verified");
  assert.equal(
    result.verification?.checks.some((item) => item.id === "pr-merged" && item.status === "fail"),
    true,
  );
  assert.equal(
    result.claims.some((claim) => claim.polarity === "resolved" && /resolved by/i.test(claim.text)),
    false,
  );
  assert.ok(result.claims.some((claim) => /not merged/i.test(claim.text)));
  assert.ok(result.run.relations.some((item) => item.type === "references"));
  assert.equal(result.run.relations.some((item) => item.type === "fixes"), false);
  assert.ok(result.unresolvedQuestions.length > 0);
  assert.equal(tools.includes("github_get_pull_request_files"), false);
  assert.equal(tools.includes("github_list_commits"), false);
});

test("Investigation：insufficient-evidence 结束并保留 evidence gap，不跟随 prompt injection", async () => {
  const { result } = await runFixture("insufficient-evidence", 7);
  const tools = githubTools(result.investigationSteps);

  assert.equal(after(tools, "github_get_issue_timeline"), "github_get_issue_comments");
  assert.equal(tools.includes("github_get_pull_request"), false);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.report.polarity, "unknown");
  assert.equal(result.run.status, "insufficient_evidence");
  assert.equal(result.verification?.status, "insufficient_evidence");
  assert.equal(
    result.verification?.checks.some((item) => item.id === "resolution-candidate" && item.status === "unknown"),
    true,
  );
  assert.ok(result.unresolvedQuestions.length > 0);

  const issue = result.evidence.find((item) => item.kind === "issue");
  assert.match(JSON.stringify(issue?.payload ?? {}), /Ignore previous instructions/i);
  assert.equal(issue?.provenance.trust, "external_untrusted");
  assert.equal(
    result.claims.some((claim) => claim.polarity === "resolved"),
    false,
  );
  assert.equal(result.investigationSteps.some((step) => FORBIDDEN_WRITE_TOOLS.includes(step.tool as never)), false);
  assert.equal(JSON.stringify(result).includes("verified_complete"), false);
});

test("Investigation：下一步工具随 observation 改变，而不是固定流水线", async () => {
  const resolved = await runFixture("resolved", 42);
  const missing = await runFixture("insufficient-evidence", 7);
  const resolvedAfterTimeline = after(githubTools(resolved.result.investigationSteps), "github_get_issue_timeline");
  const missingAfterTimeline = after(githubTools(missing.result.investigationSteps), "github_get_issue_timeline");
  assert.equal(resolvedAfterTimeline, "github_get_pull_request");
  assert.equal(missingAfterTimeline, "github_get_issue_comments");
  assert.notEqual(resolvedAfterTimeline, missingAfterTimeline);
});

test("Investigation：Claim 关联 Evidence，Evidence 走 Provider 而不是 fetch", async () => {
  const { provider, result } = await runFixture("resolved", 42);
  for (const link of result.claimEvidence) {
    assert.ok(result.claims.some((claim) => claim.id === link.claimId));
    assert.ok(result.evidence.some((item) => item.id === link.evidenceId));
  }
  assert.ok(provider.operations.includes("getIssue"));
  assert.ok(provider.operations.includes("getIssueTimeline"));
  assert.ok(provider.operations.includes("getPullRequest"));
  assert.ok(provider.operations.includes("getPullRequestFiles"));
  assert.ok(provider.operations.includes("listCommits"));
  assert.equal(provider.operations.includes("searchRepositories"), false);
});

test("Investigation：注入的 LLM 走 function calling，不经过 keyword classifier", async () => {
  const provider = new SpyProvider(githubFixturePath("resolved"));
  let calls = 0;
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 42 },
    provider,
    env: {
      AGENT_MODEL: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    },
    fetchImpl: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const names = (body.tools ?? []).map((item) => item.function?.name);
      assert.ok(names.includes("github_get_issue"));
      assert.ok(names.includes("record_claim"));
      assert.equal(names.some((name) => FORBIDDEN_WRITE_TOOLS.includes(name as never)), false);
      const system = body.messages?.find((item) => item.role === "system")?.content ?? "";
      assert.match(system, /VERIFIED_COMPLETE/);
      assert.match(INVESTIGATION_SYSTEM_PROMPT, /VERIFIED_COMPLETE/);
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "c1",
                      function: {
                        name: "github_get_issue",
                        arguments: JSON.stringify({
                          owner: "acme",
                          repo: "box",
                          issueNumber: 42,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Need more evidence; not VERIFIED_COMPLETE." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.actor, "llm");
  assert.ok(calls >= 2);
  assert.ok(provider.operations.includes("getIssue"));
  assert.ok(result.evidence.some((item) => item.kind === "issue"));
  assert.equal(result.verification?.status, "insufficient_evidence");
  assert.ok(
    result.run.status === "insufficient_evidence" || result.run.status === "recovery_exhausted",
  );
  assert.ok(result.run.attempts.length <= 3);
  assert.notEqual(result.status, "verified_complete");
});

test("Investigation：自定义 Model 也走 Tool → Provider，不走 WorkspaceAgentModel", async () => {
  const provider = new SpyProvider(githubFixturePath("insufficient-evidence"));
  const model: Model = {
    async decide(
      _task: Task,
      _history: HistoryMessage[],
      toolResults: ToolResult[],
    ): Promise<ModelResponse> {
      if (toolResults.length === 0) {
        return {
          type: "tool_call",
          call: {
            id: "m1",
            name: "github_get_issue",
            arguments: { owner: "acme", repo: "box", issueNumber: 7 },
          },
        };
      }
      return { type: "final", message: "Stopped after observing the issue. Not verified." };
    },
  };
  const result = await investigate({
    task: { owner: "acme", repository: "box", issueNumber: 7 },
    provider,
    model,
  });
  assert.equal(result.actor, "llm");
  assert.deepEqual(provider.operations, ["getIssue"]);
  assert.equal(result.evidence[0]?.kind, "issue");
  assert.equal(result.verification?.status, "insufficient_evidence");
  assert.ok(
    result.run.status === "insufficient_evidence" || result.run.status === "recovery_exhausted",
  );
  assert.ok(result.run.attempts.length <= 3);
});

test("Investigation：模块不依赖 React / Hono / keyword classifier / WorkspaceAgent", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/investigation");
  const forbidden =
    /from ["'].*(react|hono|task-intent|workspace-agent|server\/app)["']/;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(dir, file), "utf8");
    assert.equal(forbidden.test(source), false, file);
    assert.equal(source.includes("classifyTask"), false, file);
    assert.equal(source.includes("verified_complete ="), false, file);
    assert.equal(source.includes('status: "verified_complete"'), false, file);
  }
  assert.equal(SnapshotInvestigationDriver.name, "SnapshotInvestigationDriver");
});
