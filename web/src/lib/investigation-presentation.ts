import type {
  InvestigationAttemptDTO,
  InvestigationSessionDTO,
  ResolutionAnalysisDTO,
} from "@dto";
import {
  agentHarnessDisagree,
  buildInvestigationSteps,
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

export interface InvestigationFinding {
  id: string;
  tone: CheckTone;
  text: string;
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
}

export interface InvestigationResultView {
  result: {
    statusLabel: string;
    subtitle: string;
    tone: VerificationTone;
    issueLine: string;
  };
  agent: {
    conclusion: string;
    originalConclusion: string;
    findings: InvestigationFinding[];
    judgment: string;
    judgmentNote: string;
    disagreesWithHarness: boolean;
    unresolvedQuestions: string[];
    resolutionAnalyses: ResolutionAnalysisView[];
  };
  harness: {
    disclaimer: string;
    statusLabel: string;
    checks: HarnessCheckView[];
    satisfiedLabel?: string;
  };
  process: {
    steps: InvestigationStepView[];
    emptyMessage?: string;
  };
  incident?: IncidentView;
  rawAgentOutput: string;
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
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

function pullMerged(item: { summary: string }): boolean | undefined {
  const match = item.summary.match(/merged=(true|false)/i);
  if (!match) {
    return undefined;
  }
  return match[1].toLowerCase() === "true";
}

export function buildInvestigationFindings(session: InvestigationSessionDTO): InvestigationFinding[] {
  const findings: InvestigationFinding[] = [];
  const issueEvidence = session.evidence.find((item) => item.kind === "issue");
  const state = issueStateLabel(session.issue.state);

  if (issueEvidence || session.issue.state) {
    findings.push({
      id: "issue-state",
      tone: "pass",
      text: state ? `Issue 当前状态：${state}` : `已获取 Issue ${issueRef(session.task)}`,
    });
  } else {
    findings.push({
      id: "issue-missing",
      tone: "warn",
      text: "当前调查没有获取到 Issue 记录。",
    });
  }

  const pulls = session.evidence.filter((item) => item.kind === "pull_request");
  if (pulls.length === 0) {
    findings.push({
      id: "pr-absent",
      tone: "warn",
      text: "未发现关联 Pull Request",
    });
  } else {
    const labels = pulls.map((item) => {
      const number = pullNumberFromEvidence(item);
      const merged = pullMerged(item);
      if (number && merged === true) {
        return `${number}（已合并）`;
      }
      if (number && merged === false) {
        return `${number}（未合并）`;
      }
      return number ?? item.summary;
    });
    findings.push({
      id: "pr-present",
      tone: pulls.some((item) => pullMerged(item) === true) ? "pass" : "warn",
      text: `发现关联 Pull Request：${labels.join("、")}`,
    });
  }

  const codeEvidence = session.evidence.filter(
    (item) => item.kind === "commit" || item.kind === "code" || item.kind === "file",
  );
  if (codeEvidence.length === 0) {
    findings.push({
      id: "commit-absent",
      tone: "warn",
      text: "当前调查没有找到能够证明问题已修复的 Commit。",
    });
  } else {
    const commits = codeEvidence.filter((item) => item.kind === "commit" || item.kind === "code").length;
    const files = codeEvidence.filter((item) => item.kind === "file").length;
    const parts = [
      commits > 0 ? `${commits} 条 Commit / 代码证据` : undefined,
      files > 0 ? `${files} 个文件变更` : undefined,
    ].filter(Boolean);
    findings.push({
      id: "commit-present",
      tone: "pass",
      text: `发现代码 / Commit 证据：${parts.join("，")}`,
    });
  }

  const hasResolutionLink = session.relations.some(
    (item) => item.type === "fixes" || item.type === "merges",
  );
  findings.push({
    id: "resolution-chain",
    tone: hasResolutionLink ? "pass" : "warn",
    text: hasResolutionLink
      ? "当前证据中存在 Issue 与解决记录之间的关联。"
      : "当前没有建立 Issue → Resolution 的完整证据链",
  });

  return findings;
}

export function presentAgentConclusion(session: InvestigationSessionDTO): string {
  const original = session.report.conclusion || session.agentOutput;
  if (original && hasChinese(original)) {
    return original;
  }
  if (session.actor === "unconfigured" || session.status === "unconfigured") {
    return "当前未配置可用于调查的大模型，因此没有完成 Agent 调查。";
  }

  const issueClosed = session.issue.state === "closed";
  const pulls = session.evidence.filter((item) => item.kind === "pull_request");
  const hasPr = pulls.length > 0;
  const mergedPr = pulls.some((item) => pullMerged(item) === true);
  const hasCode = session.evidence.some(
    (item) => item.kind === "commit" || item.kind === "code" || item.kind === "file",
  );
  const polarity = session.report.polarity;

  if (issueClosed && !hasPr && !hasCode) {
    return "Issue 已关闭，但没有发现能够证明问题已通过代码修改解决的证据。";
  }
  if (mergedPr && hasCode) {
    return "我检查了 Issue 当前状态、关联 Pull Request 和 Commit 信息。调查发现了已合并的 Pull Request 以及相关代码 / Commit 证据，并解释了它们与该 Issue 的关系。";
  }
  if (hasPr && !mergedPr) {
    return "我检查了 Issue 当前状态和关联 Pull Request。目前发现了相关 Pull Request，但没有确认合并或代码修复证据，因此无法确认该 Issue 已经解决。";
  }
  if (polarity === "resolved") {
    return "我检查了 Issue 当前状态、关联 Pull Request 和 Commit 信息。根据已收集的证据，目前认为该 Issue 可能已经解决。";
  }
  return "我检查了 Issue 当前状态、关联 Pull Request 和 Commit 信息。目前没有发现能够证明该问题已经解决的证据，因此无法确认它已经解决。";
}

export function presentAgentJudgment(session: InvestigationSessionDTO): string {
  const polarity = session.report.polarity;
  if (polarity === "resolved") {
    return "目前认为该 Issue 已经解决。";
  }
  if (polarity === "unresolved") {
    return "目前认为该 Issue 尚未解决。";
  }
  if (polarity === "partial") {
    return "目前认为该 Issue 仅部分解决。";
  }
  return "目前无法确认该 Issue 已经解决。";
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
  const type = attempt.failureType ?? "unknown";
  return {
    kind: "process",
    title: "调查过程中遇到问题",
    summary: PROCESS_FAILURE_SUMMARY[type] ?? "调查过程中遇到问题，因此当前结果可能不完整。",
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
  return session.rawAgentOutput || session.agentOutput || session.report.conclusion || "";
}

export function buildInvestigationResultView(session: InvestigationSessionDTO): InvestigationResultView {
  const status = session.verification?.status;
  const steps = buildInvestigationSteps(session);
  const requirement = evidenceRequirementSummary(session);
  const originalConclusion = session.report.conclusion || session.agentOutput || "";
  const issueTitle = session.issue.title || session.issue.summary;
  const issueLine = [
    issueRef(session.task),
    issueTitle,
    session.issue.state ? issueStateLabel(session.issue.state) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    result: {
      statusLabel: verificationLabel(status),
      subtitle: verificationSubtitle(status),
      tone: verificationTone(status),
      issueLine,
    },
    agent: {
      conclusion: presentAgentConclusion(session),
      originalConclusion,
      findings: buildInvestigationFindings(session),
      judgment: presentAgentJudgment(session),
      judgmentNote: "这是 Agent 的判断，不是 Harness 独立验证。",
      disagreesWithHarness: agentHarnessDisagree(session),
      unresolvedQuestions: presentUnresolvedQuestions(session.report.openQuestions),
      resolutionAnalyses: presentResolutionAnalyses(session.resolutionAnalyses),
    },
    harness: {
      disclaimer: "以下判断由 Harness 根据收集到的证据独立完成，不采用 Agent 的最终结论作为验证依据。",
      statusLabel: verificationLabel(status),
      checks: primaryVerificationChecks(session).map((check) => ({
        id: check.id,
        label: checkLabel(check),
        mark: checkMark(check.status),
        tone: checkTone(check.status),
      })),
      satisfiedLabel: requirement.label,
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
