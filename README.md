# Workspace Agent

这是一个**可运行、工具边界明确的 Workspace Agent**，不是 VS Code / Cursor 插件，也不是通用网页搜索引擎。

用户在 React 工作台下任务 → Node API 跑 Agent Loop → 只能调用封闭工具（写文件、本地评测检索、GitHub、计算器）→ 独立 Verifier 检查产物 → 按失败类型恢复。Failure-Aware Harness 是内置层，不是整个产品。

```text
工作台 → /api/agent/run(/stream) → Agent Loop → 封闭工具 → Verifier → Analyzer → Recovery
```

**能做：** 改工作区文件、用 GitHub API 查公开仓库和 README、四则运算、用本地语料演示检索 hubness。  
**不做：** 爬牛客 / 任意网站、当 IDE 插件、多 Agent、LangGraph。

License: MIT。Node 20+（`.nvmrc` 22.14.0）。

## 当前改造进度

目标产品是 **Failure-Aware Software Engineering Investigation Harness**：Agent 可以调查 GitHub Issue，但 **不能自己证明自己完成**。

**Phase 1：** 调查域模型在 `src/domain/`，与 React / Hono / GitHub API / LLM Provider 解耦。

**Phase 2：** GitHub 数据访问统一走 `GitHubDataProvider`（Live REST 或本地 Snapshot replay）。调查 Tool 不再直接 `fetch` GitHub。三个 recorded fixture 在 `fixtures/github/`。

**Phase 3A：** 独立 Investigation Agent（`src/investigation/`）通过现有 AgentLoop + GitHub tools + Provider 做多步调查，产出 Evidence / Claim。Agent **不能**设置 `VERIFIED_COMPLETE`。无 `OPENAI_API_KEY` 时返回 `unconfigured`，不会把 keyword classifier 伪装成自主调查。测试里的 `SnapshotInvestigationDriver`（`useTestDriver: true`）只是 **test fixture**，不是真正的 Investigation Agent。

**Phase 4 — Independent Completion Verifier — DONE：** `IndependentCompletionVerifier` 在 Agent 之后独立判定。Agent conclusion ≠ verification result。`VerificationResult` 由 Harness 产生，不看 Agent 终答，不接受 Agent 自报完成。确定性检查：issue identity / issue state / resolution candidate / PR merged / code-commit evidence / claims / EvidenceRequirement。三个 fixture：`resolved.json` → `verified_complete`，`closed-unmerged.json` → `not_verified`，`insufficient-evidence.json` → `insufficient_evidence`。

**Phase 5 — Failure-aware recovery — DONE：** Failure 先分类再恢复，不是统一 Retry。`FailureAnalyzer` 根据 tool metadata / investigation state / verifier 结果产生 `FailureEvent`。`RecoveryPlanner` 按失败类型给出 `RecoveryPlan`（timeout → bounded backoff；401/404 → stop；retrieval → 换策略；premature completion → 继续补证据；loop → replan/stop；invalid evidence → revalidate；wrong target → recheck）。Recovery 有次数上限，追加新 Attempt，不覆盖旧 Attempt。恢复后重新走 Independent Verifier；只有 Verifier 能给出 `verified_complete`。这是 failure-aware recovery foundation，不是全自动自愈 Agent。

产品主路径：

```text
GitHub
   ↓
Provider
   ↓
Investigation Agent
   ↓
Evidence
   ↓
Verifier
   ↓
Failure Analyzer
   ↓
Recovery Planner
   ↓
applyRecovery
   ↓
new Attempt
```

```text
InvestigationTask → InvestigationRun → Attempt
Evidence / Claim / ClaimEvidence / EvidenceRequirement
IndependentCompletionVerifier → VerificationResult
FailureEvent → RecoveryPlan（按失败类型，不是统一 Retry）
```

`src/legacy/failure` + `src/legacy/recovery` 仍服务 workspace 注入评测。那是 **Legacy Failure Injection**，不是 Investigation Recovery。详见 [`docs/architecture-cleanup.md`](docs/architecture-cleanup.md)。

## 面试一句话

我做了一个有界 Workspace Agent：React 工作台 + Node API + 自建 Loop。模型只做决策，Harness 执行工具。内置 Completion Verifier 抓 False Completion，按失败类型恢复。GitHub 走官方 API，本地 `search` 只用于评测语料。另外用 failure injection 对照盲重试。

## 怎么跑

