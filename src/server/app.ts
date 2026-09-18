import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { BenchmarkMode } from "../api/dto.js";
import { allCases, listScenarios } from "../eval/cases.js";
import { executeCase, runBenchmark } from "../eval/benchmark.js";
import { runRetrievalAblation } from "../retrieval/ablation.js";
import { agentExamples, agentStatus, runAgentSession } from "./agent-service.js";
import {
  investigationCatalog,
  loadRealV1BenchmarkResult,
  runInvestigation,
} from "./investigation-service.js";
import { toAblationDTO, toRunDTO } from "./serialize.js";

const MODES: BenchmarkMode[] = ["baseline", "generic_retry", "failure_aware"];

function isMode(value: unknown): value is BenchmarkMode {
  return typeof value === "string" && MODES.includes(value as BenchmarkMode);
}

type Env = Record<string, string | undefined>;

export function createApp(env: Env = process.env) {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      layers: ["web", "api", "agent"],
    }),
  );

  app.get("/api/agent/examples", (c) => c.json({ examples: agentExamples() }));
  app.get("/api/agent/status", (c) => c.json(agentStatus(env)));

  app.post("/api/agent/run", async (c) => {
    const body = await c.req.json().catch(() => null);
    const description =
      body && typeof body === "object" && "description" in body
        ? body.description
        : undefined;
    const failureAware =
      !body || typeof body !== "object" || body.failureAware !== false;

    if (typeof description !== "string") {
      return c.json({ error: "description 必填" }, 400);
    }

    try {
      const session = await runAgentSession({ description, failureAware, env });
      return c.json(session);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.post("/api/agent/run/stream", async (c) => {
    const body = await c.req.json().catch(() => null);
    const description =
      body && typeof body === "object" && "description" in body
        ? body.description
        : undefined;
    const failureAware =
      !body || typeof body !== "object" || body.failureAware !== false;

    if (typeof description !== "string") {
      return c.json({ error: "description 必填" }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        const session = await runAgentSession({
          description,
          failureAware,
          env,
          onEvent: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
        });
        await stream.writeSSE({ data: JSON.stringify({ type: "done", session }) });
      } catch (error) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    });
  });

  app.get("/api/scenarios", (c) => c.json({ scenarios: listScenarios() }));

  app.post("/api/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const scenarioId =
      body && typeof body === "object" && "scenarioId" in body
        ? body.scenarioId
        : undefined;
    const mode = body && typeof body === "object" && "mode" in body ? body.mode : "failure_aware";

    if (typeof scenarioId !== "string") {
      return c.json({ error: "scenarioId 必填" }, 400);
    }
    if (!isMode(mode)) {
      return c.json({ error: "mode 必须是 baseline | generic_retry | failure_aware" }, 400);
    }

    const item = allCases().find((entry) => entry.id === scenarioId);
    if (!item) {
      return c.json({ error: `未知场景：${scenarioId}` }, 404);
    }

    const run = await executeCase(item, mode);
    return c.json(toRunDTO(item, mode, run));
  });

  app.get("/api/benchmark", async (c) => {
    const modes = await runBenchmark();
    return c.json({ modes });
  });

  app.get("/api/retrieval", (c) => {
    return c.json({ rows: toAblationDTO(runRetrievalAblation()) });
  });

  app.get("/api/investigations/catalog", (c) => c.json(investigationCatalog()));

  app.post("/api/investigations", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "JSON body 必填" }, 400);
    }
    try {
      const session = await runInvestigation(body);
      return c.json(session);
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status
          : 400;
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status === 404 ? 404 : 400,
      );
    }
  });

  app.get("/api/fasei-benchmark/real-v1", (c) => {
    try {
      return c.json(loadRealV1BenchmarkResult());
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status
          : 400;
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status === 404 ? 404 : 400,
      );
    }
  });

  return app;
}
