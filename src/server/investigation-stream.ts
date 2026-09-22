import type { InvestigationRequest, InvestigationStreamEvent } from "../api/dto.js";
import { TraceCollector, type TraceEvent } from "../trace/trace-collector.js";
import type { RunInvestigationOptions } from "./investigation-service.js";
import { runInvestigation } from "./investigation-service.js";
import { toInvestigationHttpError } from "./investigation-errors.js";

const TOOL_LABELS: Record<string, string> = {
  github_get_issue: "获取 Issue",
  github_get_issue_timeline: "查看 Issue Timeline",
  github_get_issue_comments: "查看 Issue Comments",
  github_get_pull_request: "获取 Pull Request",
  github_get_pull_request_files: "查看 PR 文件变更",
  github_get_pull_request_reviews: "查看 PR 评审",
  github_list_commits: "查询 Commit",
  github_get_commit: "获取 Commit 信息",
  github_get_patch: "获取补丁内容",
  record_claim: "记录调查结论",
};

const CHECK_LABELS: Record<string, string> = {
  "issue-identity": "Issue 身份",
  "issue-state": "Issue 状态",
  "closure-semantics": "关闭语义",
  "resolution-candidate": "解决候选",
  "pr-merged": "已合并 Pull Request",
  "code-commit": "代码 / Commit 证据",
  "resolution-effect": "解决效果",
  "claims-supported": "关键 Claim",
  "evidence-requirements": "证据要求",
};

const KIND_LABELS: Record<string, string> = {
  issue: "Issue",
  comment: "Issue 评论",
  timeline: "Issue Timeline",
  pull_request: "Pull Request",
  review: "PR 评审",
  file: "File",
  commit: "Commit",
  code: "代码变更",
  release: "Release",
  doc: "文档",
  other: "其他",
};

const FAILURE_LABELS: Record<string, string> = {
  tool_failure: "工具调用失败",
  retrieval_failure: "信息检索失败",
  insufficient_evidence: "证据不足",
  premature_completion: "Agent 提前结束",
  loop_failure: "调查陷入循环",
  invalid_evidence: "证据无效",
  wrong_target: "调查目标错误",
  runtime_budget_exceeded: "运行预算耗尽",
  evidence_gap: "证据缺口",
  unknown: "未知失败",
};

const RECOVERY_LABELS: Record<string, string> = {
  retry_with_backoff: "稍后重试失败的工具调用",
  refine_query: "调整检索范围",
  change_retrieval_strategy: "更换检索策略",
  continue_investigation: "继续调查，补齐尚未确认的证据",
  stop: "停止当前调查",
  replan: "重新规划调查路径",
  gather_missing_evidence: "只补齐缺失证据",
  revalidate_evidence: "重新核验证据",
  recheck_target: "重新确认调查目标",
};

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === "string" ? (data[key] as string) : undefined;
}

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ");
}

function checkLabel(id: string, name?: string): string {
  return CHECK_LABELS[id] ?? (name ? CHECK_LABELS[name] : undefined) ?? id.replaceAll("-", " ");
}

/**
 * Per-connection projector: turns internal TraceEvents into minimal public events.
 * Only harness-authored labels cross the boundary; tool arguments, model payloads,
 * evidence payloads and agent reasons never leave the runtime trace.
 */
export function createInvestigationStreamProjector(): (event: TraceEvent) => InvestigationStreamEvent | null {
  let lastTool = "";
  return (event) => {
    const step = event.step;
    switch (event.type) {
      case "investigation_started":
        return { type: "investigation_started", step, timestamp: event.timestamp };
      case "agent_step": {
        const tool = stringField(event.data, "tool");
        return {
          type: "agent_step",
          step,
          summary: tool ? `计划下一步：${toolLabel(tool)}` : "规划下一步调查",
        };
      }
      case "tool_call": {
        const tool = stringField(event.data, "tool") ?? "";
        lastTool = tool;
        return { type: "tool_call", step, tool, summary: `正在${toolLabel(tool)}…` };
      }
      case "tool_result": {
        const success = event.data.success !== false;
        return {
          type: "tool_result",
          step,
          tool: lastTool,
          success,
          summary: success ? "工具调用完成" : "工具调用未成功",
        };
      }
      case "evidence_added": {
        const kind = stringField(event.data, "kind") ?? "other";
        return { type: "evidence_added", step, summary: `获得${KIND_LABELS[kind] ?? kind}证据` };
      }
      case "verification_started":
        return { type: "verification_started", step, summary: "开始独立验证" };
      case "verification_check": {
        const id = stringField(event.data, "id") ?? "";
        const status = stringField(event.data, "status") ?? "unknown";
        return {
          type: "verification_check",
          step,
          summary: `检查 ${checkLabel(id, stringField(event.data, "name"))}：${status}`,
          status,
        };
      }
      case "verification_completed": {
        const status = stringField(event.data, "status") ?? "";
        return {
          type: "verification_completed",
          step,
          status,
          summary: `独立验证完成：${status}`,
        };
      }
      case "failure_analyzed": {
        const type = stringField(event.data, "primary") ?? "unknown";
        return { type: "failure", step, summary: FAILURE_LABELS[type] ?? type.replaceAll("_", " ") };
      }
      case "recovery_planned": {
        const action = stringField(event.data, "action") ?? "";
        return { type: "recovery", step, summary: RECOVERY_LABELS[action] ?? action.replaceAll("_", " ") };
      }
      case "investigation_completed": {
        const status = stringField(event.data, "status") ?? "";
        return {
          type: "investigation_completed",
          step,
          status,
          summary: `调查流程结束：${status}`,
        };
      }
      default:
        return null;
    }
  };
}

/**
 * Runs the existing investigation with its own TraceCollector so the SSE listener
 * observes the same runtime trace. The final session DTO is only ever emitted as
 * the `done` event after runInvestigation resolves; errors emit `error` and never
 * a fabricated completion.
 */
export async function streamInvestigation(
  input: InvestigationRequest,
  emit: (event: InvestigationStreamEvent) => void | Promise<void>,
  options: RunInvestigationOptions = {},
): Promise<void> {
  const trace = new TraceCollector();
  const project = createInvestigationStreamProjector();
  const unsubscribe = trace.on((event) => {
    const publicEvent = project(event);
    if (publicEvent) {
      void emit(publicEvent);
    }
  });
  try {
    const session = await runInvestigation(input, { ...options, trace });
    await emit({ type: "done", session });
  } catch (error) {
    const mapped = toInvestigationHttpError(error);
    await emit({ type: "error", message: mapped.body.error.message });
  } finally {
    unsubscribe();
  }
}
