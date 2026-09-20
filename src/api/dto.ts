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

export type InvestigationMode = "live" | "snapshot";

export interface InvestigationRequest {
  issue?: string;
  input?: string;
  owner?: string;
  repository?: string;
  issueNumber?: number | string;
  caseId?: string;
  scenarioId?: string;
  mode?: InvestigationMode;
  source?: InvestigationMode;
}

export interface InvestigationApiErrorDTO {
  code: string;
  message: string;
  githubCode?: string;
  retryAfterSeconds?: number;
  retryAt?: string;
}

export interface InvestigationIssueDTO {
  owner: string;
  repository: string;
  number: number;
  title?: string;
  state?: string;
  url?: string;
  summary?: string;
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

export interface ResolutionSignalDTO {
  type: string;
  status: string;
  evidenceIds: string[];
  explanation?: string;
}

export interface EvidenceReferenceDTO {
  evidenceId: string;
  role: string;
  trust?: string;
}

export interface ResolutionAnalysisDTO {
  candidateId?: string;
  candidateEvidenceId: string;
  issueEvidenceId: string;
  mergeCommitSha?: string;
  codeRelevance: string;
  behavioralAlignment: string;
  testSupport: string;
  unresolvedQuestions: string[];
  supportingEvidenceIds: string[];
  claimIds: string[];
  signals?: ResolutionSignalDTO[];
  overall?: string;
  provenance?: EvidenceReferenceDTO[];
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
  recoveryNextRequirementIds?: string[];
  evidenceIds: string[];
  claimIds: string[];
}

export interface InvestigationSessionDTO {
  mode: InvestigationMode;
  dataSource: InvestigationMode;
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
  issue: InvestigationIssueDTO;
  agentOutput: string;
  /** Original AgentResult.output when present. Presentation only; never a verification verdict. */
  rawAgentOutput?: string;
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
  resolutionAnalyses?: ResolutionAnalysisDTO[];
  steps: InvestigationStepDTO[];
  attempts: InvestigationAttemptDTO[];
  report: {
    conclusion: string;
    polarity: string;
    resolutionMethod?: string;
    uncertainty: string;
    openQuestions: string[];
  };
  llmUsage?: LlmUsageAggregateDTO;
  runtimeBudget?: {
    maxLlmCalls: number;
    maxWallClockMs: number;
  };
}

export interface LlmUsageDTO {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmCallDTO {
  callId: string;
  callIndex: number;
  model: string;
  usage: LlmUsageDTO;
  durationMs: number;
  historyLength?: number;
  attempt?: number;
  agentStep?: number;
  serializedRequestChars?: number;
  estimatedInputTokens?: number | null;
  messageCount?: number;
  context?: LlmContextBreakdownDTO;
  ok: boolean;
  errorCategory?: string;
}

export interface LlmMessageProfileDTO {
  role: string;
  count: number;
  totalChars: number;
}

export interface LlmToolContributionDTO {
  toolName: string;
  invocationCount: number;
  totalChars: number;
  largestResultChars: number;
}

export interface LlmContextBreakdownDTO {
  systemMessageChars: number;
  userMessageChars: number;
  assistantMessageChars: number;
  toolMessageChars: number;
  systemMessageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  messageCount: number;
  serializedMessagesChars: number;
  serializedToolsChars: number;
  estimatedMessageTokens: number | null;
  estimatedToolsTokens: number | null;
  estimatedTotalInputTokens: number | null;
  estimatedInputTokens: number | null;
  historyLength: number;
  serializedRequestChars: number;
  messageRoles: LlmMessageProfileDTO[];
  toolResultCount: number;
  totalToolResultChars: number;
  largestToolResultChars: number;
  toolContributions: LlmToolContributionDTO[];
  messagesFingerprint: string | null;
  toolsFingerprint: string | null;
  messagesPrefixFingerprint: string | null;
  messageSequenceFingerprint: string | null;
}

export interface LlmUsageAggregateDTO {
  model: string | null;
  llmCalls: number;
  totalInputTokens: number | null;
  totalCachedInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  overallCacheHitRate: number | null;
  averageInputTokensPerCall: number | null;
  averageOutputTokensPerCall: number | null;
  summary: string;
  profilingSummary: string;
  calls: LlmCallDTO[];
}
