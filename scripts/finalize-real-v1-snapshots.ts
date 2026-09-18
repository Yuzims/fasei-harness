/**
 * Apply generic snapshot finalization to recorded real-v1 cases.
 * Uses already-captured GitHub observations. Does not call the GitHub network.
 */
import { join } from "node:path";
import { finalizeInvestigationSnapshot, loadSnapshot, saveSnapshot } from "../src/github/index.js";
import { loadDataset, realDatasetManifestPath } from "../src/benchmark/dataset/index.js";

const dataset = loadDataset(realDatasetManifestPath());
for (const item of dataset.cases) {
  const file = join(dataset.rootDir, item.snapshotPath);
  const before = loadSnapshot(file);
  const after = finalizeInvestigationSnapshot(before);
  saveSnapshot(file, after);
  const added = after.timeline.length - before.timeline.length;
  const prs = Object.keys(after.pullRequests).join(",") || "none";
  process.stdout.write(
    `${item.caseId} prs=${prs} timeline ${before.timeline.length}->${after.timeline.length} (+${added})\n`,
  );
}
