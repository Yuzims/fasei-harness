import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app.js";

const app = createApp({});

test("API：health 暴露三层", async () => {
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.layers, ["web", "api", "agent"]);
});

test("API：未配置 Key 时 agent status 是规则 Agent", async () => {
  const res = await app.request("/api/agent/status");
  const body = await res.json();
  assert.equal(body.kind, "mock");
  assert.match(body.hint, /OPENAI_API_KEY/);
});

test("API：列出四种失败场景", async () => {
  const res = await app.request("/api/scenarios");
  const body = await res.json();
  assert.equal(body.scenarios.length, 4);
  assert.equal(body.scenarios[0].id, "premature");
});

test("API：对症恢复能把提前完成跑通", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "premature", mode: "failure_aware" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.finalPass, true);
  assert.equal(body.attempts[0].failureType, "premature_completion");
  assert.equal(body.attempts.at(-1).verifier, "pass");
});

test("API：工作台 Agent 能写满 5 个商品", async () => {
  const res = await app.request("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "创建 result.json，里面必须有 5 个商品。",
      failureAware: true,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run.finalPass, true);
  assert.equal(body.modelKind, "workspace");
  assert.equal(body.modelId, "workspace");
  assert.equal(body.files[0].path, "result.json");
});

test("API：有 Key 时 status 报告 openai，但不发请求", async () => {
  const live = createApp({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini" });
  const res = await live.request("/api/agent/status");
  const body = await res.json();
  assert.equal(body.kind, "openai");
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.ready, true);
});

test("API：检索任务在失败感知下会换 hybrid 再通过", async () => {
  const res = await app.request("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "检索 Transformer 相关资料，至少 3 条相关结果。",
      failureAware: true,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run.attempts[0].failureType, "retrieval_failure");
  assert.equal(body.run.finalPass, true);
  assert.equal(body.retrieval.strategy, "hybrid");
});

test("API：stream 把计算任务推完", async () => {
  const res = await app.request("/api/agent/run/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "计算 123 × 456。",
      failureAware: true,
    }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"type":"done"/);
  assert.match(text, /56088/);
});

test("API：未知场景返回 404", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "nope", mode: "baseline" }),
  });
  assert.equal(res.status, 404);
});

test("API：Investigation catalog 列出 Real-v1 C01 和 recovery scenarios", async () => {
  const res = await app.request("/api/investigations/catalog");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.snapshots[0].id, "C01");
  assert.equal(body.snapshots[0].issueNumber, 258694);
  assert.ok(body.recovery.some((item: { id: string }) => item.id === "tool-failure"));
});

test("API：C01 caseId 走 Real-v1 snapshot 得到 verified_complete", async () => {
  const res = await app.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "C01" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, "snapshot");
  assert.equal(body.dataSource, "snapshot");
  assert.equal(body.catalogId, "C01");
  assert.equal(body.actor, "test_driver");
  assert.equal(body.task.owner, "microsoft");
  assert.equal(body.task.repository, "vscode");
  assert.equal(body.task.issueNumber, 258694);
  assert.equal(body.issue.number, 258694);
  assert.equal(body.verification.status, "verified_complete");
  assert.ok(body.evidence.length > 0);
  assert.ok(body.claims.length > 0);
  assert.ok(body.attempts.length >= 1);
  assert.ok(body.verification.checks.some((check: { id: string }) => check.id === "issue-identity"));
});

test("API：microsoft/vscode#258694 在 snapshot 模式下仍走 catalog，不误走 live", async () => {
  const res = await app.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "microsoft/vscode#258694", mode: "snapshot" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, "snapshot");
  assert.equal(body.catalogId, "C01");
  assert.equal(body.verification.status, "verified_complete");
});

test("API：tool-failure recovery scenario 产生 Attempt 1 failure 和 Attempt 2 re-verification", async () => {
  const res = await app.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "tool-failure" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.group, "recovery");
  assert.equal(body.attempts.length, 2);
  assert.equal(body.attempts[0].failureType, "tool_failure");
  assert.equal(body.attempts[0].recoveryAction, "retry_with_backoff");
  assert.equal(body.attempts[1].parentAttemptId, body.attempts[0].id);
  assert.equal(body.verification.status, "verified_complete");
});

test("API：未知 Issue 走 live GitHub 并返回 Issue not found，不编造 snapshot", async () => {
  const live = createApp({}, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  });
  const res = await live.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "foo/bar#999999999", mode: "live" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "GITHUB_NOT_FOUND");
  assert.equal(body.error.message, "Issue not found");
  assert.equal(body.verification, undefined);
});

test("API：非法 Issue 输入返回 INVALID_GITHUB_ISSUE_INPUT", async () => {
  const res = await app.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "https://github.com/microsoft/vscode/pull/123" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_GITHUB_ISSUE_INPUT");
});

test("API：live 未配置 LLM 时返回 unconfigured，不走 SnapshotInvestigationDriver", async () => {
  const live = createApp(
    {},
    {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/repos/debug-js/debug/issues/1") && !url.includes("/comments") && !url.includes("/timeline")) {
          return new Response(
            JSON.stringify({
              number: 1,
              title: "Live public issue",
              body: "observed from GitHub API",
              state: "open",
              html_url: "https://github.com/debug-js/debug/issues/1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  const res = await live.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "https://github.com/debug-js/debug/issues/1", mode: "live" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, "live");
  assert.equal(body.actor, "unconfigured");
  assert.notEqual(body.actor, "test_driver");
  assert.equal(body.agentOutput, undefined);
  assert.match(body.report.conclusion, /unconfigured/i);
  assert.equal(body.verification, undefined);
});

test("API：live 429 映射为 GitHub rate limit，不无限重试", async () => {
  let calls = 0;
  const live = createApp({}, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("API rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    },
  });
  const res = await live.request("/api/investigations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: "acme/demo#1", mode: "live" }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, "GITHUB_RATE_LIMITED");
  assert.equal(body.error.message, "GitHub API rate limit reached.");
  assert.equal(body.error.retryAfterSeconds, 60);
  assert.ok(calls <= 3);
  assert.equal(JSON.stringify(body).toLowerCase().includes("authorization"), false);
});

test("API：Real-v1 latest.json 可读取", async () => {
  const res = await app.request("/api/fasei-benchmark/real-v1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dataset, "real-v1");
  assert.equal(body.cases[0].caseId, "C01");
  assert.equal(body.cases[0].observedOutcome, "verified_complete");
});

