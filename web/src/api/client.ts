import type {
  InvestigationCatalogDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
} from "@dto";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    throw new ApiError(response.status, data?.error ?? response.statusText);
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

export function fetchRealV1Benchmark() {
  return request<RealV1BenchmarkDTO>("/api/fasei-benchmark/real-v1");
}
