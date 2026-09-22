import type {
  InvestigationAttemptDTO,
  InvestigationEvidenceDTO,
  InvestigationSessionDTO,
  ResolutionAnalysisDTO,
} from "@dto";
import {
  agentHarnessDisagree,
  buildInvestigationSteps,
  checkExplanation,
  checkLabel,
  checkMark,
  checkTone,
  failureTypeLabel,
  issueRef,
  issueStateLabel,
  nextEvidenceTargets,
  polarityLabel,
  primaryVerificationChecks,
  recoveryActionLabel,
  requirementLabel,
  type CheckTone,
  type InvestigationStepView,
  verificationLabel,
  verificationSubtitle,
  verificationTone,
  type VerificationTone,
} from "./workbench";

const PROCESS_FAILURE_TYPES = new Set([
  "tool_failure",
  "retrieval_failure",
  "premature_completion",
  "loop_failure",
  "invalid_evidence",
  "wrong_target",
  "runtime_budget_exceeded",
  "unknown",
]);

const QUESTION_PRESENTATION: Record<string, string> = {
  "No merged pull request, commit, or other resolution evidence was found.":
    "是否存在尚未关联到 Issue 的修复？",
  "A related pull request exists but is not merged.": "关联 Pull Request 是否已经合并？",
  "The observed diff cannot prove runtime behavior.": "观察到的代码差异能否在运行时证明问题已修复？",
  "No test execution results were observed.": "是否存在测试执行结果？",
  "Current file evidence has no bounded patch; code-change context is insufficient.":
    "当前文件证据是否包含可分析的代码差异？",
  "The current snapshot may lack necessary file diffs.": "当前快照是否缺少必要的文件差异？",
  "Bounded unified diff was not exposed to the investigation context; code-change context is insufficient.":
    "当前调查上下文是否包含可分析的代码差异？",
  "File metadata alone cannot prove runtime behavior.": "仅有文件元数据能否证明运行时行为？",
  "Some changed files have metadata only and no bounded patch.": "部分变更文件是否缺少可分析的代码差异？",
};

const ANALYSIS_TEXT_PRESENTATION: Record<string, string> = {
  "insufficient code-change context": "当前没有足够的代码变更上下文。",
  "Current observed PR file evidence does not include an obvious test-file change (not observed / unknown). Absence from this snapshot is not evidence that tests are missing.":
    "当前观察到的 PR 文件证据中没有明显的测试文件变更（未观察到 / 未知）。快照中没有出现，并不等于测试缺失。",
};

const RECOVERY_REASON_PRESENTATION: Array<{ match: RegExp; text: string }> = [
  {
    match: /no further useful evidence source remains|no further sources remain|produced no useful evidence/i,
    text: "当前调查未找到新的有效证据，因此停止重复查询。",
  },
  {
    match: /attempt budget reached|recovery attempt budget exhausted|tool retry budget exhausted/i,
    text: "调查已停止，避免重复执行相同的检索。",
  },
  {
    match: /loop detected|stopping to avoid/i,
    text: "调查已停止，避免重复执行相同的检索。",
  },
  {
    match: /collect only the missing kinds|required evidence is missing/i,
    text: "当前调查未找到完成验证所需的证据，因此停止重复相同的检索。",
  },
  {
    match: /retryable github tool failure|bounded backoff/i,
    text: "将稍后重试失败的工具调用，并保留已收集的证据。",
  },
  {
    match: /change retrieval strategy|do not replay the same query/i,
    text: "更换检索策略，避免重复同一查询。",
  },
];

