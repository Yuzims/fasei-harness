# Failure-Aware Software Engineering Investigation Harness

## 0. 文档目的

本文档是本项目的**完整实现规格（Implementation Specification）**。

目标不是开发一个普通的 GitHub AI Agent，而是基于真实 GitHub 软件工程数据，构建一个能够：

1. 理解用户的软件工程调查任务；
2. 自主检索 Issue、Comments、PR、Commit、Code、History 等证据；
3. 根据证据形成调查结论；
4. 独立验证 Agent 的结论；
5. 识别 Agent 执行过程中的失败；
6. 针对不同失败类型选择不同恢复策略；
7. 在证据不足时拒绝 Agent 的“虚假完成”；
8. 记录完整执行轨迹；
9. 在真实任务集上评估 Harness 是否真的提高 Agent Reliability。

项目的重点不是 GitHub API 本身，也不是 RAG 本身。

核心研究问题：

> **Agent 说自己完成了任务，不代表任务真的完成。Harness 能否通过外部环境状态、证据链和独立验证判断 Agent 是否真正完成，并在失败时进行针对性恢复？**

---

# 1. 项目定位

## 1.1 项目名称

推荐：

**Failure-Aware Software Engineering Investigation Harness**

简称：

**FASEI Harness**

中文：

**面向软件工程调查的 Failure-Aware Agent Harness**

---

# 2. 项目核心思想

传统 Agent：

```text
User Task
   ↓
Agent
   ↓
Tools
   ↓
Agent Answer
   ↓
Done
```

问题：

Agent 自己决定自己是否完成。

这是不可靠的。

---

本项目：

```text
User Task
   ↓
Failure-Aware Harness
   ↓
Agent Loop
   ↓
Tool / Retrieval
   ↓
Evidence
   ↓
Agent Conclusion
   ↓
Independent Verification
   ↓
┌───────────────┬────────────────┐
│ PASS          │ FAIL           │
│               │                │
↓               ↓                │
DONE       Failure Attribution   │
                ↓                │
         Recovery Planning      │
                ↓                │
         Re-execution ──────────┘
```

核心区别：

> **Agent 负责调查，Harness 负责判断调查是否完成。**

---

# 3. 真实业务场景

## 3.1 用户是谁

主要用户：

* 开发者
* 开源项目维护者
* 技术负责人
* Code Reviewer
* Debugger
* 需要快速理解历史 Issue 的工程师

---

# 3.2 用户真实需求

用户在 GitHub 看到一个 Issue：

> “这个问题后来到底有没有被解决？如果解决了，是怎么解决的？”

正常情况下需要自己：

```text
Issue
 ↓
查看发布时间
 ↓
查看评论
 ↓
查看是否有 PR
 ↓
查看 PR 是否 Merge
 ↓
查看 PR 修改内容
 ↓
查看 Commit
 ↓
查看相关源码
 ↓
查看历史 Issue
 ↓
综合判断
```

本项目自动完成这一调查。

---

# 3.3 用户输入

第一阶段支持：

```text
Investigate https://github.com/{owner}/{repo}/issues/{number}

Determine:
1. Whether this issue has been resolved.
2. If resolved, how it was resolved.
3. Which PR/commit/code changes provide evidence.
4. Whether the evidence is sufficient to support the conclusion.
```

也允许自然语言：

```text
帮我调查这个 Issue 有没有解决，怎么解决的，并给出证据。
```

---

# 4. 非目标

第一阶段明确不做：

### 不做普通 GitHub Chatbot

不是：

> “帮我总结这个 Issue。”

### 不做普通 RAG

不是：

```text
Query
 ↓
Vector DB
 ↓
Top K
 ↓
LLM
```

### 不做 Issue 自动分类产品

不是：

* 自动打 label
* 自动关闭 Issue
* 自动判断 spam

### 不做 Coding Agent

第一阶段不负责：

* 修改代码
* 创建 PR
* 自动修 bug

### 不做“万能 GitHub Agent”

第一阶段只聚焦：

> **Issue Resolution Investigation**

但是底层抽象必须允许未来扩展到：

* PR Investigation
* Regression Investigation
* Bug Investigation
* Commit Investigation

---

# 5. 核心业务定义

系统最终不是输出：

```text
resolved: true
```

而是输出：

```text
InvestigationResult
```

至少包含：

```text
Issue
Resolution Status
Resolution Method
Evidence
Evidence Chain
Confidence / Verification Status
Uncertainty
```

---

# 6. Resolution Status

必须定义明确状态机。

推荐四种状态：

```text
RESOLVED
PARTIALLY_RESOLVED
UNRESOLVED
INSUFFICIENT_EVIDENCE
```

---

## 6.1 RESOLVED

满足：

1. Issue 确实存在；
2. 找到与 Issue 明确关联的修复 PR / Commit / Code Change；
3. 修复变更已经进入目标仓库；
4. 时间关系合理；
5. 代码变更与 Issue 问题存在语义关联；
6. Evidence Chain 完整；
7. Verifier 能验证关键事实。

---

## 6.2 PARTIALLY_RESOLVED

例如：

* Issue 中描述多个问题；
* PR 只修复其中一部分；
* 某些环境已经修复，但其他环境仍存在；
* 有 workaround，但没有真正修复。

---

## 6.3 UNRESOLVED

证据显示：

* Issue 仍然开放；
* 相关 PR 未 Merge；
* 修复被关闭/放弃；
* 没有可靠的修复证据；
* 后续讨论仍然表明问题存在。

---

## 6.4 INSUFFICIENT_EVIDENCE

这是非常重要的状态。

不是：

> “没找到，所以没解决。”

而是：

> **目前证据不足以判断是否解决。**

例如：

```text
Issue exists       ✓
Related PR         ?
Code change        ?
Historical evidence ?
```

这种情况下 Agent 必须不能强行输出：

```text
RESOLVED
```

---

# 7. Evidence Model

这是整个业务层最重要的数据结构之一。

所有 Agent 结论都必须尽可能落到 Evidence 上。

---

## 7.1 Evidence 类型

第一阶段：

```text
IssueEvidence
CommentEvidence
TimelineEvidence
PullRequestEvidence
ReviewEvidence
CommitEvidence
CodeEvidence
RelatedIssueEvidence
ReleaseEvidence
DocumentationEvidence
```

---

# 8. Evidence 基础结构

每一个 Evidence 至少包含：

```text
id
type
source
sourceUrl
repository
timestamp
content
metadata
relevance
```

