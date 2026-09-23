import type { InvestigationRequest, InvestigationStreamEvent, LiveEventPhase } from "../api/dto.js";
import { HARNESS_STRUCTURED_SOURCE } from "../investigation/resolution-prescan.js";
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

function recordField(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ");
}

function checkLabel(id: string, name?: string): string {
  return CHECK_LABELS[id] ?? (name ? CHECK_LABELS[name] : undefined) ?? id.replaceAll("-", " ");
}

/** Pure resource identifiers (numbers / short shas) already public in evidence data. */
function resourceIdentifier(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  if (typeof args.pullNumber === "number") {
    return ` · PR #${args.pullNumber}`;
  }
  if (typeof args.issueNumber === "number") {
    return ` · Issue #${args.issueNumber}`;
  }
  if (typeof args.sha === "string" && args.sha.length > 0) {
    return ` · Commit ${args.sha.slice(0, 7)}`;
  }
  return "";
}

function evidenceResourceLabel(resource: string | undefined): string | undefined {
  if (!resource) {
    return undefined;
  }
  const direct: Record<string, (n: string) => string> = {
    issue: (n) => `Issue #${n} 正文`,
    comments: (n) => `Issue #${n} 评论`,
    timeline: (n) => `Issue #${n} Timeline`,
    pull: (n) => `PR #${n} 详情`,
  };
  const issueMatch = /^issues\/(\d+)(#(comments|timeline))?$/.exec(resource);
  if (issueMatch) {
    const sub = issueMatch[3] ?? "issue";
    return direct[sub]?.(issueMatch[1]);
  }
  const pullMatch = /^pull\/(\d+)(\/(reviews|files)(\/.*)?)?$/.exec(resource);
  if (pullMatch) {
    if (pullMatch[3] === "reviews") {
      return `PR #${pullMatch[1]} 评审`;
    }
    if (pullMatch[3] === "files") {
      return `PR #${pullMatch[1]} 文件清单`;
    }
    return `PR #${pullMatch[1]} 详情`;
  }
  if (resource === "commits") {
    return "Commit 列表";
  }
  const commitMatch = /^commit\/([0-9a-f]+)$/i.exec(resource);
  if (commitMatch) {
    return `Commit ${commitMatch[1].slice(0, 7)}`;
  }
  return undefined;
}

function prescanNumber(n: number): string {
  return `#${n}`;
}

interface PrescanCandidateView {
  pullNumber: number;
  structuredClosingReference: number | boolean | null;
  detailState: string;
}

function prescanCandidateViews(data: Record<string, unknown>): PrescanCandidateView[] {
  const raw = Array.isArray(data.candidates) ? data.candidates : [];
  const views: PrescanCandidateView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.pullNumber !== "number") {
      continue;
    }
    views.push({
      pullNumber: record.pullNumber,
      structuredClosingReference:
        record.structuredClosingReference === true || record.structuredClosingReference === false
          ? record.structuredClosingReference
          : null,
      detailState: typeof record.detailState === "string" ? record.detailState : "skipped",
    });
  }
  return views;
}

/**
 * Phase 19-B: fixed-template aggregate lines for the prescan phase, assembled
 * purely from record fields (counts, detailState, structured flags). Zero model
 * involvement; mirrors the conclusion-template rules on the result page.
 */
function projectPrescan(event: TraceEvent): InvestigationStreamEvent {
  const data = event.data;
  const state: "completed" | "incomplete" =
    event.type === "resolution_prescan_completed" ? "completed" : "incomplete";
  const candidates = prescanCandidateViews(data);
  if (candidates.length === 0 && state === "incomplete" && typeof data.reason === "string") {
    return {
      type: "prescan_completed",
      step: event.step,
      phase: "prescan",
      state,
      summary: "预扫描未完成",
      lines: ["机器预扫描未完成，本次结论不依赖机器预扫描。"],
    };
  }
  const enumerated = typeof data.candidatesEnumerated === "number" ? data.candidatesEnumerated : candidates.length;
  const truncated = data.candidatesTruncated === true;
  const completed = candidates.filter((c) => c.detailState === "completed").length;
  const notPr = candidates.filter((c) => c.detailState === "not_a_pull_request").length;
  const failed = candidates.filter((c) => c.detailState === "failed").length;
  const skipped = candidates.filter((c) => c.detailState === "skipped").length;
  const closingHits = candidates.filter((c) => c.structuredClosingReference === true);
  const adjudicated = completed + notPr;
  let seconds: string | undefined;
  const startedAt = stringField(data, "startedAt");
  const completedAt = stringField(data, "completedAt");
  if (startedAt && completedAt) {
    const ms = Date.parse(completedAt) - Date.parse(startedAt);
    if (Number.isFinite(ms) && ms >= 0) {
      seconds = `${(ms / 1000).toFixed(1)}s`;
    }
  }
  const allChecked = enumerated === candidates.length && failed === 0 && skipped === 0;
  const summary = [
    "0 次 AI 调用",
    candidates.length === 0 && enumerated === 0
      ? "未找到相关 PR"
      : `找到 ${enumerated} 个相关 PR`,
    allChecked ? "全部核对" : `已核对 ${adjudicated} / ${candidates.length} 个`,
    seconds,
  ]
    .filter(Boolean)
    .join(" · ");
  const numbers = candidates.map((c) => prescanNumber(c.pullNumber)).join("、");
  const lines = [
    candidates.length === 0
      ? "读取 Issue 正文与评论，提取被引用的编号 → 未找到相关 PR"
      : `读取 Issue 正文与评论，提取被引用的编号 → 找到相关 PR ${numbers}${truncated ? "（已达数量上限，多余编号被截断）" : ""}`,
    `查 GitHub 官方修复标记 → ${closingHits.length} / ${candidates.length} 个 PR 命中${
      closingHits.length > 0 ? `（${closingHits.map((c) => prescanNumber(c.pullNumber)).join("、")}）` : ""
    }`,
  ];
  if (candidates.length > 0) {
    const list = (items: PrescanCandidateView[]) =>
      items.length > 0 ? `（${items.map((c) => prescanNumber(c.pullNumber)).join("、")}）` : "";
    lines.push(
      `拉取 PR 详情 ×${completed}${list(
        candidates.filter((c) => c.detailState === "completed"),
      )} · 确认非 PR ×${notPr}${list(candidates.filter((c) => c.detailState === "not_a_pull_request"))} · 读取失败 ×${failed}${
        skipped > 0 ? ` · 因上限未读取 ×${skipped}` : ""
      }`,
    );
  }
  const hintCount = typeof data.unlinkedHintCount === "number" ? data.unlinkedHintCount : 0;
  const scanState = stringField(data, "unlinkedScanState");
  if (hintCount > 0) {
    lines.push(`扫描这些 PR 改动文件的主干提交 → ${hintCount} 条未关联修复线索（提示性质，不改变结论）`);
  } else if (scanState === "failed") {
    lines.push("扫描主干提交 → 未完成（不影响结论）");
  } else if (scanState === "skipped") {
    lines.push("扫描主干提交 → 未执行");
  }
  return {
    type: "prescan_completed",
    step: event.step,
    phase: "prescan",
    state,
    summary,
    lines,
  };
}

