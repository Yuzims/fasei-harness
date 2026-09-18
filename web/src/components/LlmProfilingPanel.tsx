import type { InvestigationSessionDTO, LlmCallDTO } from "@dto";

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : value.toLocaleString("en-US");
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : `${(value * 100).toFixed(2)}%`;
}

export function LlmProfilingPanel({ session }: { session: InvestigationSessionDTO }) {
  const usage = session.llmUsage;
  if (!usage) {
    return null;
  }

  return (
    <section className="panel" data-testid="llm-profiling">
      <h2>LLM Profiling</h2>
      <p className="muted">
        Provider-reported token usage and a local context-size estimate. estimatedInputTokens is not
        provider usage.
      </p>
      <div className="metric-grid">
        <div className="metric">
          <p className="kicker">Model</p>
          <p className="mono">{usage.model ?? "unavailable"}</p>
        </div>
        <div className="metric">
          <p className="kicker">Calls</p>
          <p className="mono">{usage.llmCalls}</p>
        </div>
        <div className="metric">
          <p className="kicker">Cache hit rate</p>
          <p className="mono">{formatRate(usage.overallCacheHitRate)}</p>
        </div>
      </div>
      <div className="metric-grid" style={{ marginTop: 10 }}>
        <div className="metric">
          <p className="kicker">Input tokens</p>
          <p className="mono">{formatCount(usage.totalInputTokens)}</p>
        </div>
        <div className="metric">
          <p className="kicker">Cached input</p>
          <p className="mono">{formatCount(usage.totalCachedInputTokens)}</p>
        </div>
        <div className="metric">
          <p className="kicker">Output tokens</p>
          <p className="mono">{formatCount(usage.totalOutputTokens)}</p>
        </div>
      </div>
      <p className="muted mono" style={{ marginTop: 10 }}>
        total {formatCount(usage.totalTokens)} · avg input {formatCount(usage.averageInputTokensPerCall)} ·
        avg output {formatCount(usage.averageOutputTokensPerCall)}
      </p>
      <h3 className="kicker" style={{ marginTop: 16 }}>
        Context Profile
      </h3>
      {usage.calls.length === 0 ? (
        <p className="muted">No LLM calls. Token fields stay unavailable.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table context-profile" data-testid="llm-context-profile">
            <thead>
              <tr>
                <th>Call</th>
                <th>Attempt</th>
                <th>Step</th>
                <th>History</th>
                <th>Messages</th>
                <th>Tools</th>
                <th>Est. Input</th>
                <th>Input</th>
                <th>Cached</th>
                <th>Output</th>
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
