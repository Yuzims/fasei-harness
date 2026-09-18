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
  GROUND_TRUTH_FILE_NAME,
  REAL_DATASET_ID,
  SYNTHETIC_DATASET_ID,
  BenchmarkDatasetError,
  assertGroundTruthMatchesCase,
  assertSnapshotHasNoGroundTruth,
  convertCaseToScenario,
  loadCase,
  loadCaseSnapshot,
  loadDataset,
  loadGroundTruth,
  loadGroundTruthCase,
  loadSnapshot,
  realDatasetGroundTruthPath,
  realDatasetManifestPath,
  realDatasetRootDir,
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
  BenchmarkGroundTruth,
  GroundTruthRecord,
  LoadedDatasetCase,
} from "./dataset/index.js";