/**
 * Per-connection projector: turns internal TraceEvents into minimal public events.
 * Only harness-authored labels cross the boundary; tool arguments, model payloads,
 * evidence payloads and agent reasons never leave the runtime trace. Phase 19-B:
 * each process event also carries its server-side phase group, and summaries gain
 * resource identifiers extracted from already-public numbers (PR/Issue/sha).
 */
export function createInvestigationStreamProjector(): (event: TraceEvent) => InvestigationStreamEvent | null {
  let lastTool = "";
  let lastToolPhase: LiveEventPhase = "agent";
  return (event) => {
    const step = event.step;
    switch (event.type) {
      case "investigation_started": {
        const budget = recordField(event.data, "runtimeBudget");
        const maxLlmCalls =
          typeof budget?.maxLlmCalls === "number" ? budget.maxLlmCalls : undefined;
        return {
          type: "investigation_started",
          step,
          timestamp: event.timestamp,
          ...(maxLlmCalls !== undefined ? { maxLlmCalls } : {}),
        };
      }
      case "resolution_prescan_completed":
      case "resolution_prescan_incomplete":
        return projectPrescan(event);
      case "agent_step": {
        const tool = stringField(event.data, "tool");
        return {
          type: "agent_step",
          step,
          phase: "agent",
          summary: tool ? `计划下一步：${toolLabel(tool)}` : "规划下一步调查",
        };
      }
      case "tool_call": {
        const tool = stringField(event.data, "tool") ?? "";
        lastTool = tool;
        lastToolPhase = "agent";
        return {
          type: "tool_call",
          step,
          phase: "agent",
          tool,
          summary: `正在${toolLabel(tool)}${resourceIdentifier(recordField(event.data, "arguments"))}…`,
        };
      }
      case "tool_result": {
        const success = event.data.success !== false;
        let summary = success ? "工具调用完成" : "工具调用未成功";
        if (success) {
          const output = event.data.output;
          const value =
            output && typeof output === "object" && "value" in output
              ? (output as { value: unknown }).value
              : output;
          if (Array.isArray(value)) {
            summary = `${value.length} 项结果`;
          }
        }
        return {
          type: "tool_result",
          step,
          phase: lastToolPhase,
          tool: lastTool,
          success,
          summary,
        };
      }
      case "evidence_added": {
        const kind = stringField(event.data, "kind") ?? "other";
        const provenance = recordField(event.data, "provenance");
        const source = provenance ? stringField(provenance, "source") : undefined;
        const phase: LiveEventPhase = source === HARNESS_STRUCTURED_SOURCE ? "prescan" : "agent";
        const contentRef = stringField(event.data, "contentRef");
        const mergeRef = contentRef ? /^pr-merge:(\d+)$/.exec(contentRef) : null;
        const label = mergeRef
          ? `PR #${mergeRef[1]} 合并状态`
          : evidenceResourceLabel(provenance ? stringField(provenance, "resource") : undefined);
        return {
          type: "evidence_added",
          step,
          phase,
          summary: `获得${label ?? KIND_LABELS[kind] ?? kind}证据`,
        };
      }
      case "verification_started":
        return { type: "verification_started", step, phase: "verification", summary: "开始独立验证" };
      case "verification_check": {
        const id = stringField(event.data, "id") ?? "";
        const status = stringField(event.data, "status") ?? "unknown";
        return {
          type: "verification_check",
          step,
          phase: "verification",
          summary: `检查 ${checkLabel(id, stringField(event.data, "name"))}：${status}`,
          status,
        };
      }
      case "verification_completed": {
        const status = stringField(event.data, "status") ?? "";
        return {
          type: "verification_completed",
          step,
          phase: "verification",
          status,
          summary: `独立验证完成：${status}`,
        };
      }
      case "failure_analyzed": {
        const type = stringField(event.data, "primary") ?? "unknown";
        return {
          type: "failure",
          step,
          phase: "agent",
          summary: FAILURE_LABELS[type] ?? type.replaceAll("_", " "),
        };
      }
      case "recovery_planned": {
        const action = stringField(event.data, "action") ?? "";
        return {
          type: "recovery",
          step,
          phase: "agent",
          summary: RECOVERY_LABELS[action] ?? action.replaceAll("_", " "),
        };
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
