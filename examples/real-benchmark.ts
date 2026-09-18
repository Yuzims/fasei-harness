import {
  formatDatasetBenchmarkSummary,
  realDatasetLatestResultPath,
  runRealDatasetBenchmark,
  serializeDatasetBenchmarkResult,
} from "../src/benchmark/index.js";

const resultPath = realDatasetLatestResultPath();
const result = await runRealDatasetBenchmark({ writeResult: true, resultPath });
process.stdout.write(`${formatDatasetBenchmarkSummary(result, resultPath)}\n\n`);
process.stdout.write(`${serializeDatasetBenchmarkResult(result)}\n`);
