/**
 * One-time importer for the curated real-v1 GitHub issue cases.
 *
 * Uses existing LiveGitHubProvider → captureInvestigationSnapshot → saveSnapshot.
 * Completeness repairs of these same 10 cases bump datasetVersion (currently v1.1).
 * Capturing a different issue set should be real-v2, not a silent rewrite of real-v1.
 *
 * GITHUB_TOKEN is read from the process environment / local .env only.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "../src/server/load-env.js";
import { captureInvestigationSnapshot, LiveGitHubProvider, saveSnapshot } from "../src/github/index.js";
import { realDatasetRootDir } from "../src/benchmark/dataset/paths.js";

loadEnvFile();

if (!process.env.GITHUB_TOKEN?.trim()) {
  throw new Error("GITHUB_TOKEN is required. Set it in local .env; do not commit it.");
}

interface CuratedCase {
  caseId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  pullNumbers?: number[];
  commitShas?: string[];
  includeTimelinePulls?: boolean;
}

const CASES: CuratedCase[] = [
  {
    caseId: "C01",
    owner: "microsoft",
    repo: "vscode",
    issueNumber: 258694,
    pullNumbers: [284149],
    commitShas: ["67f18f1", "32a3ad5307cd412be2f5e1613fa1eea363259c63"],
  },
  {
    caseId: "C02",
    owner: "pytest-dev",
    repo: "pytest",
    issueNumber: 14524,
    pullNumbers: [14527],
    commitShas: ["c717006", "3cd1988"],
  },
  {
    caseId: "C03",
    owner: "streamlit",
    repo: "streamlit",
    issueNumber: 10721,
    pullNumbers: [14022],
  },
  {
    caseId: "C04",
    owner: "mavlink",
    repo: "qgroundcontrol",
    issueNumber: 14521,
    pullNumbers: [14504],
  },
  {
    caseId: "C05",
    owner: "cli",
    repo: "cli",
    issueNumber: 13070,
    includeTimelinePulls: false,
  },
  {
    caseId: "C06",
    owner: "cli",
    repo: "cli",
    issueNumber: 6686,
    includeTimelinePulls: false,
  },
  {
    caseId: "C07",
    owner: "better-auth",
    repo: "better-auth",
    issueNumber: 4490,
    pullNumbers: [7256],
  },
  {
    caseId: "C08",
    owner: "beyond-all-reason",
    repo: "bar-lobby",
    issueNumber: 291,
    commitShas: ["6398312", "e70118a"],
  },
  {
    caseId: "C09",
    owner: "olafkfreund",
    repo: "Factory",
    issueNumber: 273,
    pullNumbers: [279],
  },
  {
    caseId: "C10",
    owner: "microsoft",
    repo: "playwright-mcp",
    issueNumber: 1495,
    includeTimelinePulls: false,
  },
];

const capturedAt = new Date().toISOString();
const provider = new LiveGitHubProvider({
  timeoutMs: 30_000,
  maxRetries: 2,
  backoffMs: 200,
});

const root = realDatasetRootDir();
for (const item of CASES) {
  const caseDir = join(root, "cases", item.caseId);
  mkdirSync(caseDir, { recursive: true });
  const file = join(caseDir, "snapshot.json");
  if (existsSync(file) && process.env.FASEI_RECAPTURE !== "1") {
    process.stdout.write(`skip ${item.caseId} (snapshot exists)\n`);
    continue;
  }
  process.stdout.write(`capturing ${item.caseId} ${item.owner}/${item.repo}#${item.issueNumber}...\n`);
  const snapshot = await captureInvestigationSnapshot(provider, {
    snapshotId: `real-v1-${item.caseId}`,
    owner: item.owner,
    repo: item.repo,
    issueNumber: item.issueNumber,
    pullNumbers: item.pullNumbers,
    commitShas: item.commitShas,
    includeTimelinePulls: item.includeTimelinePulls,
    includeRepoCommits: false,
    createdAt: capturedAt,
  });
  saveSnapshot(file, snapshot);
  process.stdout.write(
    `  wrote ${item.caseId} issue=${snapshot.issue.state}/${snapshot.issue.stateReason ?? "null"} prs=${Object.keys(snapshot.pullRequests).join(",") || "none"} commits=${Object.keys(snapshot.commitIndex).length}\n`,
  );
}

process.stdout.write(`capturedAt=${capturedAt}\n`);
