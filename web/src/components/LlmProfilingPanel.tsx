import type { InvestigationSessionDTO, LlmCallDTO } from "@dto";

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "不可用" : value.toLocaleString("zh-CN");
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "不可用" : `${(value * 100).toFixed(2)}%`;
}

export function LlmProfilingPanel({ session }: { session: InvestigationSessionDTO }) {
  const usage = session.llmUsage;
  if (!usage) {
    return null;
  }

  return (
    <section className="panel" data-testid="llm-profiling">
      <h2>LLM Calls</h2>
      <p className="muted">提供方上报的 token 用量，以及本地上下文规模估计。estimatedInputTokens 不是提供方用量。</p>
      <div className="metric-grid">
        <div className="metric">
          <p className="kicker">模型</p>
          <p className="mono">{usage.model ?? "不可用"}</p>
        </div>
        <div className="metric">
          <p className="kicker">调用次数</p>
          <p className="mono">{usage.llmCalls}</p>
        </div>
        <div className="metric">
          <p className="kicker">缓存命中率</p>
          <p className="mono">{formatRate(usage.overallCacheHitRate)}</p>
        </div>
      </div>
      <div className="metric-grid" style={{ marginTop: 10 }}>
        <div className="metric">
          <p className="kicker">输入 token</p>
          <p className="mono">{formatCount(usage.totalInputTokens)}</p>
        </div>
        <div className="metric">
          <p className="kicker">缓存输入</p>
          <p className="mono">{formatCount(usage.totalCachedInputTokens)}</p>
        </div>
        <div className="metric">
          <p className="kicker">输出 token</p>
          <p className="mono">{formatCount(usage.totalOutputTokens)}</p>
        </div>
      </div>
      <p className="muted mono" style={{ marginTop: 10 }}>
        合计 {formatCount(usage.totalTokens)} · 平均输入 {formatCount(usage.averageInputTokensPerCall)} · 平均输出{" "}
        {formatCount(usage.averageOutputTokensPerCall)}
      </p>
      <h3 className="kicker" style={{ marginTop: 16 }}>
        Context Profile
      </h3>
      {usage.calls.length === 0 ? (
        <p className="muted">没有 LLM 调用。token 字段保持不可用。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table context-profile" data-testid="llm-context-profile">
            <thead>
              <tr>
                <th>调用</th>
                <th>轮次</th>
                <th>步骤</th>
                <th>历史</th>
                <th>消息</th>
                <th>工具</th>
                <th>估计输入</th>
                <th>输入</th>
                <th>缓存</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {usage.calls.map((call) => (
                <ContextProfileRow key={call.callId} call={call} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ContextProfileRow({ call }: { call: LlmCallDTO }) {
  const context = call.context;
  return (
    <tr>
      <td>{call.callIndex}</td>
      <td>{formatCount(call.attempt)}</td>
      <td>{formatCount(call.agentStep)}</td>
      <td>{formatCount(call.historyLength)}</td>
      <td>{formatCount(context?.serializedMessagesChars)}</td>
      <td>{formatCount(context?.serializedToolsChars)}</td>
      <td>{formatCount(context?.estimatedTotalInputTokens ?? call.estimatedInputTokens)}</td>
      <td>{formatCount(call.usage.inputTokens)}</td>
      <td>{formatCount(call.usage.cachedInputTokens)}</td>
      <td>{formatCount(call.usage.outputTokens)}</td>
    </tr>
  );
}
