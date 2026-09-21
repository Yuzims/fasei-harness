import { writeFileSync, mkdirSync } from "node:fs";
import { investigateGitHubIssue } from "../src/server/investigation-service.js";
import { loadEnvFile } from "../src/server/load-env.js";

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/(Bearer\s+)[^\s"']+/gi, "$1<redacted>").replace(/(api[_-]?key["'\s:=]+)[^\s"']+/gi, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/authorization|api[_-]?key|token|secret|password/i.test(k)) out[k] = "<redacted>";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  loadEnvFile();
  const runId = process.argv[2] ?? "run";
  const outDir = "artifacts/phase-16.4-B1-e";
  mkdirSync(outDir, { recursive: true });
  const session = await investigateGitHubIssue("microsoft/vscode#258694", { mode: "live", env: process.env });
  const steps = (session.steps ?? []).map((s: any) => ({
    step: s.step,
    tool: s.tool,
    success: s.success,
    reason: s.reason ?? null,
    evidenceIds: s.evidenceIds ?? [],
  }));
  const record = {
    phase: "16.4-B1-e",
    runId,
    model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "unknown",
    task: "Investigate microsoft/vscode#258694 and determine whether the referenced commit provides evidence relevant to resolving the issue.",
    maxSteps: 12,
    maxLlmCalls: 8,
    status: session.status,
    toolCalls: (session as any).toolCalls ?? null,
    modelCalls: (session as any).modelCalls ?? null,
    steps,
    evidence: session.evidence.map((e: any) => ({ id: e.id, kind: e.kind, summary: e.summary, provenance: e.provenance })),
    claims: session.claims,
    claimEvidence: session.claimEvidence,
    verification: session.verification,
  };
  writeFileSync(`${outDir}/${runId}.json`, `${JSON.stringify(redact(record), null, 2)}\n`, "utf8");
  console.log(`wrote ${outDir}/${runId}.json steps=${steps.length} evidence=${session.evidence.length} verification=${session.verification?.status}`);
}

await main();
