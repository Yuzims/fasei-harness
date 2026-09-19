import type {
  InvestigationAttemptDTO,
  InvestigationCatalogItemDTO,
  InvestigationCheckDTO,
  InvestigationEvidenceDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
  InvestigationStepDTO,
} from "@dto";

export type VerificationTone = "verified" | "not_verified" | "insufficient" | "neutral";
export type CheckTone = "pass" | "fail" | "warn" | "unknown";
export type RunPhase = "idle" | "running" | "completed" | "failed";

export interface TraceItem {
  id: string;
  label: string;
  detail?: string;
  tone?: CheckTone;
}

export interface InvestigationStepView {
  id: string;
  label: string;
  success: boolean;
  detail?: string;
}

export const FEATURED_EXAMPLE_COUNT = 3;

const REPO_DISPLAY_NAMES: Record<string, string> = {
  vscode: "VS Code",
  cli: "CLI",
  mcp: "MCP",
};

const TOOL_LABELS: Record<string, string> = {
  github_get_issue: "获取 Issue",
  get_issue: "获取 Issue",
  github_get_issue_timeline: "查看 Issue Timeline",
  get_issue_timeline: "查看 Issue Timeline",
  github_get_issue_comments: "查看 Issue Comments",
  get_issue_comments: "查看 Issue Comments",
  github_get_pull_request: "获取 Pull Request",
  get_pull_request: "获取 Pull Request",
  github_get_pull_request_files: "查看 PR 文件变更",
  get_pull_request_files: "查看 PR 文件变更",
  github_get_pull_request_reviews: "查看 PR 评审",
  get_pull_request_reviews: "查看 PR 评审",
  github_list_commits: "查询 Commit",
  list_commits: "查询 Commit",
  record_claim: "记录调查结论",
};

const CHECK_LABELS: Record<string, string> = {
  "issue-identity": "Issue 身份",
  "issue identity": "Issue 身份",
  "issue-state": "Issue 状态",
  "issue closed": "Issue 状态",
  "closure-semantics": "关闭语义",
  "eligible closure": "关闭语义",
  "resolution-candidate": "解决候选",
  "resolution candidate": "解决候选",
  "pr-merged": "PR 已合并",
  "resolution landed": "PR 已合并",
  "code-commit": "代码变更",
  "resolution code evidence": "代码变更",
  "resolution-effect": "解决效果",
  "resolution effect alignment": "解决效果",
  "claims-supported": "关键 Claim",
  "claim support": "关键 Claim",
  "evidence-requirements": "证据要求",
  "evidence requirements": "证据要求",
};

const REQUIREMENT_LABELS: Record<string, string> = {
  "req-issue": "目标 Issue",
  "req-pr": "已合并的 Pull Request",
  "req-commit": "代码 / Commit 证据",
  "issue-identity": "Issue 身份",
  "issue-state": "Issue 状态",
  "closure-semantics": "关闭语义",
  "resolution-candidate": "解决候选",
  "pr-merged": "已合并的 Pull Request",
  "code-commit": "代码 / Commit 证据",
  "resolution-effect": "解决效果对齐",
  "claims-supported": "关键 Claim",
  "evidence-requirements": "证据要求",
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
  unknown: "未知失败",
};

const RECOVERY_LABELS: Record<string, string> = {
  retry_with_backoff: "稍后重试失败的工具调用",
  refine_query: "调整检索范围",
  change_retrieval_strategy: "更换检索策略，避免重复同一查询",
  continue_investigation: "继续调查，补齐尚未确认的证据",
  stop: "停止当前调查，避免盲目重试",
  replan: "重新规划调查路径",
  gather_missing_evidence: "只补齐缺失证据，不重跑整次调查",
  revalidate_evidence: "重新核验证据，丢弃无效内容",
  recheck_target: "重新确认调查目标",
};

