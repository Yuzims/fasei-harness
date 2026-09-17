import { runFaseiBenchmark, serializeBenchmarkReport } from "../src/benchmark/index.js";

const report = await runFaseiBenchmark();
process.stdout.write(`${serializeBenchmarkReport(report)}\n`);
