import {
  FASEI_RECOVERY_SCENARIOS,
  runFaseiBenchmark,
  serializeBenchmarkReport,
} from "../src/benchmark/index.js";

const first = await runFaseiBenchmark(FASEI_RECOVERY_SCENARIOS);
const second = await runFaseiBenchmark(FASEI_RECOVERY_SCENARIOS);

const replay =
  JSON.stringify({
    results: first.results.map((item) => ({
      scenarioId: item.scenarioId,
      observedOutcome: item.observedOutcome,
      passed: item.passed,
      failureTypes: item.failureTypes,
      recovered: item.recovered,
      recoveryAttempted: item.recoveryAttempted,
      attemptCount: item.attemptCount,
    })),
    metrics: first.metrics,
  }) ===
  JSON.stringify({
    results: second.results.map((item) => ({
      scenarioId: item.scenarioId,
      observedOutcome: item.observedOutcome,
      passed: item.passed,
      failureTypes: item.failureTypes,
      recovered: item.recovered,
      recoveryAttempted: item.recoveryAttempted,
      attemptCount: item.attemptCount,
    })),
    metrics: second.metrics,
  });

process.stdout.write(`${serializeBenchmarkReport(first)}\n`);
process.stdout.write(`replayMatch=${replay}\n`);
process.stdout.write(`recoverySuccessRate=${first.metrics.recoverySuccessRate}\n`);