注意：

**Evidence 必须能够追溯到真实 GitHub 对象。**

不能只保存：

```text
"有人说这个问题已经解决"
```

必须保存：

```text
sourceType = issue_comment
sourceId = ...
sourceUrl = ...
author = ...
createdAt = ...
content = ...
```

---

# 9. Evidence Chain

这是最终报告最重要的部分。

例如：

```text
Issue #1234
      ↓
PR #5678
      ↓
Commit abc123
      ↓
src/auth/token.ts
```

对应：

```text
Issue
  │
  │ related_to
  ↓
PR
  │
  │ merged_as
  ↓
Commit
  │
  │ modifies
  ↓
Code
```

最终可以形成：

```text
Evidence Graph
```

---

# 10. Evidence Relation

第一阶段至少支持：

```text
DESCRIBES
RELATED_TO
REFERENCES
FIXES
MERGED_AS
MODIFIES
COMMENTS_ON
DUPLICATES
FOLLOW_UP_TO
```

例如：

```text
Issue #100
   └── FIXED_BY → PR #120
                     └── MERGED_AS → Commit abc
                                           └── MODIFIES → src/foo.ts
```

---

# 11. Agent 的职责

Agent 不负责最终判定任务是否完成。

Agent 的职责：

1. 理解 Investigation Task；
2. 制定调查计划；
3. 调用工具；
4. 收集证据；
5. 形成假设；
6. 验证假设；
7. 输出 Investigation Report。

---

# 12. Agent 必须是 Investigation Agent

不能继续使用当前项目中的：

```text
keyword classifier
write JSON
calculator
simple GitHub search
```

作为主要业务 Agent。

需要升级为真正的：

```text
Investigation Agent
```

---

# 13. Investigation State

Agent 在执行过程中维护：

```text
InvestigationState
```

至少包括：

```text
task
targetRepository
targetIssue
hypotheses
evidence
evidenceRequirements
searchHistory
visitedResources
openQuestions
currentPlan
claims
status
```

---

# 14. Investigation Plan

Agent 不应该一上来就搜索。

首先生成内部计划：

```text
1. Fetch target issue.
2. Inspect issue timeline/comments.
3. Search related PRs.
4. Verify PR status.
5. Inspect merged commits.
6. Inspect changed files.
7. Search historical related issues.
8. Determine resolution status.
9. Build evidence chain.
10. Submit report.
```

计划可以动态调整。

---

# 15. Agent 不允许假设“找到 PR = 找到修复”

这是核心规则。

以下情况不能直接认为 RESOLVED：

```text
Issue → PR found
```

必须继续验证：

```text
PR exists
↓
PR merged?
↓
Commit exists?
↓
Commit belongs to PR?
↓
Code change relevant?
↓
Change addresses issue?
```

---

# 16. GitHub Data Layer

GitHub 不是简单的一个 Tool。

应该抽象成：

```text
GitHubDataProvider
```

---

# 17. GitHub Tool 分类

第一阶段建议：

### Issue

```text
get_issue
list_issue_comments
get_issue_timeline
search_issues
```

### Pull Request

```text
search_pull_requests
get_pull_request
list_pull_request_comments
list_pull_request_reviews
get_pull_request_files
```

### Commit

```text
get_commit
list_commits
compare_commits
```

### Code

```text
search_code
get_file
```

### Repository

```text
get_repository
get_default_branch
get_release
```

---

# 18. Tool Runtime

所有 GitHub API 都必须经过统一 Tool Runtime。

不能让 Agent 直接调用 HTTP。

结构：

```text
Agent
 ↓
ToolRegistry
 ↓
ToolRuntime
 ↓
GitHubDataProvider
 ↓
GitHub API
```

Tool Runtime 负责：

* timeout
* retry
* error normalization
* rate limit detection
* tracing
* request metadata
* response validation

---

# 19. Tool Failure

必须统一错误类型：

```text
TIMEOUT
RATE_LIMIT
AUTH_ERROR
NOT_FOUND
NETWORK_ERROR
SERVER_ERROR
INVALID_ARGUMENT
EMPTY_RESULT
UNKNOWN
```

---

# 20. Retrieval Architecture

Retrieval 不再是：

```text
local corpus
```

而是：

```text
GitHub Investigation Retrieval
```

---

# 21. Retrieval 不应该只有 Embedding

必须采用多策略架构：

```text
Investigation Intent
        ↓
Retrieval Planner
        ↓
┌────────────┬────────────┬──────────────┐
│ Issue      │ Code       │ PR/Commit    │
│ Retrieval  │ Retrieval  │ Retrieval    │
└────────────┴────────────┴──────────────┘
        ↓
Candidate Set
        ↓
Hybrid Ranking
        ↓
Evidence Set
```

---

# 22. Retrieval Strategy

至少支持：

```text
lexical
semantic
hybrid
```

其中：

### lexical

BM25 / GitHub search / exact match。

适合：

* Issue number
* function name
* error message
* exact identifier

### semantic

Embedding retrieval。

适合：

* 同义描述
* 相似 bug
* 不同措辞的问题

### hybrid

默认策略。

---

# 23. 不要伪装 Embedding

如果没有真实 embedding model：

不能写：

```text
Production Embedding Retrieval
```

只能作为：

```text
experimental retrieval strategy
```

正式实现时使用真实 embedding provider。

Provider 应抽象为：

```text
EmbeddingProvider
```

可以后接：

* OpenAI-compatible embedding API
* 本地 embedding model
* 其他 provider

---

# 24. Retrieval Intent

至少识别：

```text
issue_status
related_issue
related_pr
code_change
historical_fix
resolution_evidence
```

不同 Intent 走不同检索路径。

例如：

```text
intent = resolution_evidence
```

优先：

```text
Issue
→ PR
→ Commit
→ Code
```

而：

```text
intent = historical_fix
```

优先：

```text
Related Issues
→ Historical PR
→ Commit
```

---

# 25. Evidence Requirements

这是 Verifier 的核心。

每个 Investigation Task 必须生成：

```text
EvidenceRequirement
```

例如 Issue Resolution：

```text
required:
- issue_identity
- issue_timeline
- resolution_candidate
- resolution_state
- code_or_commit_evidence

optional:
- related_issue
- maintainer_comment
- release_evidence
```

---

# 26. Completion Verifier

Verifier 必须与 Agent 解耦。

不能：

```text
Agent says done
→ Harness accepts
```

必须：

```text
Agent says done
→ Verifier independently checks
```

