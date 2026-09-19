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

  async getJsonPages(
    operation: string,
    path: string,
    options?: { maxItems?: number },
  ): Promise<unknown[]> {
    return (await this.collectJsonPages(operation, path, options)).items;
  }

  /**
   * Paginate until `maxItems` is reached, then stop without fetching further pages.
   * truncated=true means the budget was hit (or a page was sliced). It is not a
   * claim that the remaining items are irrelevant.
   */
  async getJsonPagesBounded(
    operation: string,
    path: string,
    maxItems: number,
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    return this.collectJsonPages(operation, path, { maxItems });
  }

  private async collectJsonPages(
    operation: string,
    path: string,
    options?: { maxItems?: number },
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    let next: string | null = path;
    const seen = new Set<string>();
    const maxItems = options?.maxItems;
    let truncated = false;
    while (next) {
      if (seen.has(next) || seen.size >= 20) {
        if (maxItems !== undefined && next && !seen.has(next) && seen.size >= 20) {
          truncated = true;
        }
        break;
      }
      if (maxItems !== undefined && items.length >= maxItems) {
        truncated = true;
        break;
      }
      seen.add(next);
      const { status, text, headers } = await this.request(operation, next, "application/vnd.github+json");
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
      const nextPath = nextLinkPath(headers.get("link"));
      if (maxItems !== undefined) {
        const room = maxItems - items.length;
        if (parsed.length > room) {
          items.push(...parsed.slice(0, room));
          truncated = true;
          break;
        }
        items.push(...parsed);
        if (items.length >= maxItems && nextPath) {
          truncated = true;
          break;
        }
        next = nextPath;
        continue;
      }
      items.push(...parsed);
      next = nextPath;
    }
    return { items, truncated };
  }

  async getText(operation: string, path: string, accept: string): Promise<string> {
    const { text } = await this.request(operation, path, accept);
    return text;
  }

  private async request(
    operation: string,
    path: string,
    accept: string,
  ): Promise<{ status: number; text: string; headers: Headers }> {
    let lastError: GitHubProviderError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }

      try {
        const { status, text, headers } = await this.send(path, accept);
        if (status < 400) {
          return { status, text, headers };
        }

        const code = codeFromStatus(status, text, headers);
        const retry = parseRetryHint(headers);
        lastError = new GitHubProviderError({
          code,
          operation,
          status,
          message: messageFor(code, operation, status, text, this.token()),
          retryAfterSeconds: retry.retryAfterSeconds,
          retryAt: retry.retryAt,
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
        throw toNetworkError(operation, error, this.token());
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
  ): Promise<{ status: number; text: string; headers: Headers }> {
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
        headers: response.headers,
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
  token?: string,
): string {
  if (code === "rate_limited") {
    return "GitHub API rate limit reached.";
  }
  if (code === "unauthorized") {
    return "GitHub API authorization failed.";
  }
  if (code === "not_found") {
    return "Issue not found";
  }
  return `${operation} HTTP ${status}: ${sanitizeErrorText(text, token).slice(0, 240)}`;
}

function sanitizeErrorText(text: string, token?: string): string {
  let out = text.replace(/bearer\s+[a-z0-9._\-]+|ghp_[a-z0-9]+|github_pat_[a-z0-9_]+/gi, "[redacted]");
  if (token) {
    out = out.split(token).join("[redacted]");
  }
  return out;
}

function parseRetryHint(headers: Headers): { retryAfterSeconds?: number; retryAt?: string } {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return { retryAfterSeconds: Number(retryAfter) };
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const retryAt = new Date(Number(reset) * 1000).toISOString();
    const retryAfterSeconds = Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
    return { retryAfterSeconds, retryAt };
  }
  return {};
}

function toNetworkError(operation: string, error: unknown, token?: string): GitHubProviderError {
  if (error instanceof GitHubProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubProviderError({
    code: "network_error",
    operation,
    message: `${operation} network error: ${sanitizeErrorText(message, token)}`,
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