const PROCESS_FAILURE_SUMMARY: Record<string, string> = {
  tool_failure: "某次工具调用未成功，因此当前调查可能受到影响。",
  retrieval_failure: "某次信息检索未成功，因此当前调查可能受到影响。",
  premature_completion: "Agent 在证据仍不完整时结束了调查，因此当前结论可能不完整。",
  loop_failure: "调查过程未能继续推进，因此停止重复执行相同的检索。",
  invalid_evidence: "部分证据无效，当前调查可能受到影响。",
  wrong_target: "调查目标与当前 Issue 不一致，因此当前调查可能受到影响。",
  runtime_budget_exceeded: "调查已达到运行预算，因此提前停止。",
  unknown: "调查过程中遇到问题，因此当前结果可能不完整。",
};

export type InvestigationFindingSource = "evidence" | "investigation_step";

export type AgentConclusionSource = "agent_report" | "presentation_fallback";

export type InvestigationVerificationStatus =
  | "verified_complete"
  | "not_verified"
  | "insufficient_evidence";

export type EvidenceView = InvestigationEvidenceDTO;

export interface InvestigationFindingView {
  id: string;
  tone: CheckTone;
  text: string;
  source: InvestigationFindingSource;
  evidenceIds: string[];
}

export interface PresentedAnalysisText {
  text: string;
  observed?: string;
  inference?: string;
}

export interface ResolutionAnalysisView {
  candidateEvidenceId: string;
  mergeCommitSha?: string;
  codeRelevance: PresentedAnalysisText;
  behavioralAlignment: PresentedAnalysisText;
  testSupport: PresentedAnalysisText;
  unresolvedQuestions: string[];
}

export interface IncidentView {
  kind: "process" | "insufficient";
  title: string;
  summary: string;
  recoveryTitle?: string;
  recoverySummary?: string;
  nextEvidence: string[];
  rawFailureType?: string;
  rawFailureReason?: string;
  rawRecoveryAction?: string;
  rawRecoveryReason?: string;
}

export interface HarnessCheckView {
  id: string;
  label: string;
  mark: string;
  tone: CheckTone;
  explanation?: string;
}

export interface VerdictGapView {
  id: string;
  mark: string;
  label: string;
  explanation: string;
}

export interface InvestigationVerdictView {
  why: string;
  gaps: VerdictGapView[];
  counts: { pass: number; fail: number; unknown: number };
}

/** Phase 18-C mid-run presentation. Copy only; checks and verdict are untouched. */
export interface AttributionCoverageView {
  state: "exhausted" | "mid_run" | "not_assertable";
  /** Shown next to the status label only when this is a mid-run conclusion. */
  marker?: string;
  unadjudicatedCount: number;
}

export interface AgentClaimView {
  id: string;
  text: string;
  critical: boolean;
  supported: boolean;
}

const GAP_FALLBACK_EXPLANATION: Record<string, string> = {
  "issue-state": "Issue 目前仍是打开的：修复可能已生效，但记录上未走完关闭流程。",
  "resolution-effect": "只有文件变更证据，没有测试运行或行为验证记录能证明 bug 已消失。",
};

function buildInvestigationVerdict(
  status: InvestigationVerificationStatus | undefined,
  checks: HarnessCheckView[],
  missingRequirementIds: string[],
  coverage?: AttributionCoverageView,
): InvestigationVerdictView {
  const counts = {
    pass: checks.filter((item) => item.tone === "pass").length,
    fail: checks.filter((item) => item.tone === "fail").length,
    unknown: checks.filter((item) => item.tone !== "pass" && item.tone !== "fail").length,
  };
  const passed = checks.filter((item) => item.tone === "pass").map((item) => item.label);
  const why =
    status === "verified_complete"
      ? `全部验证项通过：${passed.join("、")}。`
      : passed.length > 0
        ? `已验证到的部分：${passed.join("、")}。`
        : "目前没有通过的验证项。";

  const gaps: VerdictGapView[] = [];
  if (status === "not_verified") {
    for (const check of checks) {
      if (check.tone === "fail") {
        gaps.push({
          id: check.id,
          mark: check.mark,
          label: check.label,
          explanation: GAP_FALLBACK_EXPLANATION[check.id] ?? check.explanation ?? "",
        });
      }
    }
  } else if (status === "insufficient_evidence") {
    for (const check of checks) {
      if (check.tone !== "pass" && check.tone !== "fail") {
        gaps.push({
          id: check.id,
          mark: "?",
          label: check.label,
          explanation: check.explanation ?? "",
        });
      }
    }
    for (const id of missingRequirementIds) {
      const label = requirementLabel(id);
      // 检查项与证据要求是两套 id，同一缺口只保留一条。
      if (!gaps.some((item) => item.id === id || item.label === label)) {
        gaps.push({ id, mark: "?", label, explanation: "缺少该类证据。" });
      }
    }
  }
  return { why, gaps: coverageGapFirst(gaps, coverage), counts };
}

