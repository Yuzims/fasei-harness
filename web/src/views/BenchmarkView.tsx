import { useEffect, useState } from "react";
import { fetchRealV1Benchmark, type RealV1BenchmarkDTO } from "../api/client";
import { formatMetric, humanizeKey, outcomeLabel, verificationTone } from "../lib/workbench";

export function BenchmarkView() {
  const [result, setResult] = useState<RealV1BenchmarkDTO>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchRealV1Benchmark()
      .then(setResult)
      .catch((err: Error) => setError(err.message));
  }, []);

  const metrics = result ? Object.entries(result.metrics) : [];

  return (
    <div className="page">
      <section className="panel">
        <h2>Real-v1</h2>
        {result ? (
          <p className="muted">
            {result.dataset} {result.datasetVersion} · {result.cases.length} Cases · Snapshot Dataset
            · {result.timestamp}
          </p>
        ) : error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="empty">Loading latest Real-v1 CLI result…</p>
        )}
      </section>

      {metrics.length > 0 ? (
        <section className="metric-grid">
          {metrics.map(([key, value]) => (
            <article key={key} className="metric">
              <div className="kicker">{humanizeKey(key)}</div>
              <div className="metric-value">{formatMetric(key, value)}</div>
            </article>
          ))}
        </section>
      ) : null}

      {result?.cases.length ? (
        <section className="panel">
          <h2>Cases</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Expected</th>
                  <th>Observed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {result.cases.map((item) => (
                  <tr key={item.caseId}>
                    <td className="mono">{item.caseId}</td>
                    <td className={`status-text ${verificationTone(item.expectedOutcome)}`}>
                      {outcomeLabel(item.expectedOutcome)}
                    </td>
                    <td className={`status-text ${verificationTone(item.observedOutcome)}`}>
                      {outcomeLabel(item.observedOutcome)}
                    </td>
                    <td className={item.evaluation.passed ? "status-text pass" : "status-text fail"}>
                      {item.evaluation.passed ? "pass" : "fail"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
