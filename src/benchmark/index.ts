export {
  FASEI_BENCHMARK_NAME,
  FASEI_BENCHMARK_VERSION,
} from "./types.js";
export type {
  BenchmarkFailureMode,
  BenchmarkMetrics,
  BenchmarkReport,
  BenchmarkScenario,
  BenchmarkScenarioKind,
  ExpectedOutcome,
  ExpectedRecovery,
  ObservedOutcome,
  ScenarioResult,
} from "./types.js";
export {
  FASEI_BENCHMARK_SCENARIOS,
  FASEI_FAILURE_SCENARIOS,
  FASEI_REGRESSION_SCENARIOS,
} from "./scenarios.js";
export {
  buildBenchmarkReport,
  compareOutcome,
  computeBenchmarkMetrics,
  isFalseCompletion,
} from "./metrics.js";
export {
  compareFailureModes,
  compareRecovery,
  evaluateScenarioContract,
  expectedFailureModes,
} from "./evaluate.js";
export { prepareScenarioEnvironment } from "./injection.js";
export {
  executeScenario,
  loadScenarioSnapshot,
  observeScenario,
  resolveScenarioSnapshotPath,
  runBenchmarkCase,
  runFaseiBenchmark,
  runScenario,
  scoreScenario,
  serializeBenchmarkReport,
} from "./runner.js";
export {
  DATASET_SCHEMA_VERSION,
  SYNTHETIC_DATASET_ID,
  BenchmarkDatasetError,
  convertCaseToScenario,
  loadCase,
  loadCaseSnapshot,
  loadDataset,
  loadSnapshot,
  syntheticDatasetManifestPath,
  syntheticDatasetRootDir,
  validateDataset,
} from "./dataset/index.js";
export type {
  BenchmarkDataset,
  BenchmarkDatasetCase,
  BenchmarkDatasetErrorCode,
  BenchmarkDatasetKind,
  BenchmarkDatasetMetadata,
  BenchmarkDatasetSource,
  LoadedDatasetCase,
} from "./dataset/index.js";
