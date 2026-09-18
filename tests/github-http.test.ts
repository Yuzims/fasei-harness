import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GitHubProviderError } from "../src/github/errors.js";
import { GithubHttpClient } from "../src/github/http.js";

const SECRET = "github_pat_TEST_SECRET_DO_NOT_LEAK";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) {
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function assertNoSecret(value: unknown): void {
  const blob = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(blob.includes(SECRET), false, "secret must not appear in user-visible output");
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return JSON.stringify(error);
  }
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: "code" in error ? error.code : undefined,
    operation: "operation" in error ? error.operation : undefined,
    status: "status" in error ? error.status : undefined,
  });
}

async function captureConsole(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]])) as Record<
    (typeof methods)[number],
    typeof console.log
  >;
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      chunks.push(args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" "));
    };
  }
  try {
    await run();
  } finally {
    for (const name of methods) {
      console[name] = originals[name];
    }
  }
  return chunks.join("\n");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

test("HTTP：GITHUB_TOKEN 存在时发送 Authorization Bearer，并保留 GitHub API headers", async () => {
  let seen: Record<string, string> | undefined;
  const client = new GithubHttpClient({
    env: { GITHUB_TOKEN: "test-token" },
    fetchImpl: async (_input, init) => {
      seen = headerMap(init);
      return jsonResponse({ ok: true });
    },
  });

  await client.getJson("getRepository", "/repos/acme/box");

  assert.equal(seen !== undefined, true);
  assert.equal(seen?.authorization === "Bearer test-token", true, "Authorization must be Bearer <token>");
  assert.equal(seen?.accept, "application/vnd.github+json");
  assert.equal(seen?.["x-github-api-version"], "2022-11-28");
  assert.equal(seen?.["user-agent"], "failure-aware-agent-harness");
});

test("HTTP：GITHUB_TOKEN 不存在时不发送 Bearer undefined / Bearer null", async () => {
  const cases: Array<Record<string, string | undefined>> = [
    {},
    { GITHUB_TOKEN: undefined },
    { GITHUB_TOKEN: "" },
    { GITHUB_TOKEN: "   " },
  ];

  for (const env of cases) {
    let seen: Record<string, string> | undefined;
    const client = new GithubHttpClient({
      env,
      fetchImpl: async (_input, init) => {
        seen = headerMap(init);
        return jsonResponse({ ok: true });
      },
    });
    await client.getJson("getRepository", "/repos/acme/box");
    const auth = seen?.authorization;
    assert.equal(auth, undefined);
    assert.equal(auth === "Bearer undefined", false);
    assert.equal(auth === "Bearer null", false);
    assert.equal(seen?.accept, "application/vnd.github+json");
    assert.equal(seen?.["x-github-api-version"], "2022-11-28");
  }
});

test("HTTP：token 不进入 console、GitHubProviderError 或 error 文本", async () => {
  const logs = await captureConsole(async () => {
    let authorized = false;
    const failing = new GithubHttpClient({
      env: { GITHUB_TOKEN: SECRET },
      maxRetries: 0,
      fetchImpl: async (_input, init) => {
        authorized = headerMap(init).authorization === `Bearer ${SECRET}`;
        return jsonResponse(
          { message: `bad credentials for Bearer ${SECRET}` },
          500,
        );
      },
    });

    await assert.rejects(
      () => failing.getJson("getIssue", "/repos/acme/box/issues/1"),
      (error: unknown) => {
        assert.equal(error instanceof GitHubProviderError, true);
        assertNoSecret(serializeError(error));
        assertNoSecret(error instanceof Error ? error.message : error);
        return error instanceof GitHubProviderError && error.code === "server_error";
      },
    );
    assert.equal(authorized, true, "fetch must receive Authorization without printing it");

    const network = new GithubHttpClient({
      env: { GITHUB_TOKEN: SECRET },
      maxRetries: 0,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed Authorization: Bearer ${SECRET}`);
      },
    });
    await assert.rejects(
      () => network.getJson("getRepository", "/repos/acme/box"),
      (error: unknown) => {
        assert.equal(error instanceof GitHubProviderError, true);
        assertNoSecret(serializeError(error));
        return error instanceof GitHubProviderError && error.code === "network_error";
      },
    );
  });

  assertNoSecret(logs);
});

test("frontend source does not reference GITHUB_TOKEN", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../web/src");
  for (const file of listFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("GITHUB_TOKEN"), false, file);
  }
});
