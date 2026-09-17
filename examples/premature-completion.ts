import {
  AgentLoop,
  WorkspaceCompletionVerifier,
  Harness,
  PrematureCompletionModel,
  ToolRegistry,
  TraceCollector,
  Workspace,
  createWriteJsonTool,
  type Task,
} from "../src/index.js";

const workspace = new Workspace();
const tools = new ToolRegistry();
tools.register(createWriteJsonTool(workspace));

const trace = new TraceCollector();
const model = new PrematureCompletionModel();
const loop = new AgentLoop(model, tools, trace);
const harness = new Harness(loop, trace, workspace, new WorkspaceCompletionVerifier(), {
  maxAttempts: 1,
});

const task: Task = {
  id: "demo-premature-001",
  description: "创建 result.json，里面必须有 5 个商品。",
  expected: {
    file: "result.json",
    itemCount: 5,
  },
};

const result = await harness.run(task);

console.log("\n=== AGENT SAID ===");
console.dir(result.result, { depth: null });

console.log("\n=== VERIFICATION ===");
console.dir(result.verification, { depth: null });

console.log("\n=== FILE ===");
console.log(workspace.readFile("result.json") ?? "(missing)");

console.log("\n=== TRACE ===");
for (const event of result.trace) {
  console.log(`[step=${event.step}] ${event.type}`, JSON.stringify(event.data));
}

if (!result.verification.prematureCompletion) {
  throw new Error("这个 Demo 应该被判定为 premature_completion");
}