const KIND_LABELS: Record<string, string> = {
  issue: "GitHub Issue",
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

const TRUST_LABELS: Record<string, string> = {
  external_untrusted: "外部来源 · 未可信任内容",
  harness_derived: "Harness 派生",
};

const SOURCE_LABELS: Record<string, string> = {
  github: "GitHub",
  snapshot: "快照",
  fixture: "夹具",
};

const POLARITY_LABELS: Record<string, string> = {
  resolved: "已解决",
  unresolved: "未解决",
  partial: "部分解决",
  unknown: "尚不确定",
};

const METRIC_LABELS: Record<string, string> = {
  taskSuccessRate: "任务成功率",
  evidenceCoverage: "证据覆盖率",
  falseCompletionRate: "误报完成率",
  recoveryRate: "恢复成功率",
  averageAttempts: "平均尝试次数",
  averageToolCalls: "平均工具调用",
  averageModelCalls: "平均模型调用",
  avgAttempts: "平均尝试次数",
  avgToolCalls: "平均工具调用",
  avgModelCalls: "平均模型调用",
  avgLatencyMs: "平均耗时",
  successRate: "成功率",
};

const PRIMARY_CHECK_IDS = new Set([
  "issue-identity",
  "issue-state",
  "closure-semantics",
  "resolution-candidate",
  "pr-merged",
  "code-commit",
  "resolution-effect",
  "claims-supported",
]);

export function issueRef(task: { owner: string; repository: string; issueNumber: number }): string {
  return `${task.owner}/${task.repository}#${task.issueNumber}`;
}

export function repositoryDisplayName(repository: string): string {
  return repository
    .split(/[-_]/g)
    .filter(Boolean)
    .map((token) => {
      const known = REPO_DISPLAY_NAMES[token.toLowerCase()];
      if (known) {
        return known;
      }
      if (/[A-Z]/.test(token.slice(1))) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

export function exampleHeading(item: { repository: string; issueNumber: number }): string {
  return `${repositoryDisplayName(item.repository)} #${item.issueNumber}`;
}

export function featuredExamples<T>(items: T[], count = FEATURED_EXAMPLE_COUNT): T[] {
  return items.slice(0, count);
}

export function catalogRunRequest(item: InvestigationCatalogItemDTO): InvestigationRequest {
  if (item.group === "real-v1") {
    return { caseId: item.id, mode: "snapshot" };
  }
  return { scenarioId: item.id, mode: "snapshot" };
}

export function investigationMode(session?: { mode?: string; dataSource?: string }): "live" | "snapshot" {
  const value = session?.mode ?? session?.dataSource;
  return value === "snapshot" ? "snapshot" : "live";
}

export function investigationModeLabel(mode: "live" | "snapshot"): string {
  return mode === "live" ? "实时调查" : "快照调查";
}

export function investigationModeDetail(mode: "live" | "snapshot"): string {
  return mode === "live"
    ? "数据来自 GitHub 公开接口。"
    : "使用已录制的 GitHub 数据，结果可复现。";
}

export function verificationLabel(status?: string): string {
  if (status === "verified_complete") {
    return "已验证完成";
  }
  if (status === "not_verified") {
    return "未验证完成";
  }
  if (status === "insufficient_evidence") {
    return "证据不足";
  }
  return status ? status.replaceAll("_", " ") : "尚未验证";
}

export function verificationTone(status?: string): VerificationTone {
  if (status === "verified_complete") {
    return "verified";
  }
  if (status === "not_verified") {
    return "not_verified";
  }
  if (status === "insufficient_evidence") {
    return "insufficient";
  }
  return "neutral";
}

export function verificationSubtitle(status?: string): string {
  if (status === "verified_complete") {
    return "目前已有足够证据确认该 Issue 的解决链路。";
  }
  if (status === "not_verified") {
    return "现有证据无法确认该 Issue 已经解决。";
  }
  if (status === "insufficient_evidence") {
    return "目前证据不足，无法确认该 Issue 是否已经解决。";
  }
  return "Harness 尚未给出独立验证结果。";
}

export function checkTone(status?: string): CheckTone {
  if (status === "pass") {
    return "pass";
  }
  if (status === "fail") {
    return "fail";
  }
  if (status === "warn") {
    return "warn";
  }
  return "unknown";
}

export function checkMark(status?: string): string {
  const tone = checkTone(status);
  if (tone === "pass") {
    return "✓";
  }
  if (tone === "fail") {
    return "✗";
  }
  if (tone === "warn") {
    return "!";
  }
  return "·";
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function uniqueEvidenceKinds(items: InvestigationEvidenceDTO[]): string[] {
  return [...new Set(items.map((item) => item.kind))];
}

export function filterEvidence(
  items: InvestigationEvidenceDTO[],
  kind: string,
): InvestigationEvidenceDTO[] {
  if (kind === "all") {
    return items;
  }
  return items.filter((item) => item.kind === kind);
}

export function evidenceIdentifier(item: InvestigationEvidenceDTO): string {
  return item.resource || item.url || item.id;
}

export function isNotFoundError(error: { status?: number; message?: string; code?: string }): boolean {
  if (error.code === "GITHUB_NOT_FOUND" || error.code === "SNAPSHOT_NOT_FOUND") {
    return true;
  }
  if (error.status === 404) {
    return true;
  }
  return /recorded snapshot|未知|not found/i.test(error.message ?? "");
}

export function investigationErrorTitle(error: { status?: number; message?: string; code?: string }): string {
  if (error.code === "GITHUB_RATE_LIMITED" || error.code === "rate_limited") {
    return "GitHub 接口已达到速率限制。";
  }
  if (error.code === "GITHUB_NOT_FOUND") {
    return "未找到该 Issue";
  }
  if (error.code === "INVALID_GITHUB_ISSUE_INPUT") {
    return "无法调查这个 Issue。";
  }
  if (isNotFoundError(error)) {
    return error.code === "GITHUB_NOT_FOUND" ? "未找到该 Issue" : "未找到这次调查";
  }
  return "无法调查这个 Issue。";
}

export function satisfiedCount(session: InvestigationSessionDTO): { passed: number; total: number } {
  const checks = session.verification?.checks ?? [];
  return {
    passed: checks.filter((item) => item.status === "pass").length,
    total: checks.length,
  };
}

export function toolStepLabel(tool: string): string {
  if (TOOL_LABELS[tool]) {
    return TOOL_LABELS[tool];
  }
  const normalized = tool.startsWith("github_") ? tool : `github_${tool}`;
  return TOOL_LABELS[normalized] ?? tool.replaceAll("_", " ");
}

export function checkLabel(check: Pick<InvestigationCheckDTO, "id" | "name">): string {
  return CHECK_LABELS[check.id] ?? CHECK_LABELS[check.name] ?? check.name;
}

export function requirementLabel(id: string): string {
  return REQUIREMENT_LABELS[id] ?? id.replace(/^req-/, "").replaceAll("_", " ").replaceAll("-", " ");
}

export function failureTypeLabel(type?: string): string {
  if (!type) {
    return "调查失败";
  }
  return FAILURE_LABELS[type] ?? type.replaceAll("_", " ");
}

export function recoveryActionLabel(action?: string): string {
  if (!action) {
    return "暂无恢复策略";
  }
  return RECOVERY_LABELS[action] ?? action.replaceAll("_", " ");
}

export function trustLabel(trust?: string): string {
  if (!trust) {
    return "未知";
  }
  return TRUST_LABELS[trust] ?? trust.replaceAll("_", " ");
}

export function sourceLabel(source?: string): string {
  if (!source) {
    return "未知来源";
  }
  return SOURCE_LABELS[source] ?? source;
}

export function polarityLabel(polarity?: string): string {
  if (!polarity) {
    return "尚不确定";
  }
  return POLARITY_LABELS[polarity] ?? polarity;
}

export function issueStateLabel(state?: string): string {
  if (state === "closed") {
    return "已关闭";
  }
  if (state === "open") {
    return "打开";
  }
  return state ?? "";
}

export function actorLabel(actor?: string): string {
  if (actor === "llm") {
    return "大模型";
  }
  if (actor === "test_driver") {
    return "测试驱动";
  }
  if (actor === "unconfigured") {
    return "未配置";
  }
  return actor ?? "未知";
}

export function primaryVerificationChecks(session: InvestigationSessionDTO): InvestigationCheckDTO[] {
  const checks = session.verification?.checks ?? [];
  const primary = checks.filter((check) => PRIMARY_CHECK_IDS.has(check.id));
  return primary.length > 0 ? primary : checks.filter((check) => check.id !== "evidence-requirements");
}

export function evidenceCoverageLabel(session: InvestigationSessionDTO): string | undefined {
  const value = session.verification?.evidenceCoverage;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return `证据覆盖率：${formatMetric("evidenceCoverage", value)}`;
}

export function agentConclusion(session: InvestigationSessionDTO): string {
  return session.report.conclusion || session.agentOutput || "Agent 尚未给出结论。";
}

export function agentHarnessDisagree(session: InvestigationSessionDTO): boolean {
  const status = session.verification?.status;
  const polarity = session.report.polarity;
  if (!status) {
    return false;
  }
  if (polarity === "resolved" && status !== "verified_complete") {
    return true;
  }
  if (polarity !== "resolved" && status === "verified_complete") {
    return true;
  }
  return false;
}

export function latestFailure(session: InvestigationSessionDTO): InvestigationAttemptDTO | undefined {
  return [...session.attempts].reverse().find((attempt) => Boolean(attempt.failureType));
}

export function nextEvidenceTargets(ids?: string[]): string[] {
  if (!ids?.length) {
    return [];
  }
  return [...new Set(ids.map(requirementLabel))];
}

function extractStepTarget(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const pull = text.match(/pull\/(\d+)/i) ?? text.match(/pull request #(\d+)/i) ?? text.match(/\bPR #(\d+)/i);
  if (pull) {
    return `#${pull[1]}`;
  }
  const commit = text.match(/commit\/([a-f0-9]{6,40})/i);
  if (commit) {
    return commit[1].slice(0, 7);
  }
  return undefined;
}

export function stepTargetHint(step: InvestigationStepDTO, session: InvestigationSessionDTO): string | undefined {
  for (const evidenceId of step.evidenceIds) {
    const evidence = session.evidence.find((item) => item.id === evidenceId);
    const target = extractStepTarget(evidence?.resource) ?? extractStepTarget(evidence?.summary);
    if (target) {
      return target;
    }
  }
  return extractStepTarget(step.reason);
}

export function buildInvestigationSteps(session: InvestigationSessionDTO): InvestigationStepView[] {
  return session.steps.map((step) => {
    const hint = stepTargetHint(step, session);
    const base = toolStepLabel(step.tool);
    return {
      id: `step-${step.step}-${step.tool}`,
      label: hint ? `${base} ${hint}` : base,
      success: step.success,
      detail: step.reason,
    };
  });
}

export function buildTraceItems(session: InvestigationSessionDTO): TraceItem[] {
  const items: TraceItem[] = [
    {
      id: "start",
      label: "调查开始",
      detail: issueRef(session.task),
    },
  ];

  for (const step of session.steps) {
    const hint = stepTargetHint(step, session);
    items.push({
      id: `step-${step.step}-${step.tool}`,
      label: hint ? `${toolStepLabel(step.tool)} ${hint}` : toolStepLabel(step.tool),
      detail: step.success ? (step.reason ?? "成功") : (step.reason ?? "失败"),
      tone: step.success ? "pass" : "fail",
    });
    for (const evidenceId of step.evidenceIds) {
      const evidence = session.evidence.find((item) => item.id === evidenceId);
      items.push({
        id: `step-${step.step}-evidence-${evidenceId}`,
        label: "已添加证据",
        detail: evidence ? `${kindLabel(evidence.kind)} · ${evidence.summary}` : evidenceId,
      });
    }
  }

  for (const attempt of session.attempts) {
    items.push({
      id: `attempt-${attempt.id}`,
      label: `第 ${attempt.attempt} 轮`,
      detail: [attempt.status, attempt.strategy].filter(Boolean).join(" · ") || undefined,
    });
    if (attempt.verificationStatus) {
      items.push({
        id: `attempt-${attempt.id}-verification`,
        label: "验证",
        detail: verificationLabel(attempt.verificationStatus),
        tone:
          attempt.verificationStatus === "verified_complete"
            ? "pass"
            : attempt.verificationStatus === "insufficient_evidence"
              ? "warn"
              : "fail",
      });
    }
    if (attempt.failureType) {
      items.push({
        id: `attempt-${attempt.id}-failure`,
        label: "失败",
        detail: failureTypeLabel(attempt.failureType),
        tone: "fail",
      });
    }
    if (attempt.recoveryAction) {
      items.push({
        id: `attempt-${attempt.id}-recovery`,
        label: "恢复",
        detail: recoveryActionLabel(attempt.recoveryAction),
        tone: "warn",
      });
    }
  }

  return items;
}

export function recoveredFrom(attempt: InvestigationAttemptDTO, attempts: InvestigationAttemptDTO[]) {
  if (!attempt.parentAttemptId) {
    return undefined;
  }
  return attempts.find((item) => item.id === attempt.parentAttemptId);
}

export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? humanizeKey(key);
}

export function formatMetric(key: string, value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (/rate|coverage/i.test(key)) {
    const pct = value * 100;
    return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function outcomeLabel(status: string): string {
  return verificationLabel(status);
}
