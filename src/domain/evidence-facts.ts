/**
 * Factual fields on Evidence objects.
 *
 * These read identity / state / merge facts from provenance, contentRef, and
 * the normalized GitHub payload. They do not infer graph edges. Relationships
 * live on EvidenceRelation / ClaimEvidence.
 */
import type { Evidence } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function firstMatch(source: string | undefined, pattern: RegExp): number | undefined {
  if (!source) {
    return undefined;
  }
  const match = pattern.exec(source);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface IssueFact {
  evidenceId: string;
  repository: string;
  number: number;
  state?: "open" | "closed";
}

export interface PullFact {
  evidenceId: string;
  repository: string;
  number: number;
  merged?: boolean;
  state?: string;
}

function repositoryOf(item: Evidence, payload: Record<string, unknown>): string {
  return stringField(payload, "repository") ?? item.provenance.repository ?? "";
}

export function issueFact(item: Evidence): IssueFact | undefined {
  if (item.kind !== "issue") {
    return undefined;
  }
  const payload = isRecord(item.payload) ? item.payload : {};
  const number =
    firstMatch(item.contentRef, /^issue:(\d+)$/) ??
    firstMatch(item.provenance.resource, /(?:^|\/)issues\/(\d+)(?:$|[/#])/) ??
    numberField(payload, "number");
  if (!number) {
    return undefined;
  }
  const state = payload.state === "closed" || payload.state === "open" ? payload.state : undefined;
  return {
    evidenceId: item.id,
    repository: repositoryOf(item, payload),
    number,
    state,
  };
}

export function pullFact(item: Evidence): PullFact | undefined {
  if (item.kind !== "pull_request") {
    return undefined;
  }
  const payload = isRecord(item.payload) ? item.payload : {};
  const number =
    firstMatch(item.contentRef, /^pr(?:-merge)?:(\d+)$/) ??
    firstMatch(item.provenance.resource, /(?:^|\/)pull\/(\d+)(?:$|[/#])/) ??
    numberField(payload, "number");
  if (!number) {
    return undefined;
  }
  return {
    evidenceId: item.id,
    repository: repositoryOf(item, payload),
    number,
    merged: typeof payload.merged === "boolean" ? payload.merged : undefined,
    state: stringField(payload, "state"),
  };
}

export const CODE_EVIDENCE_KINDS = ["commit", "file", "code"] as const;
export type CodeEvidenceKind = (typeof CODE_EVIDENCE_KINDS)[number];

export function isCodeEvidence(item: Evidence): boolean {
  return (CODE_EVIDENCE_KINDS as readonly string[]).includes(item.kind);
}
