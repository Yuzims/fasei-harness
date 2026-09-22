import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { investigateGitHubIssue } from "../src/server/investigation-service.js";
import { toInvestigationHttpError } from "../src/server/investigation-errors.js";
import { enableEnvProxyForFetch, loadEnvFile } from "../src/server/load-env.js";
import type { InvestigationSessionDTO } from "../src/api/dto.js";
import type { InvestigationMode } from "../src/api/dto.js";

const USAGE = `Usage: npm run investigate -- <github-issue> [--mode=live|snapshot]

  <github-issue>   https://github.com/owner/repo/issues/123  or  owner/repo#123
  --mode           "live" (default) hits the real GitHub API via LiveGitHubProvider.
                   "snapshot" replays recorded snapshot data only; never touches network.
`;

function parseArgs(argv: string[]): { input: string; mode: InvestigationMode } {
  let input: string | undefined;
  let mode: InvestigationMode | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "live" && value !== "snapshot") {
        throw new Error(`Unknown mode: ${value}. Use --mode=live or --mode=snapshot.`);
      }
      mode = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!input) {
      input = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }
  if (!input) {
    throw new Error("A GitHub Issue input is required.");
  }
  return { input, mode: mode ?? "live" };
}

function list(items: string[], empty: string): string {
  return items.length ? items.join("\n") : `  ${empty}`;
}

export function formatInvestigationSession(session: InvestigationSessionDTO): string {
  const target = `${session.task.owner}/${session.task.repository}#${session.task.issueNumber}`;
  const lines: string[] = [];
  lines.push(`Target:               ${target}`);
  lines.push(`Mode:                 ${session.mode}`);
  lines.push(`Investigation Status: ${session.status}`);
  lines.push("");

  lines.push(`Evidence (${session.evidence.length}):`);
  lines.push(
    list(
      session.evidence.map(
        (item) => `  - [${item.kind}] ${item.summary} (trust=${item.trust}, ${item.url ?? "no url"})`,
      ),
      "none captured",
    ),
  );
  lines.push("");

  lines.push(`Claims (${session.claims.length}):`);
  lines.push(
    list(
      session.claims.map(
        (item) => `  - ${item.id} [${item.polarity}${item.critical ? ", critical" : ""}] ${item.text}`,
      ),
      "none recorded",
    ),
  );
  lines.push("");

  lines.push(`Claim Evidence (${session.claimEvidence.length}):`);
  lines.push(
    list(
      session.claimEvidence.map(
        (item) => `  - ${item.claimId} <- ${item.evidenceId} (${item.role})`,
      ),
      "no support links",
    ),
  );
  lines.push("");

  lines.push(`Verification Status:  ${session.verification?.status ?? "not_performed"}`);
  for (const check of session.verification?.checks ?? []) {
    lines.push(`  - ${check.name}: ${check.status}${check.message ? ` — ${check.message}` : ""}`);
  }
  lines.push("");

  const failures = session.attempts.filter((attempt) => attempt.failureType);
  lines.push("Failure:");
  lines.push(
    list(
      failures.map(
        (attempt) =>
          `  - attempt ${attempt.attempt}: ${attempt.failureType}${attempt.failureReason ? ` — ${attempt.failureReason}` : ""}`,
      ),
      "none",
    ),
  );
  lines.push("");

  const recoveries = session.attempts.filter((attempt) => attempt.recoveryAction);
  lines.push("Recovery:");
  lines.push(
    list(
      recoveries.map(
        (attempt) =>
          `  - attempt ${attempt.attempt}: ${attempt.recoveryAction}${attempt.recoveryReason ? ` — ${attempt.recoveryReason}` : ""}`,
      ),
      "none",
    ),
  );
  lines.push("");

  lines.push(`Agent Conclusion (unverified claim, not a verdict): ${session.report.conclusion}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadEnvFile();
  enableEnvProxyForFetch();
  const { input, mode } = parseArgs(process.argv.slice(2));
  try {
    const session = await investigateGitHubIssue(input, { mode, env: process.env });
    console.log(formatInvestigationSession(session));
  } catch (error) {
    const mapped = toInvestigationHttpError(error);
    console.error(`Investigation failed (${mapped.body.error.code}): ${mapped.message}`);
    console.error(USAGE);
    process.exitCode = 1;
  }
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