---

# 27. Verifier 分层

推荐：

```text
Verifier
├── Deterministic Checks
├── Evidence Checks
├── Relationship Checks
└── Semantic Checks
```

---

# 28. Deterministic Checks

尽可能不用 LLM。

例如：

```text
Issue exists?
PR exists?
PR merged?
Commit exists?
Commit belongs to PR?
File exists?
Timestamp valid?
URL valid?
```

这些应该通过 API / 程序直接验证。

---

# 29. Evidence Checks

例如：

```text
Issue evidence exists
PR evidence exists
Commit evidence exists
Code evidence exists
```

---

# 30. Relationship Checks

例如：

```text
PR belongs to repository
PR references Issue
Commit belongs to PR
Commit modifies claimed file
```

---

# 31. Semantic Checks

只有程序无法判断的地方才使用 LLM Judge。

例如：

> “这个 Commit 的代码修改是否真的与 Issue 描述的问题相关？”

LLM Judge 输出：

```text
SUPPORTED
PARTIALLY_SUPPORTED
UNSUPPORTED
UNCERTAIN
```

不能让 Judge 直接决定所有事实。

---

# 32. Claim-Evidence Model

最终报告中的每一个关键 Claim 都应该绑定 Evidence。

例如：

```text
Claim:
"The issue was resolved by PR #5678."

Evidence:
- Issue #1234
- PR #5678
- Commit abc123
```

模型：

```text
Claim
  ↓
Evidence[]
```

Verifier：

```text
Claim
 ↓
Evidence exists?
 ↓
Evidence valid?
 ↓
Evidence supports claim?
```

---

# 33. Unsupported Claim

如果 Agent 输出：

> “这个问题已经解决。”

但是：

```text
evidence = []
```

必须判定：

```text
UNSUPPORTED_CLAIM
```

并且不能完成任务。

---

# 34. Premature Completion

定义：

> Agent 输出 completed，但 Verification 发现 required evidence 不完整或关键 claim 不成立。

状态：

```text
Agent:
COMPLETED

Harness:
FAILED

Failure:
PREMATURE_COMPLETION
```

Recovery：

```text
CONTINUE_INVESTIGATION
```

---

# 35. Failure Taxonomy

第一阶段至少支持：

```text
TOOL_FAILURE
RETRIEVAL_FAILURE
PREMATURE_COMPLETION
LOOP_FAILURE
INSUFFICIENT_EVIDENCE
INVALID_EVIDENCE
WRONG_TARGET
```

---

# 36. Tool Failure

例：

```text
GitHub API timeout
429
500
network failure
```

Recovery：

```text
retry
backoff
alternative endpoint
```

---

# 37. Retrieval Failure

定义：

> Agent 搜索了，但是得到的证据与任务目标不相关或不足。

例如：

```text
query = "timeout"
results = unrelated Issues
```

Recovery：

```text
change query
change retrieval strategy
search exact identifiers
search PR
search code
search history
```

---

# 38. Premature Completion

Recovery：

```text
continue_execution
```

并且向 Agent 暴露：

```text
missing_evidence
failed_checks
open_questions
```

不能简单：

```text
retry same prompt
```

---

# 39. Loop Failure

例如：

```text
search issue
search issue
search issue
search issue
...
```

或者：

```text
same tool + same arguments repeatedly
```

Recovery：

第一阶段默认：

```text
STOP
```

后续可扩展：

```text
change strategy
force new evidence type
```

---

# 40. Insufficient Evidence

这是业务状态，不一定是 Agent Failure。

区别：

```text
INSUFFICIENT_EVIDENCE
```

意味着：

> 环境中目前没有足够证据。

而：

```text
RETRIEVAL_FAILURE
```

意味着：

> Agent 可能没有正确找到已有证据。

Harness 必须区分这两种情况。

---

# 41. Recovery Planner

Recovery Planner 输入：

```text
FailureContext
```

包括：

```text
failureType
failedChecks
trace
retrievalHistory
toolErrors
evidenceCoverage
attemptNumber
```

输出：

```text
RecoveryPlan
```

---

# 42. Recovery Action

第一阶段：

```text
RETRY_TOOL
CHANGE_RETRIEVAL_STRATEGY
CONTINUE_INVESTIGATION
REFINE_QUERY
CHANGE_EVIDENCE_TARGET
STOP
```

未来：

```text
COMPRESS_CONTEXT
REPLAN
SWITCH_MODEL
REQUEST_USER_INPUT
```

---

# 43. Recovery 必须针对失败类型

禁止：

```text
任何失败
 ↓
retry()
```

应该：

```text
TOOL_FAILURE
→ RETRY_TOOL

RETRIEVAL_FAILURE
→ CHANGE_RETRIEVAL_STRATEGY

PREMATURE_COMPLETION
→ CONTINUE_INVESTIGATION

LOOP_FAILURE
→ STOP / REPLAN

INSUFFICIENT_EVIDENCE
→ GATHER_MISSING_EVIDENCE
```

这就是 Failure-Aware 的核心。

---

# 44. Harness State Machine

整个 Harness 应实现为明确状态机：

```text
CREATED
   ↓
RUNNING
   ↓
INVESTIGATING
   ↓
VERIFYING
   ↓
 ┌───────────────┐
 │               │
PASS             FAIL
 │               │
 ↓               ↓
COMPLETED    ANALYZING_FAILURE
                 ↓
             RECOVERING
                 ↓
              RETRYING
                 ↓
             INVESTIGATING
```

终态：

```text
COMPLETED
FAILED
INSUFFICIENT_EVIDENCE
ABORTED
```

---

# 45. Attempt Model

一次 Harness Run 可以包含多个 Attempt。

```text
Run
 ├── Attempt 1
 │    ├── Agent steps
 │    ├── Tools
 │    ├── Evidence
 │    └── Verification
 │
 ├── Recovery
 │
 └── Attempt 2
      ├── Agent steps
      ├── Tools
      ├── Evidence
      └── Verification
```

必须保存每一次 Attempt。

不能覆盖历史。

---

# 46. Trace

Trace 是项目非常重要的工程能力。

每一步至少记录：

```text
timestamp
runId
attemptId
step
eventType
payload
duration
```

事件类型：

```text
run_started
agent_step
model_call
tool_call
tool_result
retrieval_started
retrieval_result
evidence_added
verification_started
verification_result
failure_detected
recovery_planned
recovery_started
run_completed
run_failed
```

---

# 47. Trace 的用途

