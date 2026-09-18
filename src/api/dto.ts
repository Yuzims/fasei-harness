export type BenchmarkMode = "baseline" | "generic_retry" | "failure_aware";

export interface ScenarioInfo {
  id: string;
  title: string;
  expectedFailure: string;
  shouldFinallyPass: boolean;
  description: string;
}

export interface CheckDTO {
  name: string;
  passed: boolean;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface AttemptDTO {
  attempt: number;
  agentOutput: string;
  verifier: "pass" | "fail";
  prematureCompletion: boolean;
  checks: CheckDTO[];
  failureType?: string;
  failureRootCause?: string;
  recoveryAction?: string;
  recoveryReason?: string;
}

export interface EventDTO {
  step: number;
  type: string;
  summary: string;
}

export interface RunDTO {
  runId: string;
  scenarioId: string;
  title: string;
  mode: BenchmarkMode;
  finalPass: boolean;
  recoveryCount: number;
  modelCalls: number;
  toolCalls: number;
  latencyMs: number;
  attempts: AttemptDTO[];
  events: EventDTO[];
}

export interface CaseScoreDTO {
  id: string;
  title: string;
  mode: BenchmarkMode;
  verifierPass: boolean;
  falseCompletion: boolean;
  recovered: boolean;
  attempts: number;
  modelCalls: number;
  toolCalls: number;
  latencyMs: number;
  firstFailure?: string;
}

export interface ModeScoreDTO {
  mode: BenchmarkMode;
  cases: CaseScoreDTO[];
  successRate: number;
  falseCompletionRate: number;
  recoveryRate: number;
  avgAttempts: number;
  avgModelCalls: number;
  avgToolCalls: number;
  avgLatencyMs: number;
}

export interface RetrievalHitDTO {
  id: string;
  title: string;
  score?: number;
  relevant: boolean;
}

export interface AblationRowDTO {
  strategy: string;
  query: string;
  precisionAt3: number;
  relevantCount: number;
  hits: RetrievalHitDTO[];
}

export interface AgentStatusDTO {
  kind: "mock" | "openai";
  model: string;
  ready: boolean;
  hint: string;
}

export interface AgentExampleDTO {
  label: string;
  description: string;
}

export interface AgentTaskDTO {
  id: string;
  description: string;
  expected?: {
    file?: string;
    itemCount?: number;
    minRelevant?: number;
    query?: string;
  };
}

export interface AgentStreamEvent {
  type: "log" | "tool_call" | "tool_result" | "delta" | "done" | "error";
  message?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
  preview?: string;
  text?: string;
  session?: AgentSessionDTO;
}

export interface AgentSessionDTO {
  task: AgentTaskDTO;
  modelKind: "workspace" | "openai";
  modelId: string;
  failureAware: boolean;
  run: RunDTO;
  files: Array<{ path: string; content: string }>;
  retrieval?: {
    strategy: string;
    hits: RetrievalHitDTO[];
  };
}

export type InvestigationCatalogGroup = "real-v1" | "fixture" | "recovery";

export interface InvestigationCatalogItemDTO {
  id: string;
  group: InvestigationCatalogGroup;
  owner: string;
  repository: string;
  issueNumber: number;
  label: string;
  description: string;
  sourceUrl?: string;
}

export interface InvestigationCatalogDTO {
  snapshots: InvestigationCatalogItemDTO[];
  fixtures: InvestigationCatalogItemDTO[];
  recovery: InvestigationCatalogItemDTO[];
}

export interface InvestigationRequest {
  issue?: string;
  owner?: string;
  repository?: string;
  issueNumber?: number | string;
  caseId?: string;
  scenarioId?: string;
}

export interface InvestigationCheckDTO {
  id: string;
  name: string;
  status: string;
  message: string;
  evidenceIds?: string[];
}

export interface InvestigationEvidenceDTO {
  id: string;
  kind: string;
  summary: string;
  trust: string;
  url?: string;
  source?: string;
  operation?: string;
  resource?: string;
  repository?: string;
  retrievedAt?: string;
}

export interface InvestigationRelationDTO {
  fromEvidenceId: string;
  toEvidenceId: string;
  type: string;
}

export interface InvestigationClaimDTO {
  id: string;
  text: string;
  polarity: string;
  critical: boolean;
}

export interface InvestigationClaimEvidenceDTO {
  claimId: string;
  evidenceId: string;
  role: string;
}

export interface InvestigationStepDTO {
  step: number;
  tool: string;
  success: boolean;
  reason?: string;
  evidenceIds: string[];
}

export interface InvestigationAttemptDTO {
  id: string;
  attempt: number;
  status?: string;
  parentAttemptId?: string;
  recoveryPlanId?: string;
  failureEventId?: string;
  startedAt?: string;
  endedAt?: string;
  strategy?: string;
  verificationStatus?: string;
  checks: InvestigationCheckDTO[];
  agentConclusion?: string;
  failureType?: string;
  failureReason?: string;
  failureTool?: string;
  failureErrorCode?: string;
  failureRetryable?: boolean;
  missingRequirementIds?: string[];
  recoveryId?: string;
  recoveryAction?: string;
  recoveryReason?: string;
  recoveryNextStep?: string;
  evidenceIds: string[];
  claimIds: string[];
}

export interface InvestigationSessionDTO {
  dataSource: "snapshot";
  catalogId?: string;
  group?: InvestigationCatalogGroup;
  actor: "llm" | "test_driver" | "unconfigured";
  status: string;
  runStatus: string;
  task: {
    owner: string;
    repository: string;
    issueNumber: number;
    description: string;
  };
  verification?: {
    status: string;
    evidenceCoverage: number;
    prematureCompletion: boolean;
    missingRequirementIds: string[];
    unsupportedClaimIds: string[];
    checks: InvestigationCheckDTO[];
  };
  evidence: InvestigationEvidenceDTO[];
  relations: InvestigationRelationDTO[];
  claims: InvestigationClaimDTO[];
  claimEvidence: InvestigationClaimEvidenceDTO[];
  steps: InvestigationStepDTO[];
  attempts: InvestigationAttemptDTO[];
  report: {
    conclusion: string;
    polarity: string;
    resolutionMethod?: string;
    uncertainty: string;
    openQuestions: string[];
  };
}
