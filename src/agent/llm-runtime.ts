/**
 * LLM runtime safety budget for Live Investigation.
 *
 * This is an extra bound on top of existing AgentLoop maxSteps / recovery
 * maxAttempts. It does not replace them.
 *
 * Defaults are conservative: a Live run may otherwise issue up to
 * 3 attempts × 12 steps = 36 provider calls with no wall-clock cap, and a
 * client disconnect does not cancel the in-flight DashScope request.
 */
import type { FailureEvent } from "../domain/types.js";

export const LLM_CALL_BUDGET_EXCEEDED = "LLM_CALL_BUDGET_EXCEEDED";
export const LLM_RUNTIME_TIMEOUT = "LLM_RUNTIME_TIMEOUT";

export type LlmRuntimeLimit = "llm_calls" | "wall_clock";

export interface LlmRuntimeBudget {
  maxLlmCalls: number;
  maxWallClockMs: number;
}

/** Conservative Live Investigation defaults. Keep maxSteps=12 / maxAttempts=3. */
export const DEFAULT_LLM_RUNTIME_BUDGET: LlmRuntimeBudget = {
  maxLlmCalls: 8,
  maxWallClockMs: 120_000,
};

export function resolveLlmRuntimeBudget(
  overrides?: Partial<LlmRuntimeBudget>,
): LlmRuntimeBudget {
  return {
    maxLlmCalls: overrides?.maxLlmCalls ?? DEFAULT_LLM_RUNTIME_BUDGET.maxLlmCalls,
    maxWallClockMs: overrides?.maxWallClockMs ?? DEFAULT_LLM_RUNTIME_BUDGET.maxWallClockMs,
  };
}

export class LlmRuntimeError extends Error {
  readonly name = "LlmRuntimeError";
  readonly code: typeof LLM_CALL_BUDGET_EXCEEDED | typeof LLM_RUNTIME_TIMEOUT;
  readonly resource: LlmRuntimeLimit;
  readonly budget: LlmRuntimeBudget;
  readonly llmCalls: number;
  readonly elapsedMs: number;

  constructor(input: {
    code: typeof LLM_CALL_BUDGET_EXCEEDED | typeof LLM_RUNTIME_TIMEOUT;
    resource: LlmRuntimeLimit;
    budget: LlmRuntimeBudget;
    llmCalls: number;
    elapsedMs: number;
    message?: string;
  }) {
    const message =
      input.message ??
      (input.code === LLM_CALL_BUDGET_EXCEEDED
        ? `LLM call budget exceeded (maxLlmCalls=${input.budget.maxLlmCalls}).`
        : `LLM runtime wall-clock exceeded (maxWallClockMs=${input.budget.maxWallClockMs}).`);
    super(message);
    this.code = input.code;
    this.resource = input.resource;
    this.budget = input.budget;
    this.llmCalls = input.llmCalls;
    this.elapsedMs = input.elapsedMs;
  }

  toFailureEvent(): FailureEvent {
    return {
      type: "runtime_budget_exceeded",
      reason: this.message,
      evidenceIds: [],
      confidence: 1,
      retryable: false,
      errorCode: this.code,
      details: {
        resource: this.resource,
        maxLlmCalls: this.budget.maxLlmCalls,
        maxWallClockMs: this.budget.maxWallClockMs,
        llmCalls: this.llmCalls,
        elapsedMs: this.elapsedMs,
      },
    };
  }
}

export function isLlmRuntimeError(error: unknown): error is LlmRuntimeError {
  return error instanceof LlmRuntimeError;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

export function isRuntimeBudgetFailure(failure: { type: string } | undefined): boolean {
  return failure?.type === "runtime_budget_exceeded";
}

/**
 * Investigation-owned LLM runtime guard.
 *
 * Call counter applies only to real OpenAICompatModel HTTP requests.
 * When maxWallClockMs elapses, AbortController.abort() fires so in-flight
 * fetch() can terminate.
 */
export class LlmRuntimeGuard {
  readonly budget: LlmRuntimeBudget;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly abortController: AbortController;
  private sentCalls = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    budget?: Partial<LlmRuntimeBudget>;
    now?: number;
    signal?: AbortSignal;
  } = {}) {
    this.budget = resolveLlmRuntimeBudget(options.budget);
    this.startedAt = options.now ?? Date.now();
    this.deadlineAt = this.startedAt + this.budget.maxWallClockMs;
    this.abortController = new AbortController();

    const parent = options.signal;
    if (parent) {
      if (parent.aborted) {
        this.abortController.abort(parent.reason);
      } else {
        parent.addEventListener(
          "abort",
          () => {
            if (!this.abortController.signal.aborted) {
              this.abortController.abort(parent.reason);
            }
          },
          { once: true },
        );
      }
    }

    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.abortDeadline();
    } else {
      this.timer = setTimeout(() => this.abortDeadline(), remaining);
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get llmCallsSent(): number {
    return this.sentCalls;
  }

  elapsedMs(now = Date.now()): number {
    return Math.max(0, now - this.startedAt);
  }

  /**
   * Consume one LLM HTTP slot and return the abort signal for fetch().
   * Throws without incrementing if the next request would exceed the budget
   * or the wall-clock deadline has already passed.
   */
  authorizeCall(): AbortSignal {
    this.assertCanStartCall();
    this.sentCalls += 1;
    return this.signal;
  }

  assertCanStartCall(now = Date.now()): void {
    if (this.signal.aborted || now >= this.deadlineAt) {
      throw this.timeoutError(now);
    }
    if (this.sentCalls >= this.budget.maxLlmCalls) {
      throw this.budgetError(now);
    }
  }

  timeoutError(now = Date.now()): LlmRuntimeError {
    return new LlmRuntimeError({
      code: LLM_RUNTIME_TIMEOUT,
      resource: "wall_clock",
      budget: this.budget,
      llmCalls: this.sentCalls,
      elapsedMs: this.elapsedMs(now),
    });
  }

  budgetError(now = Date.now()): LlmRuntimeError {
    return new LlmRuntimeError({
      code: LLM_CALL_BUDGET_EXCEEDED,
      resource: "llm_calls",
      budget: this.budget,
      llmCalls: this.sentCalls,
      elapsedMs: this.elapsedMs(now),
    });
  }

  abortDeadline(): void {
    this.clearTimer();
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(this.timeoutError());
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
