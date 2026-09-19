import type { InvestigationSessionDTO } from "@dto";
import { checkMark } from "../lib/workbench";
import { buildInvestigationResultView, type PresentedAnalysisText } from "../lib/investigation-presentation";

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

export function AgentOutput({ session }: { session: InvestigationSessionDTO }) {
  const view = buildInvestigationResultView(session);
  const { agent } = view;

  return (
    <section className="panel lane lane-agent" data-testid="agent-panel">
      <h2 className="section-heading">🤖 Agent 调查</h2>
      <p className="panel-sub">以下内容来自 Agent 的调查与解释，不是 Harness 的独立验证结果。</p>

      <div className="lane-block" data-testid="agent-conclusion">
        <p className="kicker">调查结论</p>
        <p className="lane-lead">{agent.conclusion}</p>
      </div>

      <div className="lane-block" data-testid="agent-findings">
        <p className="kicker">调查发现</p>
        <ul className="finding-list">
          {agent.findings.map((finding) => (
            <li key={finding.id} className={finding.tone}>
              <span>{checkMark(finding.tone === "fail" ? "fail" : "pass")}</span>
              <span>{finding.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="lane-block" data-testid="agent-judgment">
        <p className="kicker">Agent 判断</p>
        <p className="lane-lead">{agent.judgment}</p>
        <p className="muted">{agent.judgmentNote}</p>
        {agent.disagreesWithHarness ? (
          <p className="compare-note">该判断与 Harness 独立验证结果不同，两者都会保留。</p>
        ) : null}
      </div>

      {agent.unresolvedQuestions.length > 0 ? (
        <div className="lane-block" data-testid="unresolved-questions">
          <p className="kicker">尚未确认</p>
          <ul className="empty-list">
            {agent.unresolvedQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {agent.resolutionAnalyses.length > 0 ? (
        <div className="lane-block" data-testid="resolution-analysis">
          <h3 className="section-heading">🧩 代码变更分析</h3>
          <p className="muted">这是 Agent 对代码变更的分析，不是 Harness 验证结果。</p>
          {agent.resolutionAnalyses.map((analysis) => (
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
              {analysis.unresolvedQuestions.length > 0 ? (
                <div className="analysis-field">
                  <p className="kicker">未解决问题</p>
                  <ul className="empty-list">
                    {analysis.unresolvedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