Trace 不只是 UI 日志。

它必须支持：

1. Debug；
2. Failure Attribution；
3. Benchmark；
4. Recovery；
5. Agent trajectory analysis；
6. 后续研究 Agent behavior。

---

# 48. Investigation Report

最终输出建议：

```text
Investigation Summary

Target:
owner/repo#1234

Status:
RESOLVED

Resolution:
PR #5678 was merged and introduced changes
in src/auth/token.ts.

Evidence:
1. Issue #1234
2. PR #5678
3. Commit abc123
4. src/auth/token.ts

Evidence Chain:
Issue → PR → Commit → Code

Verification:
PASS

Uncertainty:
No direct maintainer confirmation found.
```

---

# 49. 不允许模型伪造引用

所有：

```text
Issue URL
PR URL
Commit SHA
File Path
Line Number
```

都必须经过 Verifier。

例如 Agent 说：

```text
commit = abc123
```

Harness 必须实际调用：

```text
get_commit(abc123)
```

验证存在。

---

# 50. Ground Truth

Benchmark 不能只比较：

```text
Agent Answer
```

必须有 Ground Truth。

Ground Truth 至少包括：

```text
issue
expectedStatus
resolutionPR
resolutionCommit
relevantFiles
requiredEvidence
optionalEvidence
```

---

# 51. Benchmark Task

每一个 Benchmark Case：

```text
InvestigationCase
```

包括：

```text
id
repository
issueNumber
task
groundTruth
difficulty
failureInjection
```

---

# 52. Benchmark 数据来源

第一阶段建议：

选择若干成熟开源项目。

不要自己编 Issue。

真实数据优先。

每个项目挑选：

```text
resolved issues
unresolved issues
issues with PR
issues with abandoned PR
issues with multiple related PRs
issues with partial fixes
issues with ambiguous status
```

---

# 53. Case 类型

至少：

### Case A：明显解决

```text
Issue
→ PR
→ merged
→ commit
```

### Case B：PR 未合并

```text
Issue
→ PR
→ closed
→ not merged
```

### Case C：多个 PR

```text
Issue
→ PR A
→ PR B
→ final merged PR
```

### Case D：部分解决

```text
Issue
→ fix only part of problem
```

### Case E：没有解决

```text
Issue
→ discussion
→ no valid fix
```

### Case F：历史修复

```text
Issue
→ old PR
→ commit
→ release
```

### Case G：容易误判

```text
Issue
→ related PR
→ unrelated code
```

---

# 54. Failure Injection

真实业务数据 + 可控失败注入。

这是 Benchmark 的关键。

---

## Tool Failure Injection

例如：

```text
first GitHub request timeout
```

期望：

```text
Harness detects
→ retry
→ continue
```

---

## Retrieval Failure Injection

例如：

```text
first retrieval strategy returns low relevance results
```

期望：

```text
Verifier
→ retrieval failure
→ switch strategy
→ recover
```

---

## Premature Completion Injection

让 Agent 在证据不足时故意输出：

```text
RESOLVED
```

Harness 应：

```text
reject
→ identify missing evidence
→ continue investigation
```

---

## Loop Injection

Agent：

```text
repeat same search
```

Harness：

```text
detect repeated trajectory
→ stop/replan
```

---

# 55. Benchmark Baselines

必须至少比较三个模式：

## Baseline A：Trust Agent

```text
Agent
 ↓
Answer
 ↓
Done
```

没有独立验证。

---

## Baseline B：Generic Retry

```text
Agent
 ↓
Failure
 ↓
Retry same execution
```

---

## Proposed：Failure-Aware Harness

```text
Agent
 ↓
Verification
 ↓
Failure Attribution
 ↓
Targeted Recovery
 ↓
Verification
```

---

# 56. Metrics

必须测：

## Task Success Rate

最终正确完成任务的比例。

---

## False Completion Rate

Agent 宣布完成，但实际没有满足任务要求的比例。

这是本项目最重要指标之一。

---

## Verification Precision

Verifier 判定 PASS 的任务中，有多少是真正完成。

---

## Recovery Rate

失败任务中最终恢复成功的比例。

---

## Average Attempts

平均执行次数。

---

## Model Calls

模型调用次数。

作为成本 proxy。

如果未来可以获得 token：

增加：

```text
inputTokens
outputTokens
totalTokens
```

---

## Tool Calls

工具调用数量。

---

## Latency

总执行时间。

---

## Evidence Coverage

```text
satisfied required evidence
/
total required evidence
```

---

# 57. 重要实验

核心实验：

```text
Trust Agent
vs
Generic Retry
vs
Failure-Aware Harness
```

每组在相同任务集上运行。

不能只跑一次。

---

# 58. Benchmark 规模

第一阶段：

```text
≥ 30 real investigation cases
```

第二阶段：

```text
≥ 50
```

最终目标：

```text
100+ cases
```

每类 Failure 都应该有多个 Case。

不能再次出现：

```text
4 个 Case
→ 得出系统有效
```

---

# 59. Benchmark 结果必须诚实

例如：

```text
On 50 GitHub issue investigation tasks
with controlled failure injection:
...
```

不能写：

```text
Failure-Aware Harness improves Agent reliability by 75%
```

除非实验真的支持这种统计结论。

---

# 60. GitHub 数据缓存

不能每次 Benchmark 都重新请求 GitHub。

需要：

```text
GitHub API
 ↓
Raw Data Cache
 ↓
Normalized Evidence Store
```

好处：

* 降低 API 请求；
* 避免 rate limit；
* 保证 Benchmark 可重复；
* 保存实验环境；
* 支持离线测试。

---

# 61. 数据版本

每个 Benchmark Dataset 必须有版本：

```text
datasetVersion
snapshotDate
repository
issue
```

因为 GitHub 是动态环境。

今天的 Issue 状态可能和三个月后不同。

---

# 62. Snapshot

建议保存：

```text
Issue snapshot
Comments snapshot
PR snapshot
Commit snapshot
Code snapshot
```

Benchmark 使用 snapshot。

Live Mode 可以实时查询 GitHub。

---

# 63. 两种运行模式

## Live Mode

实时 GitHub。

用途：

```text
Demo
真实用户使用
```

## Benchmark Mode

使用固定 Snapshot。

用途：

```text
Evaluation
Regression Test
Research
```

---

# 64. API 层

建议 API：

```text
POST /api/investigations
GET /api/investigations/:id
GET /api/investigations/:id/trace
GET /api/investigations/:id/evidence
GET /api/investigations/:id/verification
GET /api/investigations/:id/report
```

