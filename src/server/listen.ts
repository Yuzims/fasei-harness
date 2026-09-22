import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { describeLlm } from "../agent/llm-config.js";
import { createApp } from "./app.js";
import { enableEnvProxyForFetch, loadEnvFile } from "./load-env.js";

loadEnvFile();
enableEnvProxyForFetch();
const llm = describeLlm();

const port = Number(process.env.PORT ?? 8787);
const app = createApp();
const webDist = "web/dist";

if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("/*", serveStatic({ path: `${webDist}/index.html` }));
} else {
  app.get("/", (c) =>
    c.json({
      ok: true,
      hint: "API 已启动。前端请跑 npm run dev（Vite :5173 会代理 /api）。",
      health: "/api/health",
    }),
  );
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API  http://127.0.0.1:${info.port}/api/health`);
  console.log(`LLM  ${llm.kind} ${llm.model}`);
  if (existsSync(webDist)) {
    console.log(`Web  http://127.0.0.1:${info.port}/`);
  } else {
    console.log("Web  npm run dev → http://127.0.0.1:5173");
  }
});
