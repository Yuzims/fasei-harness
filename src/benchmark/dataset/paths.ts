import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTHETIC_DATASET_ID = "synthetic-v1";

export function syntheticDatasetManifestPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures/benchmark/dataset/synthetic-v1/benchmark-dataset.json",
  );
}

export function syntheticDatasetRootDir(): string {
  return dirname(syntheticDatasetManifestPath());
}