Benchmark：

```text
POST /api/benchmarks/run
GET /api/benchmarks/:id
GET /api/benchmarks/:id/results
```

---

# 65. UI

UI 不应该继续以“Workspace Agent Console”为核心。

应该改成：

# Investigation Workbench

---

# 66. 页面结构

建议：

```text
Investigation
Benchmark
Evidence
Trace
Retrieval
```

---

# 67. Investigation 页面

顶部：

```text
Repository
Issue
Investigation Status
```

中间：

```text
Investigation Report
```

右侧：

```text
Verification
```

底部：

```text
Evidence Timeline
```

---

# 68. Evidence UI

展示：

```text
Issue #1234
     ↓
PR #5678
     ↓
Commit abc123
     ↓
src/foo.ts
```

点击每个节点可以查看：

* URL
* 时间
* author
* 内容
* 关系

---

# 69. Verification UI

必须明确区分：

```text
Agent Claim
```

和：

```text
Harness Verification
```

例如：

```text
Agent Claim
✓ Issue resolved by PR #5678

Harness Verification
✓ Issue exists
✓ PR exists
✓ PR merged
✓ Commit exists
✓ Code changed
✓ Evidence supports claim

FINAL:
VERIFIED
```

---

# 70. Failure UI

如果失败：

```text
Agent:
Completed

Harness:
Rejected

Failure:
Premature Completion

Missing:
Code Evidence
Historical Evidence

Recovery:
Search related PRs
```

这样用户能直接看到：

> Agent 为什么被 Harness 驳回。

---

# 71. Trace UI

显示：

```text
Attempt 1

10:01 Agent
10:02 search_issue
10:03 search_pr
10:04 Agent → completed
10:04 Verifier → FAIL
10:04 Failure → premature_completion
10:05 Recovery → continue_investigation

Attempt 2

10:06 search_code
10:07 get_commit
10:08 verifier → PASS
```

这会成为项目展示的重要部分。

---

# 72. 当前代码迁移原则

不要推翻现有项目。

保留并升级：

```text
AgentLoop
ToolRegistry
TraceCollector
CompletionVerifier
FailureAnalyzer
RecoveryPlanner
Benchmark
React Workbench
OpenAI-compatible Model
```

需要删除/降级为 Demo 的：

```text
calculator
write_json
local synthetic corpus
premature mock-only business flow
```

它们可以保留作为 Harness 单元测试和 failure injection fixtures。

---

# 73. 当前 Workspace 的定位变化

当前：

```text
Workspace = local file system
```

以后：

```text
InvestigationWorkspace
```

包含：

```text
Task
Evidence
Hypotheses
Claims
SearchHistory
VisitedResources
Snapshots
```

不应该把项目核心继续建立在：

```text
writeFile()
readFile()
```

上。

---

# 74. 核心 Domain Model

建议最终形成这些核心实体：

```text
InvestigationTask
InvestigationRun
InvestigationAttempt
InvestigationState
Evidence
EvidenceRelation
Claim
EvidenceRequirement
InvestigationReport
VerificationResult
FailureEvent
RecoveryPlan
```

---

# 75. Domain Relationship

```text
InvestigationTask
       │
       ↓
InvestigationRun
       │
       ├── Attempt
       │     ├── Trace
       │     ├── Evidence
       │     └── Verification
       │
       ├── Claims
       ├── Evidence Graph
       ├── Failures
       └── Recovery Plans
```

---

# 76. VerificationResult

至少：

```text
status
checks[]
evidenceCoverage
unsupportedClaims[]
missingEvidence[]
verifiedClaims[]
```

---

# 77. Check Model

每一个 check：

```text
checkId
name
type
status
severity
message
evidenceRefs
```

状态：

```text
PASS
FAIL
WARN
UNKNOWN
```

---

# 78. Severity

```text
CRITICAL
REQUIRED
OPTIONAL
INFO
```

例如：

```text
PR merged
→ REQUIRED

Maintainer comment
→ OPTIONAL
```

---

# 79. 完成条件

Investigation 只有在：

```text
all critical checks = PASS
all required evidence = satisfied
all critical claims = supported
```

时才能：

```text
VERIFIED_COMPLETE
```

否则：

```text
NOT_VERIFIED
```

---

# 80. 一个极其重要的原则

不要让：

```text
LLM confidence
```

直接决定：

```text
task success
```

例如：

```text
LLM:
confidence = 0.95
```

不能因此：

```text
PASS
```

真正的完成判断来自：

```text
External Evidence
+
Deterministic Verification
+
Semantic Verification
```

---

# 81. Agent Confidence 的定位

可以保留：

```text
agentConfidence
```

但它只是：

```text
Agent self-report
```

用于 Benchmark 分析：

> Agent 自己认为正确 vs Harness 实际验证正确

甚至可以研究：

```text
confidence calibration
```

---

# 82. “撒谎”在系统里的正式定义

不要在代码里使用：

```text
lying
```

建议统一称：

```text
Unsupported Claim
```

或者：

```text
False Completion
```

因为我们无法判断 Agent 是否有主观欺骗意图。

系统判断的是：

> **Agent 的陈述是否得到外部证据支持。**

---

# 83. 一个完整成功 Case

```text
User:
Investigate issue #1234.
```

### Step 1

Agent：

```text
get_issue(1234)
```

Evidence：

```text
Issue #1234
```

---

### Step 2

Agent：

```text
get_issue_comments(1234)
```

发现：

```text
comment:
"We fixed this in #5678"
```

---

### Step 3

Agent：

```text
get_pull_request(5678)
```

得到：

```text
merged = true
```

---

### Step 4

Agent：

```text
get_pull_request_files(5678)
```

得到：

```text
src/auth/token.ts
```

---

### Step 5

Agent：

```text
get_commit(...)
```

验证 Commit。

---

### Step 6

Agent：

```text
get_file("src/auth/token.ts")
```

---

### Step 7

Agent：

```text
Final Report
```

---

### Step 8

Harness：

```text
Issue exists          PASS
PR exists             PASS
PR merged             PASS
Commit exists         PASS
Code evidence         PASS
Claim supported       PASS
Evidence coverage     PASS
```

---

### Step 9

最终：

```text
VERIFIED_COMPLETE
```

---

# 84. 一个失败 Case

Agent：

```text
Issue #1234 was resolved by PR #5678.
```

Harness：