function coverageGapFirst(
  gaps: VerdictGapView[],
  coverage?: AttributionCoverageView,
): VerdictGapView[] {
  if (!coverage || coverage.state !== "mid_run") {
    return gaps;
  }
  return [
    {
      id: "attribution-coverage",
      mark: "?",
      label:
        coverage.unadjudicatedCount > 0
          ? `中间结论：还有 ${coverage.unadjudicatedCount} 个解决候选未完成机器裁决`
          : "中间结论：候选扫描未穷尽（部分机器扫描源失败或被跳过）",
      explanation: "候选枚举或裁决尚未穷尽，本结论是中间结论，不代表已排查完所有解决线索。",
    },
    ...gaps,
  ];
}

function presentAttributionCoverage(
  session: InvestigationSessionDTO,
): AttributionCoverageView | undefined {
  const coverage = session.attributionCoverage;
  if (!coverage) {
    return undefined;
  }
  const unadjudicatedCount = coverage.unadjudicatedCandidates.length + coverage.unenumeratedCandidates;
  if (coverage.state !== "mid_run") {
    return { state: coverage.state, unadjudicatedCount };
  }
  return {
    state: coverage.state,
    unadjudicatedCount,
    marker: coverage.budgetExhausted ? "中间结论 · 预算耗尽" : "中间结论 · 未穷尽",
  };
}

export interface VerificationView {
  status: string | undefined;
  checks: HarnessCheckView[];
  evidenceCoverage: number | undefined;
  missingRequirementIds: string[];
  unsupportedClaimIds: string[];
  prematureCompletion: boolean;
  satisfiedLabel?: string;
}

export interface AgentLaneView {
  conclusion: string;
  conclusionSource: AgentConclusionSource;
  originalConclusion: string;
  judgment: string;
  judgmentNote: string;
  disagreesWithHarness: boolean;
  claims: AgentClaimView[];
  resolutionAnalyses: ResolutionAnalysisView[];
}

export interface InvestigationResultViewModel {
  status: InvestigationVerificationStatus | undefined;
  statusLabel: string;
  summary: string;
  tone: VerificationTone;
  issueLine: string;
  verdict: InvestigationVerdictView;
  /** Phase 18-C. Undefined on legacy snapshot runs — coverage not assertable. */
  coverage?: AttributionCoverageView;
  findings: InvestigationFindingView[];
  evidence: EvidenceView[];
  verification: VerificationView;
  openQuestions: string[];
  uncertainty: string[];
  agent: AgentLaneView;
  process: {
    steps: InvestigationStepView[];
    emptyMessage?: string;
  };
  incident?: IncidentView;
  rawAgentOutput: string;
}

const MISSING_AGENT_CONCLUSION = "本次调查没有产生 Agent 最终回答。";
const UNCONFIGURED_CONCLUSION = "当前未配置可用于调查的大模型，因此没有完成 Agent 调查。";

const ISSUE_TOOLS = ["get_issue"];
const PR_RETRIEVAL_TOOLS = ["get_pull_request"];
const PR_INSPECTION_TOOLS = [
  "get_pull_request",
  "get_pull_request_files",
  "get_pull_request_reviews",
];
const COMMIT_TOOLS = ["list_commits"];
const PROCESS_TOOL_FAILURES = new Set(["tool_failure", "retrieval_failure"]);

