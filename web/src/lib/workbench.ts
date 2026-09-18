import type {
  InvestigationAttemptDTO,
  InvestigationEvidenceDTO,
  InvestigationSessionDTO,
} from "@dto";

export type VerificationTone = "verified" | "not_verified" | "insufficient" | "neutral";
export type CheckTone = "pass" | "fail" | "warn" | "unknown";
export type RunPhase = "idle" | "running" | "completed" | "failed";

export interface TraceItem {
  id: string;
  label: string;
  detail?: string;
  tone?: CheckTone;
}

export function issueRef(task: { owner: string; repository: string; issueNumber: number }): string {
  return `${task.owner}/${task.repository}#${task.issueNumber}`;
}

export function verificationLabel(status?: string): string {
  if (status === "verified_complete") {
    return "VERIFIED COMPLETE";
  }
  if (status === "not_verified") {
    return "NOT VERIFIED";
  }
  if (status === "insufficient_evidence") {
    return "INSUFFICIENT EVIDENCE";
  }
  return status ? status.replaceAll("_", " ").toUpperCase() : "NO VERIFICATION";
}

export function verificationTone(status?: string): VerificationTone {
  if (status === "verified_complete") {
    return "verified";
  }
  if (status === "not_verified") {
    return "not_verified";
  }
  if (status === "insufficient_evidence") {
    return "insufficient";
  }
  return "neutral";
}

export function verificationSubtitle(status?: string): string {
  if (status === "verified_complete") {
    return "Independent verification passed";
  }
  if (status === "not_verified") {
    return "Independent verification did not confirm completion";
  }
  if (status === "insufficient_evidence") {
    return "Required evidence is missing; completion cannot be proven";
  }
  return "Independent verifier has not produced a result";
}

export function checkTone(status?: string): CheckTone {
  if (status === "pass") {
    return "pass";
  }
  if (status === "fail") {
    return "fail";
  }
  if (status === "warn") {
    return "warn";
  }
  return "unknown";
}

export function checkMark(status?: string): string {
  const tone = checkTone(status);
  if (tone === "pass") {
    return "✓";
  }
  if (tone === "fail") {
    return "×";
  }
  if (tone === "warn") {
    return "!";
  }
  return "·";
}

export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    issue: "Issue",
    comment: "Comment",
    timeline: "Timeline",
    pull_request: "Pull Request",
    review: "Review",
    file: "File",
    commit: "Commit",
    code: "Code",
    release: "Release",
    doc: "Doc",
    other: "Other",
  };
  return labels[kind] ?? kind.replaceAll("_", " ");
}

export function uniqueEvidenceKinds(items: InvestigationEvidenceDTO[]): string[] {
  return [...new Set(items.map((item) => item.kind))];
}

export function filterEvidence(
  items: InvestigationEvidenceDTO[],
  kind: string,
): InvestigationEvidenceDTO[] {
  if (kind === "all") {
    return items;
  }
  return items.filter((item) => item.kind === kind);
}

export function evidenceIdentifier(item: InvestigationEvidenceDTO): string {
  return item.resource || item.url || item.id;
}

export function isNotFoundError(error: { status?: number; message?: string }): boolean {
  if (error.status === 404) {
    return true;
  }
  return /recorded snapshot|未知|not found/i.test(error.message ?? "");
}

export function investigationErrorTitle(error: { status?: number; message?: string }): string {
  return isNotFoundError(error) ? "Investigation not found" : "Investigation failed";
}

export function satisfiedCount(session: InvestigationSessionDTO): { passed: number; total: number } {
  const checks = session.verification?.checks ?? [];
  return {
    passed: checks.filter((item) => item.status === "pass").length,
    total: checks.length,
  };
}

export function buildTraceItems(session: InvestigationSessionDTO): TraceItem[] {
  const items: TraceItem[] = [
    {
      id: "start",
      label: "Investigation started",
      detail: issueRef(session.task),
    },
  ];

  for (const step of session.steps) {
    items.push({
      id: `step-${step.step}-${step.tool}`,
      label: step.tool,
      detail: step.success ? (step.reason ?? "ok") : (step.reason ?? "failed"),
      tone: step.success ? "pass" : "fail",
    });
    for (const evidenceId of step.evidenceIds) {
      const evidence = session.evidence.find((item) => item.id === evidenceId);
      items.push({
        id: `step-${step.step}-evidence-${evidenceId}`,
        label: "Evidence added",
        detail: evidence ? `${kindLabel(evidence.kind)} · ${evidence.summary}` : evidenceId,
      });
    }
  }

  for (const attempt of session.attempts) {
    items.push({
      id: `attempt-${attempt.id}`,
      label: `Attempt ${attempt.attempt}`,
      detail: [attempt.status, attempt.strategy].filter(Boolean).join(" · ") || undefined,
    });
    if (attempt.verificationStatus) {
      items.push({
        id: `attempt-${attempt.id}-verification`,
        label: "Verification",
        detail: attempt.verificationStatus,
        tone:
          attempt.verificationStatus === "verified_complete"
            ? "pass"
            : attempt.verificationStatus === "insufficient_evidence"
              ? "warn"
              : "fail",
      });
    }
    if (attempt.failureType) {
      items.push({
        id: `attempt-${attempt.id}-failure`,
        label: "Failure",
        detail: attempt.failureType,
        tone: "fail",
      });
    }
    if (attempt.recoveryAction) {
      items.push({
        id: `attempt-${attempt.id}-recovery`,
        label: "Recovery",
        detail: attempt.recoveryAction,
        tone: "warn",
      });
    }
  }

  return items;
}

export function recoveredFrom(attempt: InvestigationAttemptDTO, attempts: InvestigationAttemptDTO[]) {
  if (!attempt.parentAttemptId) {
    return undefined;
  }
  return attempts.find((item) => item.id === attempt.parentAttemptId);
}

export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

export function formatMetric(key: string, value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (/rate|coverage/i.test(key)) {
    const pct = value * 100;
    return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function outcomeLabel(status: string): string {
  return verificationLabel(status);
}