```text
Issue exists      PASS
PR exists         PASS
PR merged         FAIL
```

于是：

```text
Failure:
UNSUPPORTED_RESOLUTION
```

Recovery：

```text
Search historical PRs
```

找到：

```text
PR #5680
merged = true
```

继续验证。

---

# 85. 一个 Premature Completion Case

Agent：

```text
Issue resolved.
```

但：

```text
required evidence:

Issue       PASS
PR          FAIL
Commit      FAIL
Code        FAIL
```

Harness：

```text
PREMATURE_COMPLETION
```

Recovery：

```text
CONTINUE_INVESTIGATION
```

不是：

```text
retry entire task blindly
```

---

# 86. 一个 Insufficient Evidence Case

Agent 找不到任何相关 PR。

但也没有证据证明问题没有解决。

正确结果：

```text
INSUFFICIENT_EVIDENCE
```

不是：

```text
UNRESOLVED
```

这是项目必须特别强调的事实性边界。

---

# 87. 一个 Retrieval Failure Case

第一次：

```text
query:
"authentication timeout"
```

结果全部不相关。

Verifier：

```text
relevance too low
```

Failure：

```text
RETRIEVAL_FAILURE
```

Recovery：

```text
Search exact issue title
Search issue number
Search related PR
Search code identifiers
```

---

# 88. 一个 Loop Failure Case

Agent：

```text
search_issues("timeout")
search_issues("timeout")
search_issues("timeout")
search_issues("timeout")
```

Harness：

```text
Repeated trajectory detected
```

Recovery：

```text
STOP / REPLAN
```

---

# 89. Agent Loop 改造要求

当前 Agent Loop 是：

```text
Task
→ Model
→ Tool
→ Model
```

升级为：

```text
Task
→ Plan
→ Execute
→ Observe
→ Update Investigation State
→ Decide Next Evidence
→ Execute
```

Agent 必须能知道：

```text
目前已经有什么证据
还缺什么证据
当前假设是什么
下一步需要验证什么
```

---

# 90. Context Management

随着 Issue 调查深入，Context 会越来越大。

必须将：

```text
raw tool output
```

和：

```text
working memory
```

分离。

建议：

```text
Raw Evidence Store
        ↓
Evidence Summaries
        ↓
Agent Context
```

Agent 不应该每一步重新携带所有原始 GitHub 数据。

---

# 91. Evidence Compression

后续实现：

```text
raw evidence
 ↓
normalized evidence
 ↓
summary
 ↓
context
```

但：

**原始 Evidence 必须保存。**

不能只保存 LLM summary。

否则无法重新验证。

---

# 92. Security

GitHub 内容属于外部不可信输入。

Issue / Comment / README 中可能包含：

```text
Ignore previous instructions...
```

Agent 必须把 GitHub 内容视为：

```text
untrusted external content
```

而不是 system instruction。

必须明确：

```text
System / Harness Instructions
>
Agent Task
>
Tool Instructions
>
External GitHub Content
```

---

# 93. Tool Permission

第一阶段所有 GitHub Tool：

```text
READ ONLY
```

禁止：

```text
create issue
comment
close issue
merge PR
push code
```

这是为了避免项目从 Investigation Agent 变成高风险执行 Agent。

---

# 94. Rate Limit

GitHub API rate limit 必须成为真实 Failure 类型。

Tool Runtime 必须能够识别：

```text
429
rate limit headers
retry-after
```

Recovery：

```text
backoff
cache
reduce duplicate calls
```

---

# 95. Caching

同一个：

```text repository + resource + version
```

短时间内不应该重复请求。

例如：

```text get_issue(1234)
```

第一次调用后缓存。

---

# 96. Idempotency

所有 GET 类 Tool 应设计成幂等。

Trace 中记录：

```text cache_hit
cache_miss
```

未来可以研究：

> Harness 是否通过缓存减少 Agent 重复调用。

---

# 97. Failure Attribution 原则

Failure Analyzer 不应该只看最后一步。

必须结合：

```text
Agent trajectory
Tool results
Retrieval results
Verifier failures
Evidence graph
```

例如：

```text
Verifier fail:
missing code evidence
```

不能直接认为：

```text
retrieval failure
```

因为可能是：

```text
Agent 根本没尝试 code search
```

这属于：

```text
premature / planning failure
```

---

# 98. Failure Attribution 优先级

建议：

```text
1. deterministic tool failure
2. invalid target
3. repeated trajectory
4. retrieval quality failure
5. evidence insufficiency
6. unsupported claim
7. premature completion
8. unknown
```

具体实现可以调整，但必须有明确规则。

---

# 99. Recovery 不应该无限循环

每个 Run：

```text
maxAttempts
maxSteps
maxToolCalls
maxLatency
```

都有限制。

例如：

```text
maxAttempts = 3
```

超过：

```text
ABORTED
```

并输出：

```text
reason:
recovery_budget_exhausted
```

---

# 100. Harness Budget

至少：

```text
attempt budget
step budget
tool budget
model budget
time budget
```

后续 Benchmark 可以研究：

> Reliability 与成本之间的 trade-off。

---

# 101. Benchmark Ablation

除了：

```text
Trust
Generic Retry
Failure-Aware
```

还应该做：

### Without Verification

```text
Agent → Done
```

### With Verification

```text
Agent → Verifier
```

### Verification + Generic Retry

### Verification + Failure Attribution

### Full Failure-Aware Recovery

这样可以证明每一层到底有没有贡献。

---

# 102. Retrieval Ablation

比较：

```text
Issue-only
PR-only
BM25
Embedding
Hybrid
```

最终回答：

> 不同 Retrieval Strategy 对 Investigation Success 的影响。

但 Retrieval 不是项目最终研究目标，而是支撑 Harness 的能力。

---

# 103. 重要指标关系

最终 Benchmark 应观察：

```text
Verification
     ↓
False Completion ↓

Failure Attribution
     ↓
Recovery Quality ↑

Recovery
     ↓
Task Success ↑

Targeted Recovery
     ↓
Model Calls ↓
vs
Blind Retry
```

---

# 104. 项目最终展示 Demo

Demo 不应该是：

> 输入 Issue → 等待 → 输出答案。

应该完整展示：

```text
Issue
 ↓
Agent Investigation
 ↓
Evidence Collection
 ↓
Agent prematurely claims completion
 ↓
Verifier rejects
 ↓
Failure Analyzer identifies failure
 ↓
Recovery Planner changes strategy
 ↓
Agent continues
 ↓
Evidence Chain complete
 ↓
Verifier PASS
 ↓
Final Report
```