```bash
nvm use 22.14.0
npm install
npm --prefix web install
npm test
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。默认是工作台。没配 Key 时用规则 Agent；把 Key 写进 `.env` 后重启，工作台走真模型。评测实验室仍用注入脚本。

```bash
cp .env.example .env
# 填 OPENAI_API_KEY。兼容网关改 OPENAI_BASE_URL / OPENAI_MODEL
npm run dev
```

单独起：

```bash
npm run api    # http://127.0.0.1:8787/api/health
npm run web    # http://127.0.0.1:5173
```

生产：`npm run web:build && npm start`，同一端口既提供 API 也提供控制台。

CLI 仍然可用：`npm run mainline` / `benchmark` / `ablation`。主线还会写 `reports/mainline.html`。

## 三层怎么分工

| 层 | 目录 | 做什么 |
|---|---|---|
| 工作台 | `web/` | React：发任务、看工作区、看 Verifier |
| API | `src/server/` | `/api/agent/run` 跑 Agent；`/api/runs` 做注入评测 |
| Agent | `src/agent` `src/core` | 工作台模型 + Loop + Verifier + Recovery |

## 简历可以写（前端岗）

- 做了有界 Workspace Agent：写文件 / GitHub 检索 / 计算，工具集封闭，工作区可见，回答流式输出
- 失败感知是内置层，不是整个产品：Verifier 抓 False Completion，本地检索 hubness 会换 hybrid
- 评测实验室对照：对症恢复 vs 盲重试，成功率 75% vs 25%，误完成率 0% vs 50%
- 检索消融 embedding P@3=0，BM25 / hybrid P@3=1
- 薄 Model Adapter，核心不绑某一家 LLM

## Benchmark

同一批 4 个注入失败。成功与否一律看 Verifier。成本用模型调用次数近似 Token。

| 模式 | 成功率 | 误完成率 | 恢复率 | 平均尝试 | 平均模型调用 |
|---|---|---|---|---|---|
| Baseline 信 Agent | 0% | 75% | 0% | 1.00 | 2.50 |
| 盲重试 | 25% | 50% | 25% | 2.75 | 7.00 |
| 对症恢复 | **75%** | **0%** | **75%** | 1.75 | **4.00** |

循环打转：盲重试 12 次模型调用仍失败；对症恢复识别 loop 后 stop，只调用 4 次。

## Retrieval 消融

查询 `Transformer attention BERT`，gold 为 d1–d3。embedding 是查询 TF-IDF 混语料质心（hubness），不是硬编码改写查询。

| 策略 | P@3 | 相关条数 | 机制 |
|---|---|---|---|
| embedding | **0%** | 0 | 质心先验 → 热门噪声 |
| BM25 | **100%** | 3 | k1=1.2, b=0.75 |
| hybrid | **100%** | 3 | BM25 召回再 TF-IDF 重排 |

## 明确不做 / 不要写

Task Profiler、按难度路由、意图检索全家桶、LangGraph、多智能体。没做的不写。

这是能跑任务的 Agent，加上 failure injection 评测。不要说成万能线上 Runtime。

## 面试 FAQ

**False Completion 是什么？怎么抓？**  
Agent 输出「已经完成」，产物不对。Verifier 看 workspace 文件/条数、检索命中、终答引用，不看自报。

**为什么不用 LLM-as-Judge？**  
文件在不在、是不是 5 条、gold 有没有进 Top-3，都能代码验。

**盲重试为什么不够？**  
同一批失败：盲重试 25%，对症恢复 75%。提前完成被清空后会再写 3 条；检索不换策略还是 hubness；循环再试只会烧步数。

**工作台和评测是什么关系？**  
工作台是产品。评测实验室用注入失败证明为什么要内置这层 Harness。检索任务在工作台里也会真实走 embedding → hybrid。

**真模型从哪接？**  
`.env` 里写 `OPENAI_API_KEY`。国内百炼默认：`OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`，`OPENAI_MODEL=qwen-plus`。工作台有 Key 就走真模型；`AGENT_MODEL=mock` 可强制规则 Agent。Verifier 不改。评测注入不会走真模型。

**Investigation Agent 无 Key 时会怎样？**  
返回 `status: "unconfigured"`。不会回退到 `WorkspaceAgentModel` / `classifyTask()`。若测试需要跑 `fixtures/github/*.json`，显式传入 `useTestDriver: true`。那个 driver 是确定性 fixture，**不是**产品主路径上的 Investigation Agent。
