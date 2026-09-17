import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bindClaimEvidence,
  claimSupportStatus,
  createClaim,
  createClaimEvidenceBinding,
  createEvidence,
  createEvidenceRelation,
  createInvestigationTask,
  createRelation,
  EvidenceGraphError,
  EVIDENCE_RELATION_TYPES,
  isOptionalRequirement,
  requirementSatisfied,
} from "../src/domain/index.js";

const now = "2026-09-17T00:00:00.000Z";

function evidence(kind: "issue" | "pull_request" | "commit", summary: string) {
  return createEvidence({
    kind,
    summary,
    provenance: {
      source: "github",
      repository: "acme/box",
      retrievedAt: now,
      trust: "external_untrusted",
    },
  });
}

test("Evidence Graph：invalid evidence ID is rejected", () => {
  const issue = evidence("issue", "Issue #42");
  assert.throws(
    () =>
      createEvidenceRelation(
        { fromEvidenceId: "missing", toEvidenceId: issue.id, type: "fixes" },
        { evidence: [issue] },
      ),
    (error: unknown) => error instanceof EvidenceGraphError && error.code === "invalid_evidence_id",
  );
});

test("Evidence Graph：invalid relation type is rejected", () => {
  const issue = evidence("issue", "Issue #42");
  const pr = evidence("pull_request", "PR #7");
  assert.throws(
    () =>
      createEvidenceRelation(
        { fromEvidenceId: pr.id, toEvidenceId: issue.id, type: "not_a_type" },
        { evidence: [issue, pr] },
      ),
    (error: unknown) => error instanceof EvidenceGraphError && error.code === "invalid_relation_type",
  );
});

test("Evidence Graph：self-relation is rejected", () => {
  const issue = evidence("issue", "Issue #42");
  assert.throws(
    () =>
      createEvidenceRelation(
        { fromEvidenceId: issue.id, toEvidenceId: issue.id, type: "references" },
        { evidence: [issue] },
      ),
    (error: unknown) => error instanceof EvidenceGraphError && error.code === "self_relation",
  );
  assert.throws(() =>
    createRelation({ fromEvidenceId: issue.id, toEvidenceId: issue.id, type: "references" }),
  );
});

test("Evidence Graph：duplicate relation is deterministic", () => {
  const issue = evidence("issue", "Issue #42");
  const pr = evidence("pull_request", "PR #7");
  const catalog = { evidence: [issue, pr], relations: [] as ReturnType<typeof createEvidenceRelation>[] };
  const first = createEvidenceRelation(
    { fromEvidenceId: pr.id, toEvidenceId: issue.id, type: "fixes" },
    catalog,
  );
  catalog.relations.push(first);
  const second = createEvidenceRelation(
    { fromEvidenceId: pr.id, toEvidenceId: issue.id, type: "fixes" },
    catalog,
  );
  assert.equal(second.id, first.id);
  assert.equal(second.type, "fixes");
});

test("Evidence Graph：invalid claim-evidence reference is rejected", () => {
  const issue = evidence("issue", "Issue #42");
  const claim = createClaim({ text: "resolved", polarity: "resolved" });
  assert.throws(
    () =>
      createClaimEvidenceBinding(
        { claimId: claim.id, evidenceId: "missing", role: "supports" },
        { claims: [claim], evidence: [issue] },
      ),
    (error: unknown) => error instanceof EvidenceGraphError && error.code === "invalid_claim_evidence",
  );
  assert.throws(
    () =>
      createClaimEvidenceBinding(
        { claimId: "missing-claim", evidenceId: issue.id, role: "supports" },
        { claims: [claim], evidence: [issue] },
      ),
    (error: unknown) => error instanceof EvidenceGraphError && error.code === "invalid_claim_id",
  );
});

test("Evidence Graph：unsupported claim cannot verify; contradictory evidence is contradicted", () => {
  const pr = evidence("pull_request", "PR #7 merged");
  const closed = evidence("pull_request", "PR #7 not merged");
  const claim = createClaim({ text: "Issue was resolved", polarity: "resolved" });
  assert.equal(claimSupportStatus(claim.id, [], [pr]), "unsupported");
  const supported = [bindClaimEvidence({ claimId: claim.id, evidenceId: pr.id, role: "supports" })];
  assert.equal(claimSupportStatus(claim.id, supported, [pr]), "supported");
  const both = [
    ...supported,
    bindClaimEvidence({ claimId: claim.id, evidenceId: closed.id, role: "contradicts" }),
  ];
  assert.equal(claimSupportStatus(claim.id, both, [pr, closed]), "contradicted");
});

test("Evidence Graph：optional requirement absence does not count as required", () => {
  const task = createInvestigationTask({
    target: { owner: "acme", repository: "box", issueNumber: 42 },
    requirements: [
      { id: "req-issue", kind: "issue", severity: "critical", description: "issue" },
      {
        id: "req-review",
        kind: "review",
        severity: "optional",
        optional: true,
        description: "reviews",
      },
    ],
  });
  const issue = evidence("issue", "Issue #42");
  assert.equal(isOptionalRequirement(task.requirements[1]!), true);
  assert.equal(requirementSatisfied(task.requirements[0]!, [issue]), true);
  assert.equal(requirementSatisfied(task.requirements[1]!, [issue]), false);
});

test("Evidence Graph：relation types include GitHub investigation edges", () => {
  for (const type of [
    "supports",
    "contradicts",
    "derived_from",
    "references",
    "fixes",
    "merges",
    "reviews",
    "parents",
    "mentions",
  ]) {
    assert.equal(EVIDENCE_RELATION_TYPES.includes(type as never), true, type);
  }
});

test("Evidence Graph：domain module stays free of React / Hono / GitHub HTTP / LLM", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/domain");
  const forbidden =
    /from ["'].*(react|hono|octokit|openai|tools\/github|agent\/openai-compat|server\/app)["']/;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(dir, file), "utf8");
    assert.equal(forbidden.test(source), false, file);
  }
});
