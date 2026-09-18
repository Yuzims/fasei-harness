import type { InvestigationSessionDTO, LlmCallDTO } from "@dto";

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : value.toLocaleString("en-US");
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : `${(value * 100).toFixed(2)}%`;
}

function CallRecord({ call }: { call: LlmCallDTO }) {
  return (
    <article className="llm-call">
      <p className="kicker">Call #{call.callIndex}</p>
      <p className="muted mono">
        attempt {formatCount(call.attempt)} · step {formatCount(call.agentStep)} · history{" "}
        {formatCount(call.historyLength)}
      </p>
      <p className="muted mono">
        input {formatCount(call.usage.inputTokens)} · cached {formatCount(call.usage.cachedInputTokens)} ·
        output {formatCount(call.usage.outputTokens)} · total {formatCount(call.usage.totalTokens)} ·{" "}
        {call.durationMs}ms
      </p>
      <p className="muted mono">
        estimatedInputTokens {formatCount(call.estimatedInputTokens)} · chars{" "}
        {formatCount(call.serializedRequestChars)}
      </p>
    </article>
  );
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
      {usage.calls.map((call) => (
        <CallRecord key={call.callId} call={call} />
      ))}
    </section>
  );
}
