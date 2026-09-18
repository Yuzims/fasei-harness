import { createTarget } from "../../domain/index.js";
import type { BenchmarkScenario } from "../types.js";
import { BenchmarkDatasetError } from "./errors.js";
import { resolveDatasetSnapshotPath } from "./loader.js";
import type { BenchmarkDataset, BenchmarkDatasetCase } from "./types.js";

/**
 * Dataset Case → BenchmarkScenario.
 *
 * Expected outcome is copied from the case contract.
 * scenario.failureMode is experiment intent and is never used to fill
 * expectedOutcome.failureModes.
 */
export function convertCaseToScenario(
  dataset: BenchmarkDataset,
  datasetCase: BenchmarkDatasetCase,
): BenchmarkScenario {
  const fromDataset = dataset.cases.find((item) => item.caseId === datasetCase.caseId);
  if (!fromDataset) {
    throw new BenchmarkDatasetError("missing_case", `case not in dataset: ${datasetCase.caseId}`);
  }
  const { owner, repository } = splitRepository(datasetCase.source.repository);
  return {
    id: datasetCase.scenarioId,
    description:
      datasetCase.description?.trim() ||
      `Dataset case ${datasetCase.caseId} (${datasetCase.source.repository}#${datasetCase.source.issueNumber})`,
    kind: datasetCase.kind,
    failureMode: datasetCase.failureMode,
    snapshotPath: resolveDatasetSnapshotPath(dataset.rootDir, datasetCase.snapshotPath),
    target: createTarget({
      owner,
      repository,
      issueNumber: datasetCase.source.issueNumber,
    }),
    expectedOutcome: {
      verificationStatus: datasetCase.expectedOutcome.verificationStatus,
      ...(datasetCase.expectedOutcome.failureModes
        ? { failureModes: [...datasetCase.expectedOutcome.failureModes] }
        : {}),
      ...(datasetCase.expectedOutcome.recovery
        ? { recovery: { required: datasetCase.expectedOutcome.recovery.required } }
        : {}),
    },
  };
}

function splitRepository(repository: string): { owner: string; repository: string } {
  const [owner, name] = repository.split("/");
  return { owner, repository: name };
}
