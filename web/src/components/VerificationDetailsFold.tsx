import { formatMetric, requirementLabel } from "../lib/workbench";
import type { InvestigationResultViewModel, PresentedAnalysisText } from "../lib/investigation-presentation";

function AnalysisText({ value }: { value: PresentedAnalysisText }) {
  if (value.observed || value.inference) {
    return (
      <div className="analysis-split">
        {value.observed ? (
          <p className="observation">
            <span className="analysis-tag">已观察事实</span>
            {value.observed}
          </p>
        ) : null}
        {value.inference ? (
          <p className="inference">
            <span className="analysis-tag">Agent 推断</span>
            {value.inference}
          </p>
        ) : null}
      </div>
    );
  }
  return <p>{value.text}</p>;
}

export function VerificationDetailsFold({
  view,
  onShowEvidence,
  num,
}: {
  view: InvestigationResultViewModel;
  onShowEvidence: (evidenceIds: string[]) => void;
  num: number;
}) {
  const verification = view.verification;
  const coverage =
    typeof verification.evidenceCoverage === "number" && Number.isFinite(verification.evidenceCoverage)
      ? formatMetric("evidenceCoverage", verification.evidenceCoverage)
      : undefined;
  const counts = [
    view.verdict.counts.pass > 0 ? `✓ ${view.verdict.counts.pass}` : undefined,
    view.verdict.counts.fail > 0 ? `✗ ${view.verdict.counts.fail}` : undefined,
    view.verdict.counts.unknown > 0 ? `? ${view.verdict.counts.unknown}` : undefined,
  ].filter(Boolean);

  return (
    <details className="phase" data-testid="verification-details">
      <summary className="phase-head">
        <span className="phase-num">{num}</span>
        验证明细（{counts.join(" · ") || `${verification.checks.length} 项`}）
        <span className="tag">（点击展开）</span>
      </summary>
      <div className="phase-body">
      <p className="muted">
        以下检查由 Harness 根据证据独立完成，不采用 Agent 的结论作为验证依据。✓ 通过、✗ 未通过、? 无法判断。
      </p>

      {verification.checks.length === 0 ? (
        <p className="empty">这次调查没有验证检查。</p>
      ) : (
        <ul className="check-list">
          {verification.checks.map((check) => (
            <li key={check.id} className={`check ${check.tone}`}>
              <span>{check.mark}</span>
              <span>
                {check.label}
                {check.explanation ? <span className="muted"> · {check.explanation}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {verification.satisfiedLabel ? (
        <p className="coverage" data-testid="requirement-summary">
          {verification.satisfiedLabel}
        </p>
      ) : null}
      {coverage ? <p className="muted">证据覆盖率：{coverage}</p> : null}
      {verification.missingRequirementIds.length > 0 ? (
        <div className="lane-block">
          <p className="kicker">还缺的证据</p>
          <ul className="empty-list">
            {verification.missingRequirementIds.map((id) => (
              <li key={id}>{requirementLabel(id)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p
        className={verification.unsupportedClaimIds.length > 0 ? "compare-note" : "muted"}
        data-testid="unsupported-claims"
      >
        {verification.unsupportedClaimIds.length > 0
          ? `有 ${verification.unsupportedClaimIds.length} 条关键说法没有找到证据支撑（见「Agent 输出」）。`
          : "Agent 的关键说法都有证据支撑。"}
      </p>
      {verification.prematureCompletion ? (
        <p className="check fail" data-testid="premature-completion">
          Agent 在证据仍不完整时结束了调查。
        </p>
      ) : null}

      <div className="lane-block" data-testid="findings-block">
        <p className="kicker">调查发现</p>
        {view.findings.length === 0 ? (
          <p className="empty">这次调查还没有可展示的调查发现。</p>
        ) : (
          <ul className="finding-list">
            {view.findings.map((finding) => (
              <li key={finding.id} className={finding.tone}>
                <span>{finding.tone === "pass" ? "✓" : "·"}</span>
                <span>{finding.text}</span>
                {finding.evidenceIds.length > 0 ? (
                  <button
                    type="button"
                    className="chip"
                    data-testid={`finding-evidence-${finding.id}`}
                    onClick={() => onShowEvidence(finding.evidenceIds)}
                  >
                    查看证据
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {view.openQuestions.length > 0 ? (
        <div className="lane-block" data-testid="open-questions-block">
          <p className="kicker">❓ 待确认事项</p>
          <ul className="empty-list">
            {view.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.agent.resolutionAnalyses.length > 0 ? (
        <div className="lane-block" data-testid="resolution-analysis">
          <p className="kicker">🧩 代码变更分析（Agent 推断，非 Harness 验证结果）</p>
          {view.agent.resolutionAnalyses.map((analysis) => (
            <div key={analysis.candidateEvidenceId} className="analysis-card">
              {analysis.mergeCommitSha ? (
                <p className="muted mono">merge commit {analysis.mergeCommitSha.slice(0, 12)}</p>
              ) : null}
              <div className="analysis-field">
                <p className="kicker">代码关联性</p>
                <AnalysisText value={analysis.codeRelevance} />
              </div>
              <div className="analysis-field">
                <p className="kicker">行为对应关系</p>
                <AnalysisText value={analysis.behavioralAlignment} />
              </div>
              <div className="analysis-field">
                <p className="kicker">测试支持</p>
                <AnalysisText value={analysis.testSupport} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      </div>
    </details>
  );
}
