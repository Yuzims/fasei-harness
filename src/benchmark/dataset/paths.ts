import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTHETIC_DATASET_ID = "synthetic-v1";
export const REAL_DATASET_ID = "real-v1";
export const GROUND_TRUTH_FILE_NAME = "ground-truth.json";

function datasetRoot(id: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/benchmark/dataset", id);
}

export function syntheticDatasetManifestPath(): string {
  return join(datasetRoot(SYNTHETIC_DATASET_ID), "benchmark-dataset.json");
}

export function syntheticDatasetRootDir(): string {
  return dirname(syntheticDatasetManifestPath());
}

export function realDatasetManifestPath(): string {
  return join(datasetRoot(REAL_DATASET_ID), "manifest.json");
}

export function realDatasetRootDir(): string {
  return dirname(realDatasetManifestPath());
}

export function realDatasetGroundTruthPath(): string {
  return join(realDatasetRootDir(), GROUND_TRUTH_FILE_NAME);
}
