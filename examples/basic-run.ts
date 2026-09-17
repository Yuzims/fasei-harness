import {
  AgentLoop,
  WorkspaceCompletionVerifier,
  Harness,
  ToolRegistry,
  TraceCollector,
  Workspace,
  calculatorTool,
  createModel,
  type Task,
} from "../src/index.js";

const workspace = new Workspace();
const tools = new ToolRegistry();
tools.register(calculatorTool);

const trace = new TraceCollector();
const model = createModel({ tools: tools.list() });
const loop = new AgentLoop(model, tools, trace);
const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier());

const task: Task = {
  id: "demo-001",
  description: "Calculate 123 × 456.",
};

const result = await harness.run(task);

console.log("\n=== RESULT ===");
console.dir(result.result, { depth: null });

console.log("\n=== VERIFICATION ===");
console.dir(result.verification, { depth: null });

console.log("\n=== TRACE ===");
for (const event of result.trace) {
  console.log(`[step=${event.step}] ${event.type}`, JSON.stringify(event.data));
}
