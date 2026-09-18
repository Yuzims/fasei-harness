import { codeFromStatus, GitHubProviderError } from "./errors.js";
import { setDefaultResultOrder } from "node:dns";

try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Node versions without this API keep the default resolver order.
}

const API = "https://api.github.com";
const UA = "failure-aware-agent-harness";

export interface GithubHttpOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  now?: () => string;
}

export class GithubHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(private readonly options: GithubHttpOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffMs = options.backoffMs ?? 50;
  }

  retrievedAt(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  token(): string | undefined {
    const value = this.env.GITHUB_TOKEN?.trim();
    return value || undefined;
  }

  async getJson(operation: string, path: string): Promise<unknown> {
    const { status, text } = await this.request(operation, path, "application/vnd.github+json");
    return parseJsonBody(operation, status, text);
  }

  async getJsonPages(operation: string, path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = path;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next) || seen.size >= 20) {
        break;
      }
      seen.add(next);
      const { status, text, link } = await this.request(operation, next, "application/vnd.github+json");
      const parsed = parseJsonBody(operation, status, text);
      if (!Array.isArray(parsed)) {
        throw new GitHubProviderError({
          code: "malformed_response",
          operation,
          status,
          message: `${operation} expected a JSON array page`,
          retryable: false,
        });
      }
      items.push(...parsed);
      next = nextLinkPath(link);
    }
    return items;
  }

  async getText(operation: string, path: string, accept: string): Promise<string> {
    const { text } = await this.request(operation, path, accept);
    return text;
  }

  private async request(
    operation: string,
    path: string,
    accept: string,
  ): Promise<{ status: number; text: string; link: string | null }> {
    let lastError: GitHubProviderError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }

      try {
        const { status, text, link } = await this.send(path, accept);
        if (status < 400) {
          return { status, text, link };
        }

        const code = codeFromStatus(status, text);
        lastError = new GitHubProviderError({
          code,
          operation,
          status,
          message: messageFor(code, operation, status, text),
        });
        if (!lastError.retryable || attempt === this.maxRetries) {
          throw lastError;
        }
      } catch (error) {
        if (error instanceof GitHubProviderError) {
          lastError = error;
          if (!error.retryable || attempt === this.maxRetries) {
            throw error;
          }
          continue;
        }
        throw toNetworkError(operation, error);
      }
    }

    throw lastError ?? new GitHubProviderError({
      code: "network_error",
      operation,
      message: `${operation} failed`,
    });
  }

  private async send(
    path: string,
    accept: string,
  ): Promise<{ status: number; text: string; link: string | null }> {
    const headers: Record<string, string> = {
      accept,
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
    };
    const token = this.token();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${API}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      return {
        status: response.status,
        text: await response.text(),
        link: response.headers.get("link"),
      };
    } catch (error) {
      if (isAbort(error)) {
        throw new GitHubProviderError({
          code: "timeout",
          operation: "http",
          message: `GitHub request timed out after ${this.timeoutMs}ms`,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function messageFor(
  code: GitHubProviderError["code"],
  operation: string,
  status: number,
  text: string,
): string {
  if (code === "rate_limited") {
    return "GitHub API 限流。在 .env 写入 GITHUB_TOKEN 后重试。";
  }
  if (code === "unauthorized") {
    return "GitHub API 未授权。检查 GITHUB_TOKEN。";
  }
  return `${operation} HTTP ${status}: ${text.slice(0, 240)}`;
}

function toNetworkError(operation: string, error: unknown): GitHubProviderError {
  if (error instanceof GitHubProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubProviderError({
    code: "network_error",
    operation,
    message: `${operation} network error: ${message}`,
  });
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function daysAgoIso(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function encodeRepo(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function parseJsonBody(operation: string, status: number, text: string): unknown {
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubProviderError({
      code: "malformed_response",
      operation,
      status,
      message: `${operation} 返回的不是 JSON`,
      retryable: false,
    });
  }
}

export function nextLinkPath(link: string | null): string | null {
  if (!link) {
    return null;
  }
  const match = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    const url = new URL(match[1]);
    if (url.origin !== API) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
