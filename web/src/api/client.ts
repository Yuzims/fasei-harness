import type {
  AblationRowDTO,
  AgentExampleDTO,
  AgentSessionDTO,
  AgentStatusDTO,
  AgentStreamEvent,
  BenchmarkMode,
  InvestigationCatalogDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
  ModeScoreDTO,
  RunDTO,
  ScenarioInfo,
} from "@dto";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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
    throw new ApiError(response.status, data?.error ?? response.statusText);
  }
  return data as T;
}

export function runAgent(description: string, failureAware: boolean) {
  return request<AgentSessionDTO>("/api/agent/run", {
    method: "POST",
    body: JSON.stringify({ description, failureAware }),
  });
}

export async function runAgentStream(
  description: string,
  failureAware: boolean,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<AgentSessionDTO> {
  const response = await fetch("/api/agent/run/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description, failureAware }),
  });
  if (!response.body) {
    throw new ApiError(response.status, "没有流式响应");
  }
  if (!response.ok) {
    const text = await response.text();
    let message = response.statusText;
    try {
      message = JSON.parse(text)?.error ?? message;
    } catch {
      message = text || message;
    }
    throw new ApiError(response.status, message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let session: AgentSessionDTO | undefined;
  let error: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data:"));
      if (!line) {
        continue;
      }
      const event = JSON.parse(line.slice(5).trim()) as AgentStreamEvent;
      onEvent(event);
      if (event.type === "done" && event.session) {
        session = event.session;
      }
      if (event.type === "error" && event.message) {
        error = event.message;
      }
    }
  }

  if (error) {
    throw new Error(error);
  }
  if (!session) {
    throw new Error("流式结束但没有结果");
  }
  return session;
}

export function fetchAgentStatus() {
  return request<AgentStatusDTO>("/api/agent/status");
}

export function fetchAgentExamples() {
  return request<{ examples: AgentExampleDTO[] }>("/api/agent/examples");
}

export function fetchScenarios() {
  return request<{ scenarios: ScenarioInfo[] }>("/api/scenarios");
}

export function fetchBenchmark() {
  return request<{ modes: ModeScoreDTO[] }>("/api/benchmark");
}

export function fetchRetrieval() {
  return request<{ rows: AblationRowDTO[] }>("/api/retrieval");
}

export function runScenario(scenarioId: string, mode: BenchmarkMode) {
  return request<RunDTO>("/api/runs", {
    method: "POST",
    body: JSON.stringify({ scenarioId, mode }),
  });
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

export function fetchRealV1Benchmark() {
  return request<{
    dataset: string;
    datasetVersion: string;
    timestamp: string;
    cases: Array<{
      caseId: string;
      observedOutcome: string;
      expectedOutcome: string;
      evaluation: { passed: boolean };
      attempts: number;
      toolCalls: number;
      evidenceCount: number;
      claimCount: number;
    }>;
    metrics: {
      taskSuccessRate: number;
      falseCompletionRate: number;
      insufficientEvidenceRate: number;
      evidenceCoverage: number;
      recoveryRate: number;
      recoverySuccessRate: number;
      averageAttempts: number;
      averageToolCalls: number;
      verifierFalsePositiveRate: number;
    };
  }>("/api/fasei-benchmark/real-v1");
}
