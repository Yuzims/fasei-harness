/**
 * Claim Capture Boundary (Phase 14.1).
 *
 * Agent Output → structured ClaimInput → record_claim() → InvestigationRun.claims
 *
 * This is a write path into the existing Claim model. It is idempotent by
 * stable Claim identity (exact text + polarity + critical; Evidence is a
 * ClaimEvidence relation, never part of Claim identity), so repeated writes
 * through either path reuse the existing Claim. It does not:
 * - parse AgentResult.output
 * - create Evidence
 * - judge support / truth
 * - write VerificationResult
 * - set claimsRecorded or touch Resolution Analysis (record_claim tool only)
 */
import { createHash } from "node:crypto";
import {
  createClaim,
  createClaimEvidenceBinding,
  type Claim,
  type ClaimEvidenceRole,
  type ClaimPolarity,
} from "../domain/index.js";
import type { AgentResult, ClaimInput } from "../core/types.js";
import type { TraceCollector } from "../trace/trace-collector.js";
import type { InvestigationState } from "./state.js";

const POLARITIES: ClaimPolarity[] = ["resolved", "unresolved", "partial", "unknown"];
const ROLES: ClaimEvidenceRole[] = ["supports", "contradicts", "contextual"];

export type ClaimCaptureSource = "agent_result" | "record_claim";

export interface ClaimCaptureSession {
  state: InvestigationState;
  trace: TraceCollector;
  runId: string;
}

export interface RecordClaimOptions {
  source?: ClaimCaptureSource;
  /**
   * "throw" keeps the record_claim tool semantics (invalid evidence fails the
   * tool call). "skip" drops claims referencing unknown Evidence instead of
   * throwing — used by the Agent final-claims capture boundary, which must
   * never abort the run before verification.
   */
  onInvalidEvidence?: "throw" | "skip";
}

export interface RecordClaimResult {
  claimIds: string[];
  /** Claim IDs reused because an identical Claim already existed. */
  duplicateClaimIds: string[];
}

/**
 * Stable Claim identity: exact text + polarity + critical.
 * Evidence is deliberately excluded — a Claim-to-Evidence link is a
 * ClaimEvidence relation, so the same Claim bound to different Evidence stays
 * one Claim. Literal fields only: no similarity, no LLM, no embedding.
 */
export function claimFingerprint(
  input: Pick<ClaimInput, "text" | "polarity" | "critical">,
): string {
  const payload = JSON.stringify([
    input.text,
    parsePolarity(input.polarity),
    input.critical !== false,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function parsePolarity(value: unknown): ClaimPolarity {
  if (typeof value === "string" && (POLARITIES as string[]).includes(value)) {
    return value as ClaimPolarity;
  }
  return "unknown";
}

export function parseRole(value: unknown): ClaimEvidenceRole {
  if (typeof value === "string" && (ROLES as string[]).includes(value)) {
    return value as ClaimEvidenceRole;
  }
  return "supports";
}

export function asClaimInputs(value: unknown): ClaimInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = asClaimInput(item);
    return parsed ? [parsed] : [];
  });
}

export function asClaimInput(value: unknown): ClaimInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.text !== "string") {
    return undefined;
  }
  const evidenceIds = Array.isArray(item.evidenceIds)
    ? item.evidenceIds.filter((id): id is string => typeof id === "string")
    : undefined;
  return {
    text: item.text,
    polarity: parsePolarity(item.polarity),
    critical: item.critical !== false,
    evidenceIds,
    role: parseRole(item.role),
  };
}

/**
 * Only legal Claim writer. Creates Claim objects; binds existing Evidence IDs only.
 * Does not mint Evidence and does not set support / verification status.
 */
export function record_claim(
  session: ClaimCaptureSession,
  claims: readonly ClaimInput[],
  options: RecordClaimOptions = {},
): RecordClaimResult {
  const source = options.source ?? "record_claim";
  const onInvalidEvidence = options.onInvalidEvidence ?? "throw";
  const known = new Set(session.state.run.evidence.map((item) => item.id));
  const byFingerprint = new Map<string, Claim>();
  for (const existing of session.state.run.claims) {
    const key = claimFingerprint(existing);
    if (!byFingerprint.has(key)) {
      byFingerprint.set(key, existing);
    }
  }
  const created: string[] = [];
  const duplicates: string[] = [];

  for (const item of claims) {
    const input = asClaimInput(item);
    if (!input) {
      continue;
    }
    const evidenceIds = input.evidenceIds ?? [];
    const missing = evidenceIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      if (onInvalidEvidence === "throw") {
        throw new Error(`record_claim unknown evidence ids: ${missing.join(", ")}`);
      }
      continue;
    }

    const key = claimFingerprint(input);
    const existing = byFingerprint.get(key);
    const claim =
      existing ??
      createClaim({
        text: input.text,
        polarity: parsePolarity(input.polarity),
        critical: input.critical !== false,
      });
    if (!existing) {
      session.state.addClaim(claim);
      byFingerprint.set(key, claim);
    } else {
      duplicates.push(claim.id);
    }

    const role = parseRole(input.role);
    for (const evidenceId of evidenceIds) {
      session.state.bind(
        createClaimEvidenceBinding(
          { claimId: claim.id, evidenceId, role },
          {
            claims: session.state.run.claims,
            evidence: session.state.run.evidence,
            claimEvidence: session.state.run.claimEvidence,
          },
        ),
      );
    }

    if (!existing) {
      session.trace.record(session.runId, session.state.currentStep, "claim_created", {
        claimId: claim.id,
        text: claim.text,
        polarity: claim.polarity,
        evidenceIds,
        role,
      });
      session.trace.record(session.runId, session.state.currentStep, "claim_recorded", {
        claimId: claim.id,
        source,
        type: "claim",
      });
      created.push(claim.id);
    }
  }

  return { claimIds: created, duplicateClaimIds: duplicates };
}

/**
 * Capture structured claims from an Agent runtime result.
 * Ignores `output` / answer text. Empty or missing claims[] is a no-op.
 * Agent output is untrusted: a claim referencing unknown Evidence is dropped
 * here rather than thrown, so capture can never abort the run before verification.
 */
export function captureAgentClaims(
  session: ClaimCaptureSession,
  result: Pick<AgentResult, "claims"> | undefined,
): RecordClaimResult & { droppedUnknownEvidence: number } {
  const claims = asClaimInputs(result?.claims);
  if (claims.length === 0) {
    return { claimIds: [], duplicateClaimIds: [], droppedUnknownEvidence: 0 };
  }
  const recorded = record_claim(session, claims, {
    source: "agent_result",
    onInvalidEvidence: "skip",
  });
  return {
    ...recorded,
    droppedUnknownEvidence: claims.length - recorded.claimIds.length - recorded.duplicateClaimIds.length,
  };
}
