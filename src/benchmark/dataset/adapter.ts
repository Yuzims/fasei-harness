import { createTarget } from "../../domain/index.js";
import type { BenchmarkScenario, ExpectedOutcome } from "../types.js";
import { BenchmarkDatasetError } from "./errors.js";
import { resolveDatasetSnapshotPath } from "./loader.js";
import type { BenchmarkDataset, BenchmarkDatasetCase } from "./types.js";

function copyExpectedOutcome(expected: ExpectedOutcome): ExpectedOutcome {
  return {
    verificationStatus: expected.verificationStatus,
    ...(expected.failureModes ? { failureModes: [...expected.failureModes] } : {}),
    ...(expected.recovery ? { recovery: { required: expected.recovery.required } } : {}),
  };
}

/**
 * Dataset Case → BenchmarkScenario.
 *
 * Copies agent-facing input only. Synthetic evaluation contracts may be
 * attached as scenario.expectedOutcome for the evaluator; real cases omit
 * that field. Ground truth is never copied from ground-truth.json here.
 *
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
  const expected = dataset.evaluationOutcomes?.[datasetCase.caseId];
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
    ...(expected ? { expectedOutcome: copyExpectedOutcome(expected) } : {}),
  };
}

function splitRepository(repository: string): { owner: string; repository: string } {
  const [owner, name] = repository.split("/");
  return { owner, repository: name };
}
