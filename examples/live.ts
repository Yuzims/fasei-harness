import {
  AgentLoop,
  WorkspaceCompletionVerifier,
  Harness,
  ToolRegistry,
  TraceCollector,
  Workspace,
  calculatorTool,
  createModel,
  readLlmConfig,
  type Task,
} from "../src/index.js";

const config = readLlmConfig();
const workspace = new Workspace();
const tools = new ToolRegistry();
tools.register(calculatorTool);

const model = createModel({ tools: tools.list() });
const trace = new TraceCollector();
const loop = new AgentLoop(model, tools, trace);
const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier());

const task: Task = {
  id: "live-calc",
  description: "Calculate 123 × 456. Use the calculator tool.",
};

console.log(`\nModel seam: kind=${config.kind} model=${config.model}`);
console.log("Harness / Verifier 不变。有 OPENAI_API_KEY 就走真模型；评测注入仍用脚本。\n");

const run = await harness.run(task);

console.log("Verifier:", run.verification.status);
for (const check of run.verification.checks) {
  console.log(`  - ${check.name}: ${check.passed ? "PASS" : "FAIL"} ${check.reason ?? ""}`);
}
console.log("Agent:", String(run.result.output));
console.log(`modelCalls=${run.modelCalls} toolCalls=${run.toolCalls}`);