interface ToolActivity {
  succeeded: boolean;
  failed: boolean;
}

function canonicalTool(tool: string): string {
  return tool.replace(/^github_/, "");
}

function toolMatches(tool: string | undefined, names: string[]): boolean {
  if (!tool) {
    return false;
  }
  const canonical = canonicalTool(tool);
  return names.some((name) => canonicalTool(name) === canonical);
}

function collectToolActivity(session: InvestigationSessionDTO, names: string[]): ToolActivity {
  const steps = session.steps.filter((step) => toolMatches(step.tool, names));
  const attemptFailed = session.attempts.some(
    (attempt) =>
      PROCESS_TOOL_FAILURES.has(attempt.failureType ?? "") && toolMatches(attempt.failureTool, names),
  );
  return {
    succeeded: steps.some((step) => step.success),
    failed: steps.some((step) => !step.success) || attemptFailed,
  };
}

function checkedEmpty(activity: ToolActivity): boolean {
  return activity.succeeded && !activity.failed;
}

function realAgentOutput(session: InvestigationSessionDTO): string | undefined {
  for (const candidate of [session.agentOutput, session.rawAgentOutput]) {
    const text = candidate?.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function processFailureSummary(attempt: InvestigationAttemptDTO): string {
  const type = attempt.failureType ?? "unknown";
  if (type === "tool_failure" || type === "retrieval_failure") {
    if (toolMatches(attempt.failureTool, PR_INSPECTION_TOOLS)) {
      return "关联 Pull Request 的检索未成功。";
    }
    if (toolMatches(attempt.failureTool, COMMIT_TOOLS)) {
      return "Commit 的检索未成功。";
    }
  }
  return PROCESS_FAILURE_SUMMARY[type] ?? "调查过程中遇到问题，因此当前结果可能不完整。";
}

function presentKnownText(text: string, table: Record<string, string>): string {
  return table[text] ?? text;
}

export function presentUnresolvedQuestion(question: string): string {
  return presentKnownText(question, QUESTION_PRESENTATION);
}

export function presentUnresolvedQuestions(questions: string[] | undefined): string[] {
  if (!questions?.length) {
    return [];
  }
  return [...new Set(questions.map((item) => presentUnresolvedQuestion(item)).filter(Boolean))];
}

export function isProcessFailure(type?: string): boolean {
  return Boolean(type && PROCESS_FAILURE_TYPES.has(type));
}

export function isEvidenceInsufficiency(type?: string): boolean {
  return type === "insufficient_evidence";
}

function pullNumberFromEvidence(item: { summary: string; resource?: string }): string | undefined {
  const fromResource = item.resource?.match(/pull\/(\d+)/i);
  if (fromResource) {
    return `#${fromResource[1]}`;
  }
  const fromSummary = item.summary.match(/PR #(\d+)/i);
  return fromSummary ? `#${fromSummary[1]}` : undefined;
}

function issueEvidenceIds(session: InvestigationSessionDTO): Set<string> {
  return new Set(session.evidence.filter((item) => item.kind === "issue").map((item) => item.id));
}

/**
 * Merge state comes only from structured relations recorded by the harness:
 * a "merges" relation associated with the PR means landed / merged;
 * a PR→Issue "references" relation means not merged.
 * "fixes" marks a resolution candidate, NOT a merge, so it never proves merged.
 * No summary parsing, no inference.
 */
function pullMergeStateFromRelations(
  session: InvestigationSessionDTO,
  pullEvidenceId: string,
): boolean | undefined {
  const issueIds = issueEvidenceIds(session);
  for (const relation of session.relations) {
    if (relation.type === "merges" && (relation.toEvidenceId === pullEvidenceId || relation.fromEvidenceId === pullEvidenceId)) {
      return true;
    }
    if (relation.type === "references" && relation.fromEvidenceId === pullEvidenceId && issueIds.has(relation.toEvidenceId)) {
      return false;
    }
  }
  return undefined;
}

interface PullGroup {
  number?: string;
  label: string;
  ids: string[];
  merged: boolean | undefined;
}

function groupPullEvidence(session: InvestigationSessionDTO, pulls: InvestigationEvidenceDTO[]): PullGroup[] {
  const groups = new Map<string, PullGroup>();
  for (const item of pulls) {
    const number = pullNumberFromEvidence(item);
    const key = number ?? item.id;
    let group = groups.get(key);
    if (!group) {
      group = { number, label: number ?? item.summary, ids: [], merged: undefined };
      groups.set(key, group);
    }
    group.ids.push(item.id);
    const state = pullMergeStateFromRelations(session, item.id);
    if (state === true) {
      group.merged = true;
    } else if (state === false && group.merged !== true) {
      group.merged = false;
    }
  }
  return [...groups.values()];
}

function pullFinding(
  session: InvestigationSessionDTO,
  pulls: InvestigationEvidenceDTO[],
): { tone: CheckTone; text: string; evidenceIds: string[] } {
  const groups = groupPullEvidence(session, pulls);
  const labels = groups.map((group) => {
    if (group.merged === true) {
      return `${group.label}（已合并）`;
    }
    if (group.merged === false) {
      return `${group.label}（未合并）`;
    }
    return group.label;
  });
  return {
    tone: groups.some((group) => group.merged === true) ? "pass" : "warn",
    text: `发现关联 Pull Request：${labels.join("、")}`,
    evidenceIds: groups.flatMap((group) => group.ids),
  };
}

function commitFindingText(codeEvidence: InvestigationEvidenceDTO[]): string {
  const commits = codeEvidence.filter((item) => item.kind === "commit" || item.kind === "code").length;
  const files = codeEvidence.filter((item) => item.kind === "file").length;
  const parts = [
    commits > 0 ? `${commits} 条 Commit / 代码证据` : undefined,
    files > 0 ? `${files} 个文件变更` : undefined,
  ].filter(Boolean);
  return `发现代码 / Commit 证据：${parts.join("，")}`;
}

export function buildInvestigationFindings(session: InvestigationSessionDTO): InvestigationFindingView[] {
  const findings: InvestigationFindingView[] = [];
  const issueEvidence = session.evidence.find((item) => item.kind === "issue");
  const state = issueStateLabel(session.issue.state);

  if (issueEvidence || session.issue.state) {
    findings.push({
      id: "issue-state",
      tone: "pass",
      source: issueEvidence ? "evidence" : "investigation_step",
      evidenceIds: issueEvidence ? [issueEvidence.id] : [],
      text: state ? `Issue 当前状态：${state}` : `已获取 Issue ${issueRef(session.task)}`,
    });
  } else {
    const issueActivity = collectToolActivity(session, ISSUE_TOOLS);
    if (checkedEmpty(issueActivity)) {
      findings.push({
        id: "issue-missing",
        tone: "warn",
        source: "investigation_step",
        evidenceIds: [],
        text: "已检查 Issue，目前没有获取到可用的 Issue 记录。",
      });
    }
  }

  const pulls = session.evidence.filter((item) => item.kind === "pull_request");
  const prActivity = collectToolActivity(session, PR_RETRIEVAL_TOOLS);
  if (pulls.length > 0) {
    const presented = pullFinding(session, pulls);
    findings.push({
      id: "pr-present",
      tone: presented.tone,
      source: "evidence",
      evidenceIds: presented.evidenceIds,
      text: presented.text,
    });
  } else if (checkedEmpty(prActivity)) {
    findings.push({
      id: "pr-checked-empty",
      tone: "warn",
      source: "investigation_step",
      evidenceIds: [],
      text: "已检查关联 Pull Request，目前没有找到可用的关联 PR。",
    });
  }

  const codeEvidence = session.evidence.filter(
    (item) => item.kind === "commit" || item.kind === "code" || item.kind === "file",
  );
  const commitActivity = collectToolActivity(session, COMMIT_TOOLS);
  if (codeEvidence.length > 0) {
    findings.push({
      id: "commit-present",
      tone: "pass",
      source: "evidence",
      evidenceIds: codeEvidence.map((item) => item.id),
      text: commitFindingText(codeEvidence),
    });
  } else if (checkedEmpty(commitActivity)) {
    findings.push({
      id: "commit-checked-empty",
      tone: "warn",
      source: "investigation_step",
      evidenceIds: [],
      text: "已检查 Commit，目前没有找到能够确认修复的 Commit。",
    });
  }

  const resolutionRelations = session.relations.filter(
    (item) => item.type === "fixes" || item.type === "merges",
  );
  if (resolutionRelations.length > 0) {
    const knownIds = new Set(session.evidence.map((item) => item.id));
    findings.push({
      id: "resolution-chain",
      tone: "pass",
      source: "evidence",
      evidenceIds: [
        ...new Set(
          resolutionRelations
            .flatMap((item) => [item.fromEvidenceId, item.toEvidenceId])
            .filter((id) => knownIds.has(id)),
        ),
      ],
      text: "当前证据中存在 Issue 与解决记录之间的关联。",
    });
  }

  return findings;
}

export function presentAgentConclusionView(session: InvestigationSessionDTO): {
  text: string;
  source: AgentConclusionSource;
} {
  if (session.actor === "unconfigured" || session.status === "unconfigured") {
    return { text: UNCONFIGURED_CONCLUSION, source: "presentation_fallback" };
  }
  const authored = realAgentOutput(session);
  if (authored) {
    return { text: authored, source: "agent_report" };
  }
  return { text: MISSING_AGENT_CONCLUSION, source: "presentation_fallback" };
}

export function presentAgentConclusion(session: InvestigationSessionDTO): string {
  return presentAgentConclusionView(session).text;
}

export function presentAgentJudgment(session: InvestigationSessionDTO): string {
  const polarity = session.report.polarity;
  if (polarity === "resolved") {
    return "调查发现：目前证据指向该 Issue 已经解决。";
  }
  if (polarity === "unresolved") {
    return "调查发现：目前证据指向该 Issue 尚未解决。";
  }
  if (polarity === "partial") {
    return "调查发现：目前证据指向该 Issue 仅部分解决。";
  }
  return "调查发现：目前无法确认该 Issue 已经解决。";
}

export function splitObservedInference(text: string): PresentedAnalysisText {
  const mapped = presentKnownText(text, ANALYSIS_TEXT_PRESENTATION);
  if (mapped !== text) {
    return { text: mapped, observed: mapped };
  }
  const inferenceIndex = text.search(/\.\s*Inference:/i);
  const observedPrefix = text.match(/^Observed facts:\s*/i);
  if (observedPrefix && inferenceIndex >= 0) {
    const observed = text.slice(observedPrefix[0].length, inferenceIndex).trim();
    const inference = text.slice(inferenceIndex).replace(/^\.\s*Inference:\s*/i, "").trim();
    return { text, observed, inference };
  }
  if (/hypothesis|inference|may relate|may correspond/i.test(text)) {
    return { text, inference: text };
  }
  return { text, observed: text };
}

export function presentResolutionAnalyses(
  analyses: ResolutionAnalysisDTO[] | undefined,
): ResolutionAnalysisView[] {
  if (!analyses?.length) {
    return [];
  }
  return analyses.map((item) => ({
    candidateEvidenceId: item.candidateEvidenceId,
    mergeCommitSha: item.mergeCommitSha,
    codeRelevance: splitObservedInference(item.codeRelevance),
    behavioralAlignment: splitObservedInference(item.behavioralAlignment),
    testSupport: splitObservedInference(item.testSupport),
    unresolvedQuestions: presentUnresolvedQuestions(item.unresolvedQuestions),
  }));
}

export function presentRecoveryReason(action?: string, reason?: string): string | undefined {
  if (action === "stop") {
    return "调查已停止，避免重复执行相同的检索。";
  }
  if (reason) {
    for (const item of RECOVERY_REASON_PRESENTATION) {
      if (item.match.test(reason)) {
        return item.text;
      }
    }
  }
  if (action) {
    return recoveryActionLabel(action);
  }
  return undefined;
}

function nextEvidenceFromAttempt(attempt?: InvestigationAttemptDTO): string[] {
  if (!attempt) {
    return [];
  }
  return nextEvidenceTargets(attempt.recoveryNextRequirementIds ?? attempt.missingRequirementIds);
}

function processIncident(attempt: InvestigationAttemptDTO): IncidentView {
  return {
    kind: "process",
    title: "调查过程中遇到问题",
    summary: processFailureSummary(attempt),
    recoveryTitle: attempt.recoveryAction ? "恢复策略" : undefined,
    recoverySummary: presentRecoveryReason(attempt.recoveryAction, attempt.recoveryReason),
    nextEvidence: nextEvidenceFromAttempt(attempt),
    rawFailureType: attempt.failureType,
    rawFailureReason: attempt.failureReason,
    rawRecoveryAction: attempt.recoveryAction,
    rawRecoveryReason: attempt.recoveryReason,
  };
}

function insufficientIncident(attempt?: InvestigationAttemptDTO): IncidentView {
  const stopped = attempt?.recoveryAction === "stop";
  return {
    kind: "insufficient",
    title: "证据不足",
    summary: "当前调查没有获得能够完成验证所需的证据。",
    recoveryTitle: attempt?.recoveryAction ? "恢复策略" : undefined,
    recoverySummary: stopped
      ? "调查已停止，避免重复执行相同的检索。"
      : presentRecoveryReason(attempt?.recoveryAction, attempt?.recoveryReason),
    nextEvidence: nextEvidenceFromAttempt(attempt),
    rawFailureType: attempt?.failureType,
    rawFailureReason: attempt?.failureReason,
    rawRecoveryAction: attempt?.recoveryAction,
    rawRecoveryReason: attempt?.recoveryReason,
  };
}

export function investigationIncident(session: InvestigationSessionDTO): IncidentView | undefined {
  const last = session.attempts.at(-1);
  if (last && isProcessFailure(last.failureType)) {
    return processIncident(last);
  }
  if (last && isEvidenceInsufficiency(last.failureType)) {
    return insufficientIncident(last);
  }
  if (session.verification?.status === "insufficient_evidence") {
    return insufficientIncident(last);
  }
  if (last?.recoveryAction === "stop") {
    return {
      kind: "insufficient",
      title: "调查已停止",
      summary: "调查已停止，避免重复执行相同的检索。",
      recoveryTitle: "恢复策略",
      recoverySummary: presentRecoveryReason(last.recoveryAction, last.recoveryReason),
      nextEvidence: nextEvidenceFromAttempt(last),
      rawFailureType: last.failureType,
      rawFailureReason: last.failureReason,
      rawRecoveryAction: last.recoveryAction,
      rawRecoveryReason: last.recoveryReason,
    };
  }
  return undefined;
}

export function evidenceRequirementSummary(session: InvestigationSessionDTO): {
  passed: number;
  total: number;
  label?: string;
} {
  const checks = primaryVerificationChecks(session);
  const passed = checks.filter((item) => item.status === "pass").length;
  return {
    passed,
    total: checks.length,
    label: checks.length > 0 ? `满足 ${passed} / ${checks.length} 项证据要求` : undefined,
  };
}

export function rawAgentOutputText(session: InvestigationSessionDTO): string {
  return session.rawAgentOutput || session.agentOutput || "";
}

function asVerificationStatus(status: string | undefined): InvestigationVerificationStatus | undefined {
  if (status === "verified_complete" || status === "not_verified" || status === "insufficient_evidence") {
    return status;
  }
  return undefined;
}

export function buildInvestigationResultView(session: InvestigationSessionDTO): InvestigationResultViewModel {
  const verification = session.verification;
  const status = asVerificationStatus(verification?.status);
  const steps = buildInvestigationSteps(session);
  const requirement = evidenceRequirementSummary(session);
  const originalConclusion = session.report.conclusion || "";
  const issueTitle = session.issue.title || session.issue.summary;
  const issueLine = [
    issueRef(session.task),
    issueTitle,
    session.issue.state ? issueStateLabel(session.issue.state) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const presentedConclusion = presentAgentConclusionView(session);
  const resolutionAnalyses = presentResolutionAnalyses(session.resolutionAnalyses);
  const openQuestions = [
    ...new Set([
      ...presentUnresolvedQuestions(session.report.openQuestions),
      ...resolutionAnalyses.flatMap((item) => item.unresolvedQuestions),
    ]),
  ].filter(Boolean);

  const harnessChecks = primaryVerificationChecks(session).map((check) => ({
    id: check.id,
    label: checkLabel(check),
    mark: checkMark(check.status),
    tone: checkTone(check.status),
    explanation: checkExplanation(check.id),
  }));
  const coverage = presentAttributionCoverage(session);
  const unsupportedClaimIds = verification?.unsupportedClaimIds ?? [];
  const agentClaims: AgentClaimView[] = session.claims.map((claim) => ({
    id: claim.id,
    text: claim.text,
    critical: claim.critical,
    supported: !unsupportedClaimIds.includes(claim.id),
  }));

  return {
    status,
    statusLabel: verificationLabel(verification?.status),
    summary: verificationSubtitle(verification?.status),
    tone: verificationTone(verification?.status),
    issueLine,
    verdict: buildInvestigationVerdict(
      status,
      harnessChecks,
      verification?.missingRequirementIds ?? [],
      coverage,
    ),
    coverage,
    findings: buildInvestigationFindings(session),
    evidence: session.evidence,
    verification: {
      status: verification?.status,
      checks: harnessChecks,
      evidenceCoverage: verification?.evidenceCoverage,
      missingRequirementIds: verification?.missingRequirementIds ?? [],
      unsupportedClaimIds,
      prematureCompletion: verification?.prematureCompletion ?? false,
      satisfiedLabel: requirement.label,
    },
    openQuestions,
    uncertainty: session.report.uncertainty ? [session.report.uncertainty] : [],
    agent: {
      conclusion: presentedConclusion.text,
      conclusionSource: presentedConclusion.source,
      originalConclusion,
      judgment: presentAgentJudgment(session),
      judgmentNote: "这是调查阶段产生的判断，不是独立验证结果；是否解决以独立验证为准。",
      disagreesWithHarness: agentHarnessDisagree(session),
      claims: agentClaims,
      resolutionAnalyses,
    },
    process: {
      steps,
      emptyMessage: steps.length === 0 ? "当前版本未记录该步骤的详细过程。" : undefined,
    },
    incident: investigationIncident(session),
    rawAgentOutput: rawAgentOutputText(session),
  };
}

export function incidentIsInvestigationFailure(incident?: IncidentView): boolean {
  return incident?.kind === "process";
}

export function harnessSatisfiedCountLabel(session: InvestigationSessionDTO): string | undefined {
  return evidenceRequirementSummary(session).label;
}

export function polarityPresentation(polarity?: string): string {
  return polarityLabel(polarity);
}

export function failureTypePresentation(type?: string): string {
  return failureTypeLabel(type);
}