这才是项目最有价值的 Demo。

---

# 105. 最终 Demo 的核心画面

建议 UI 明确显示：

```text
┌──────────────────────────────────────┐
│ Investigation                        │
│ github.com/xxx/xxx/issues/1234       │
├──────────────────────────────────────┤
│ Agent Status                         │
│ Investigating...                     │
├──────────────────────────────────────┤
│ Evidence                             │
│ ✓ Issue                              │
│ ✓ Comments                           │
│ ✓ Pull Request                       │
│ ✗ Commit                             │
│ ✗ Code                               │
├──────────────────────────────────────┤
│ Verification                         │
│ FAILED                               │
│ Reason: Evidence incomplete          │
├──────────────────────────────────────┤
│ Recovery                             │
│ → Search merged PRs                  │
├──────────────────────────────────────┤
│ Attempt 2                            │
│ ✓ Commit                             │
│ ✓ Code                               │
│ ✓ Claim supported                    │
│                                      │
│ VERIFIED COMPLETE                    │
└──────────────────────────────────────┘
```

---

# 106. 目录结构建议

最终建议演化为：

```text
src/
├── core/
│   ├── harness.ts
│   ├── types.ts
│   ├── state.ts
│   └── budgets.ts
│
├── agent/
│   ├── agent-loop.ts
│   ├── investigation-agent.ts
│   ├── planner.ts
│   ├── context.ts
│   └── model.ts
│
├── github/
│   ├── client.ts
│   ├── issues.ts
│   ├── pull-requests.ts
│   ├── commits.ts
│   ├── code.ts
│   └── repository.ts
│
├── investigation/
│   ├── task.ts
│   ├── state.ts
│   ├── claims.ts
│   ├── evidence.ts
│   ├── graph.ts
│   └── report.ts
│
├── retrieval/
│   ├── planner.ts
│   ├── lexical.ts
│   ├── semantic.ts
│   ├── hybrid.ts
│   └── reranker.ts
│
├── verification/
│   ├── completion-verifier.ts
│   ├── evidence-verifier.ts
│   ├── claim-verifier.ts
│   ├── relationship-verifier.ts
│   └── semantic-judge.ts
│
├── failure/
│   ├── failure-types.ts
│   ├── analyzer.ts
│   └── detectors.ts
│
├── recovery/
│   ├── planner.ts
│   ├── policies.ts
│   └── actions.ts
│
├── trace/
│   ├── collector.ts
│   └── types.ts
│
├── benchmark/
│   ├── cases.ts
│   ├── runner.ts
│   ├── metrics.ts
│   ├── baselines.ts
│   └── dataset.ts
│
└── server/
    ├── app.ts
    ├── routes.ts
    └── service.ts
```

这不是要求机械照搬，而是为了保持：

> Domain / Agent / Harness / GitHub / Evaluation 解耦。

---

# 107. 测试体系

至少：

```text
Unit Tests
Integration Tests
Failure Injection Tests
Benchmark Tests
Regression Tests
```

---

# 108. Unit Test

重点测试：

```text
Verifier
Failure Analyzer
Recovery Planner
Evidence Graph
Resolution State Machine
```

---

# 109. Integration Test

例如：

```text
Issue
→ GitHub adapter
→ Agent
→ Evidence
→ Verifier
→ Report
```

---

# 110. Failure Test

必须覆盖：

```text
timeout
429
missing PR
unmerged PR
wrong PR
missing evidence
premature completion
repeated search
```

---

# 111. Regression Test

每解决一个历史 bug：

```text
新增固定 Case
```

确保以后不会再次出现。

---

# 112. Implementation Phase

不要一次性重写全部系统。

推荐：

## Phase 1 — Domain 重构

先实现：

```text
InvestigationTask
Evidence
Claim
EvidenceRequirement
VerificationResult
InvestigationReport
```

不接真实 Agent。

---

## Phase 2 — GitHub Data Layer

实现：

```text
Issue
Comments
Timeline
PR
Commit
Code
```

统一 API adapter。

---

## Phase 3 — Investigation Agent

让 Agent 真正能够：

```text
plan
search
inspect
reason
collect evidence
```

---

## Phase 4 — Independent Verifier

**DONE。** 第一版是确定性、证据驱动的 Independent Completion Verifier（`src/verification/independent-completion-verifier.ts`）。

```text
Investigation Agent
        |
        | observations / evidence / claims
        v
    Harness State
        |
        v
Independent Completion Verifier
        |
        +--> deterministic checks
        |
        +--> evidence requirements
        |
        +--> claim/evidence consistency
        |
        v
VerificationResult
```

原则：

> Agent conclusion ≠ verification result.
> VerificationResult is produced independently by the Harness.

Agent 可以调查、收集 Evidence、记录 Claim，但不能设置 `verified_complete`。Verifier 不读取 Agent 终答作为真相，也不把 Issue/Comment body 当 Harness 指令。

状态：

* `verified_complete` — 全部 required checks 独立通过
* `not_verified` — 已有足够信息否定完成（例如 PR 存在但 `merged === false`）
* `insufficient_evidence` — 关键证据缺失，无法证明完成

语义检查 / LLM judge 不属于本 Phase。

---

## Phase 5 — Failure-Aware Harness — DONE

把：

```text
Failure Analyzer
Recovery Planner
```

接入完整 Investigation Loop。Failure 先分类再按类型恢复；recovery 有界、追加 Attempt、恢复后重新独立验证。详见 `docs/design.md` / `docs/implementation-status.md`。

---

## Phase 6 — Evidence Graph

**DONE.** Evidence Graph is a first-class domain model (`EvidenceRelation`, `ClaimEvidence`, `EvidenceRequirement`). Investigation ingest writes justified edges from observed GitHub data. `IndependentCompletionVerifier` verifies the graph, not reconstructed payload relationships. Details: `docs/design.md` / `docs/implementation-status.md`.

---

## Phase 7 — Benchmark Dataset

建立第一批：

```text
30 real cases
```

然后扩展到：

```text
50+
```

---

## Phase 8 — Failure Injection

加入：

```text
Tool Failure
Retrieval Failure
Premature Completion
Loop Failure
```

---

## Phase 9 — Benchmark

正式跑：

```text
Trust
Generic Retry
Failure-Aware
```

---

## Phase 10 — UI

最后再把：

```text
Evidence
Verification
Failure
Recovery
Trace
Benchmark
```

