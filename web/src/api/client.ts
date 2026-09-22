import type {
  InvestigationCatalogDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
  InvestigationStreamEvent,
} from "@dto";
import { isInvestigationStreamEvent, parseSseFrames } from "../lib/investigation-stream";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface RealV1BenchmarkDTO {
  dataset: string;
  datasetVersion: string;
  timestamp: string;
  cases: Array<{
    caseId: string;
    observedOutcome: string;
    expectedOutcome: string;
    evaluation: {
      passed: boolean;
      verificationPassed?: boolean;
      failureModesPassed?: boolean;
      recoveryPassed?: boolean;
    };
    attempts: number;
    toolCalls: number;
    evidenceCount: number;
    claimCount: number;
    failureEvents?: Array<{ type: string; reason: string }>;
    recoveryEvents?: Array<{ action: string; reason: string }>;
  }>;
  metrics: Record<string, number>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const payload = data?.error;
    const message =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object" && typeof payload.message === "string"
          ? payload.message
          : response.statusText;
    const code =
      payload && typeof payload === "object" && typeof payload.code === "string" ? payload.code : undefined;
    const retryAfterSeconds =
      payload && typeof payload === "object" && typeof payload.retryAfterSeconds === "number"
        ? payload.retryAfterSeconds
        : undefined;
    throw new ApiError(response.status, message, code, retryAfterSeconds);
  }
  return data as T;
}

export function fetchInvestigationCatalog() {
  return request<InvestigationCatalogDTO>("/api/investigations/catalog");
}

export function runInvestigation(body: InvestigationRequest) {
  return request<InvestigationSessionDTO>("/api/investigations", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function runInvestigationStream(
  body: InvestigationRequest,
  onEvent: (event: InvestigationStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/investigations/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = response.statusText;
    let code: string | undefined;
    try {
      const payload = (JSON.parse(text) as { error?: unknown })?.error;
      if (typeof payload === "string") {
        message = payload;
      } else if (payload && typeof payload === "object") {
        const error = payload as { message?: string; code?: string; retryAfterSeconds?: number };
        message = error.message ?? message;
        code = error.code;
        if (error.retryAfterSeconds !== undefined) {
          throw new ApiError(response.status, message, code, error.retryAfterSeconds);
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
    }
    throw new ApiError(response.status, message, code);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiError(response.status, "当前浏览器不支持流式调查结果。");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalSeen = false;
  const dispatch = (events: InvestigationStreamEvent[]) => {
    for (const event of events) {
      if (event.type === "done" || event.type === "error") {
        terminalSeen = true;
      }
      onEvent(event);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseFrames(buffer, isInvestigationStreamEvent);
    buffer = rest;
    dispatch(events);
  }
  buffer += decoder.decode();
  dispatch(parseSseFrames(`${buffer}\n\n`, isInvestigationStreamEvent).events);
  if (!terminalSeen) {
    throw new ApiError(0, "调查连接已中断，请重新开始调查。");
  }
}

export function fetchRealV1Benchmark() {
  return request<RealV1BenchmarkDTO>("/api/fasei-benchmark/real-v1");
}
