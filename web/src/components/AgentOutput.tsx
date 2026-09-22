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

export function AgentAnswerPanel({ view }: { view: InvestigationResultViewModel }) {
  const { agent } = view;
  const isRealAnswer = agent.conclusionSource === "agent_report";

  return (
    <section
      className="panel lane lane-agent"
      data-testid={isRealAnswer ? "agent-answer-panel" : "system-notice-panel"}
    >
      <h2 className="section-heading">🤖 {isRealAnswer ? "Agent 原始回答" : "系统说明"}</h2>
      {isRealAnswer ? (
        <>
          <p className="panel-sub">以下内容是 Agent 的原始回答，属于未验证输入，不是 Harness 的独立验证结果。</p>
          <div className="lane-block" data-testid="agent-conclusion">
            <p className="lane-lead">{agent.conclusion}</p>
          </div>
          <div className="lane-block" data-testid="agent-judgment">
            <p className="kicker">调查判断</p>
            <p className="lane-lead">{agent.judgment}</p>
            <p className="muted">{agent.judgmentNote}</p>
            {agent.disagreesWithHarness ? (
              <p className="compare-note">该判断与 Harness 独立验证结果不同，两者都会保留。</p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="lane-lead">{agent.conclusion}</p>
      )}

      {agent.resolutionAnalyses.length > 0 ? (
        <div className="lane-block" data-testid="resolution-analysis">
          <h3 className="section-heading">🧩 代码变更分析（Agent 推断）</h3>
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
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