全部可视化。

---

# 113. 最终验收标准

项目完成不能以：

```text
npm run build
```

作为唯一标准。

必须同时满足：

### A. 业务闭环

```text
真实 GitHub Issue
→ Investigation
→ Evidence
→ Report
```

可以完整运行。

### B. 独立验证

Agent 可以说：

```text
Done
```

但 Harness 能独立拒绝。

### C. Failure Detection

至少能够检测：

```text
Tool Failure
Retrieval Failure
Premature Completion
Loop Failure
```

### D. Targeted Recovery

不同 Failure 使用不同 Recovery。

### E. Evidence Traceability

最终结论可以追溯到真实 GitHub 数据。

### F. Benchmark

至少：

```text
30 real cases
```

并比较：

```text
Trust
Generic Retry
Failure-Aware
```

### G. Reproducibility

Benchmark 使用 Snapshot，结果可以重复。

---

# 114. 最终项目要回答的五个问题

整个项目最终必须能够回答：

## Q1

Agent 是不是自己说完成就算完成？

**不是。**

---

## Q2

谁判断完成？

**Independent Verifier。**

---

## Q3

Verifier 根据什么判断？

**External Environment State + Evidence + Evidence Relationships + Semantic Validation。**

---

## Q4

发现失败之后怎么办？

**Failure Attribution → Targeted Recovery。**

---

## Q5

怎么证明 Harness 有价值？

**Real GitHub Investigation Benchmark + Baseline Comparison + Failure Injection + Reliability/Cost Metrics。**

---

# 115. 最终项目的技术主线

最终 README / 面试时应该围绕：

```text
Real Software Engineering Task
          ↓
Agent Investigation
          ↓
External Evidence
          ↓
Independent Verification
          ↓
Failure Attribution
          ↓
Targeted Recovery
          ↓
Re-execution
          ↓
Verified Completion
```

而不是围绕：

```text
React
Node
GitHub API
RAG
Embedding
```

这些只是实现手段。

---

# 116. 项目的真正创新点

不要声称：

> “我发明了 Agent Harness。”

也不要声称：

> “GitHub Issue Agent 很新。”

真正应该强调的是工程设计：

### 1. Completion is not self-reported

Agent 的 completion 是一个待验证的 claim。

### 2. Evidence is first-class

结论必须关联外部证据。

### 3. Verification is independent

Verifier 与 Agent 决策链解耦。

### 4. Failure is typed

不同失败有不同语义。

### 5. Recovery is failure-aware

不是所有失败都 Retry。

### 6. Evaluation is environment-grounded

使用真实 GitHub 数据进行 Benchmark。

---

# 117. 最终系统抽象

整个项目最终应该稳定在：

```text
                    USER TASK
                       │
                       ↓
              Investigation Task
                       │
                       ↓
           ┌──────────────────────┐
           │ Failure-Aware        │
           │ Agent Harness        │
           │                      │
           │ ┌──────────────────┐ │
           │ │ Investigation    │ │
           │ │ Agent            │ │
           │ └────────┬─────────┘ │
           │          ↓           │
           │     Tool Runtime     │
           │          ↓           │
           │     Retrieval        │
           │          ↓           │
           │      Evidence        │
           │          ↓           │
           │     Verification     │
           │          ↓           │
           │   Failure Attribution│
           │          ↓           │
           │    Recovery Planner  │
           │          ↓           │
           │      Re-execute      │
           └──────────┬───────────┘
                      │
                      ↓
               GitHub Environment
                      │
          ┌───────────┼───────────┐
          ↓           ↓           ↓
       Issues         PRs       Commits
          ↓           ↓           ↓
       Comments      Code       History
```

---

# 118. 最终一句话定义

本项目不是：

> **“一个能够帮用户查看 GitHub Issue 的 AI Agent。”**

而是：

> **“一个运行在真实 GitHub 软件工程环境中的 Failure-Aware Agent Harness：Agent 负责调查，GitHub 提供外部事实，Verifier 独立验证 Agent 的结论，Failure Analyzer 定位执行失败，Recovery Planner 针对失败类型恢复执行，并通过真实 Investigation Benchmark 评估 Harness 对 Agent Reliability 的提升。”**

---

# 119. 交给 Coding Agent 时的最高优先级原则

实现过程中，如果某个设计选择与以下原则冲突，优先保证以下原则：

```text
Priority 1:
Agent cannot self-certify completion.

Priority 2:
Important claims must have traceable evidence.

Priority 3:
Verifier must be independent from Agent reasoning.

Priority 4:
Failure classification must influence recovery strategy.

Priority 5:
Real GitHub data must be used for business evaluation.

Priority 6:
Benchmark must be reproducible.

Priority 7:
Do not add framework complexity unless it improves the above goals.
```

不要为了“看起来像一个大型 Agent 项目”而无意义增加：

```text
Multi-Agent
Memory
Vector Database
MCP
Knowledge Graph
Workflow Engine
```

如果这些组件不能直接服务于：

> **Investigation → Verification → Failure → Recovery → Evaluation**

就暂时不要加入。

---

# 120. 项目最终形成的闭环

```text
                ┌──────────────────────┐
                │      GitHub          │
                │  Real World Data     │
                └──────────┬───────────┘
                           │
                           ↓
                      Investigation
                           │
                           ↓
                         Agent
                           │
                           ↓
                      Evidence
                           │
                           ↓
                    Agent Conclusion
                           │
                           ↓
                 Independent Verifier
                           │
              ┌────────────┴────────────┐
              ↓                         ↓
             PASS                      FAIL
              │                         │
              ↓                         ↓
          Completed              Failure Analyzer
                                        │
                                        ↓
                                Recovery Planner
                                        │
                                        ↓
                                   Re-execute
                                        │
                                        ↓
                                   Verify Again
                                        │
                         ┌──────────────┴──────────────┐
                         ↓                             ↓
                       PASS                          FAIL
                         ↓                             ↓
                    Completed                    Next Recovery
                                                    │
                                                    ↓
                                               Budget Limit
                                                    │
                                                    ↓
                                                  Failed
```

**这就是整个项目的最终闭环。**

不是“Agent 能不能回答”。

而是：

> **Agent 做了什么 → 它声称做完了什么 → 外部世界实际上发生了什么 → 两者是否一致 → 如果不一致为什么 → 怎么恢复 → 恢复之后是否真的完成。**

这才是本项目应该真正体现的 Agent Engineering 能力。
