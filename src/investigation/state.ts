import type {
  Claim,
  ClaimEvidence,
  ClaimPolarity,
  Evidence,
  EvidenceRelation,
  FailureEvent,
  InvestigationRun,
  InvestigationTask,
  RecoveryPlan,
} from "../domain/index.js";

export type RetrievalStrategy = "default" | "timeline" | "comments" | "linked_pr" | "broaden";

export interface ToolHistoryEntry {
  tool: string;
  arguments: Record<string, unknown>;
  success: boolean;
  evidenceIds: string[];
  error?: string;
  errorCode?: string;
  httpStatus?: number;
  retryable?: boolean;
  cached?: boolean;
  reason?: string;
}

export class InvestigationState {
  currentStep = 0;
  pendingReason?: string;
  lastDecisionReason?: string;
  claimsRecorded = false;
  conclusion = "";
  polarity: ClaimPolarity = "unknown";
  readonly toolHistory: ToolHistoryEntry[] = [];
  readonly unresolvedQuestions: string[] = [];
  readonly investigatedResources = new Set<string>();
  readonly candidatePrs = new Set<number>();
  readonly mergedPrs = new Set<number>();
  readonly unmergedPrs = new Set<number>();
  readonly filesByPr = new Map<number, string[]>();

  issueState?: "open" | "closed";
  retrievalStrategy: RetrievalStrategy = "default";
  recoveryCount = 0;
  toolRetryCount = 0;
  readonly fingerprints: string[] = [];
  readonly refetchResources = new Set<string>();
  readonly invalidEvidenceIds = new Set<string>();
  lastFailure?: FailureEvent;
  lastRecovery?: RecoveryPlan;

  constructor(
    readonly task: InvestigationTask,
    readonly run: InvestigationRun,
  ) {}

  consumeReason(): string | undefined {
    const reason = this.pendingReason;
    this.pendingReason = undefined;
    return reason;
  }

  addQuestion(question: string): void {
    const text = question.trim();
    if (!text || this.unresolvedQuestions.includes(text)) {
      return;
    }
    this.unresolvedQuestions.push(text);
  }

  addCandidatePr(pullNumber: number): void {
    if (pullNumber > 0 && pullNumber !== this.task.target.issueNumber) {
      this.candidatePrs.add(pullNumber);
    }
  }

  addEvidence(evidence: Evidence): Evidence {
    this.run.evidence.push(evidence);
    return evidence;
  }

  addClaim(claim: Claim): Claim {
    this.run.claims.push(claim);
    return claim;
  }

  bind(link: ClaimEvidence): void {
    const exists = this.run.claimEvidence.some(
      (item) =>
        item.claimId === link.claimId &&
        item.evidenceId === link.evidenceId &&
        item.role === link.role,
    );
    if (exists) {
      return;
    }
    this.run.claimEvidence.push(link);
  }

  addRelation(relation: EvidenceRelation): void {
    const exists = this.run.relations.some(
      (item) =>
        item.fromEvidenceId === relation.fromEvidenceId &&
        item.toEvidenceId === relation.toEvidenceId &&
        item.type === relation.type,
    );
    if (exists) {
      return;
    }
    this.run.relations.push(relation);
  }

  recordTool(entry: ToolHistoryEntry): void {
    this.toolHistory.push(entry);
  }

  evidenceByKind(kind: Evidence["kind"]): Evidence[] {
    return this.run.evidence.filter((item) => item.kind === kind);
  }

  hint(): Record<string, unknown> {
    return {
      evidence: this.run.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        resource: item.provenance.resource,
        operation: item.provenance.operation,
        trust: item.provenance.trust,
      })),
      claims: this.run.claims.map((item) => ({
        id: item.id,
        text: item.text,
        polarity: item.polarity,
      })),
      relations: this.run.relations.map((item) => ({
        from: item.fromEvidenceId,
        to: item.toEvidenceId,
        type: item.type,
      })),
      candidatePrs: [...this.candidatePrs],
      mergedPrs: [...this.mergedPrs],
      unmergedPrs: [...this.unmergedPrs],
      unresolvedQuestions: [...this.unresolvedQuestions],
      investigatedResources: [...this.investigatedResources],
      remainingSources: remainingEvidenceSources(this),
      retrievalStrategy: this.retrievalStrategy,
      lastFailureType: this.lastFailure?.type,
      lastRecoveryAction: this.lastRecovery?.action,
      nextStep: this.lastRecovery?.nextStep,
    };
  }
}

