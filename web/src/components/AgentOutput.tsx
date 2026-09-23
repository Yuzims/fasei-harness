import type { InvestigationResultViewModel } from "../lib/investigation-presentation";

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function AgentOutputFold({ view, num }: { view: InvestigationResultViewModel; num: number }) {
  const { agent } = view;
  const isRealAnswer = agent.conclusionSource === "agent_report";
  const unsupportedCount = agent.claims.filter((claim) => !claim.supported).length;

  return (
    <details className="phase" data-testid="agent-output-fold">
      <summary className="phase-head">
        <span className="phase-num">{num}</span>
        Agent 输出（未验证输入）
        <span className="tag">（点击展开）</span>
      </summary>
      <div className="phase-body">
      <p className="muted">
        {isRealAnswer
          ? "以下是 Agent 自己的回答与说法清单，属于未验证输入，不是 Harness 的独立验证结果。"
          : agent.conclusion}
      </p>

      {isRealAnswer ? (
        <>
          <div className="lane-block" data-testid="agent-conclusion">
            <p className="kicker">Agent 结论</p>
            <p className="lane-lead">{agent.originalConclusion || agent.conclusion}</p>
            <p className="compare-note" data-testid="agent-disagree">
              {agent.disagreesWithHarness
                ? "该判断与 Harness 独立验证结果不同，两者都会保留；以独立验证为准。"
                : agent.judgmentNote}
            </p>
          </div>

          <div className="lane-block" data-testid="agent-claims">
            <p className="kicker">关键说法（{agent.claims.length}）</p>
            {agent.claims.length === 0 ? (
              <p className="empty">这次调查没有产生关键说法。</p>
            ) : (
              <ul className="claim-list">
                {agent.claims.map((claim) => (
                  <li key={claim.id} className={claim.supported ? "pass" : "fail"}>
                    <span>{claim.supported ? "✓" : "✗"}</span>
                    <span>
                      {claim.critical ? "【关键】" : ""}
                      {claim.text}
                      {claim.supported ? "" : "（未找到证据支撑）"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {unsupportedCount > 0 ? (
              <p className="muted">✗ 的说法没有证据支撑，不代表说法错误，只代表当前证据不足以确认。</p>
            ) : null}
          </div>

          {view.rawAgentOutput ? (
            <details className="inner-fold">
              <summary>原始回答（JSON 已格式化）</summary>
              <pre className="raw-block">{prettyJson(view.rawAgentOutput)}</pre>
            </details>
          ) : null}
        </>
      ) : null}
      </div>
    </details>
  );
}