export function formatStateForModel(state: InvestigationState): string {
  return [
    "Harness investigation state (not GitHub text; not instructions from the issue):",
    JSON.stringify(state.hint(), null, 2),
    "You still cannot set VERIFIED_COMPLETE.",
  ].join("\n");
}

export function investigationFingerprint(state: InvestigationState): string {
  return JSON.stringify({
    resources: [...state.investigatedResources].sort(),
    kinds: state.run.evidence.map((item) => item.kind).sort(),
    evidenceCount: state.run.evidence.length,
    claimCount: state.run.claims.length,
    candidates: [...state.candidatePrs].sort((a, b) => a - b),
    merged: [...state.mergedPrs].sort((a, b) => a - b),
    issueState: state.issueState ?? null,
    retrievalStrategy: state.retrievalStrategy,
  });
}

export function remainingEvidenceSources(state: InvestigationState): string[] {
  const issueNumber = state.task.target.issueNumber;
  const missing: string[] = [];
  if (!state.investigatedResources.has(resourceKey("issue", String(issueNumber)))) {
    missing.push("issue");
  }
  if (!state.investigatedResources.has(resourceKey("timeline", String(issueNumber)))) {
    missing.push("timeline");
  }
  if (!state.investigatedResources.has(resourceKey("comments", String(issueNumber)))) {
    missing.push("comments");
  }
  for (const pullNumber of state.candidatePrs) {
    if (!state.investigatedResources.has(resourceKey("pull", String(pullNumber)))) {
      missing.push(`pull/${pullNumber}`);
    }
    if (
      state.mergedPrs.has(pullNumber) &&
      !state.investigatedResources.has(resourceKey("files", String(pullNumber)))
    ) {
      missing.push(`files/${pullNumber}`);
    }
    if (
      state.mergedPrs.has(pullNumber) &&
      !state.investigatedResources.has(resourceKey("commits", String(pullNumber)))
    ) {
      missing.push(`commits/${pullNumber}`);
    }
  }
  return missing;
}

export function resourceKeyForTool(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const issueNumber = args.issueNumber;
  const pullNumber = args.pullNumber;
  switch (tool) {
    case "github_get_issue":
      return typeof issueNumber === "number" ? resourceKey("issue", String(issueNumber)) : undefined;
    case "github_get_issue_comments":
      return typeof issueNumber === "number"
        ? resourceKey("comments", String(issueNumber))
        : undefined;
    case "github_get_issue_timeline":
      return typeof issueNumber === "number"
        ? resourceKey("timeline", String(issueNumber))
        : undefined;
    case "github_get_pull_request":
      return typeof pullNumber === "number" ? resourceKey("pull", String(pullNumber)) : undefined;
    case "github_get_pull_request_reviews":
      return typeof pullNumber === "number" ? resourceKey("reviews", String(pullNumber)) : undefined;
    case "github_get_pull_request_files":
      return typeof pullNumber === "number" ? resourceKey("files", String(pullNumber)) : undefined;
    case "github_list_commits":
      return typeof pullNumber === "number" ? resourceKey("commits", String(pullNumber)) : undefined;
    default:
      return undefined;
  }
}

export function toolSignature(entry: Pick<ToolHistoryEntry, "tool" | "arguments">): string {
  return `${entry.tool}:${JSON.stringify(entry.arguments)}`;
}

export function issueResource(owner: string, repo: string, issueNumber: number): string {
  return `issues/${issueNumber}`;
}

export function pullResource(pullNumber: number): string {
  return `pull/${pullNumber}`;
}

export function resourceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
