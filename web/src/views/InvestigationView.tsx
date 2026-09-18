import { useEffect, useState, type FormEvent } from "react";
import {
  fetchInvestigationCatalog,
  fetchRealV1Benchmark,
  runInvestigation,
} from "../api/client";
import type {
  InvestigationCatalogDTO,
  InvestigationCatalogItemDTO,
  InvestigationSessionDTO,
} from "@dto";

type RealV1Result = Awaited<ReturnType<typeof fetchRealV1Benchmark>>;

function issueText(item: Pick<InvestigationCatalogItemDTO, "owner" | "repository" | "issueNumber">) {
  return `${item.owner}/${item.repository}#${item.issueNumber}`;
}

function statusClass(status?: string) {
  if (status === "verified_complete" || status === "pass") {
    return "pass";
  }
  if (status === "not_verified" || status === "fail") {
    return "fail";
  }
  return "";
}

export function InvestigationView() {
  const [catalog, setCatalog] = useState<InvestigationCatalogDTO>();
  const [benchmark, setBenchmark] = useState<RealV1Result>();
  const [issue, setIssue] = useState("microsoft/vscode#258694");
  const [session, setSession] = useState<InvestigationSessionDTO>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([fetchInvestigationCatalog(), fetchRealV1Benchmark().catch(() => undefined)])
      .then(([catalogPayload, benchmarkPayload]) => {
        setCatalog(catalogPayload);
        setBenchmark(benchmarkPayload);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  async function start(body: { issue?: string; caseId?: string; scenarioId?: string }) {
    setLoading(true);
    setError(undefined);
    setSession(undefined);
    try {
      const result = await runInvestigation(body);
      setSession(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void start({ issue });
  }

  const latest = session?.attempts.at(-1);

  return (
    <div className="grid">
      <section className="card">
        <h2>调查 GitHub Issue</h2>
        <p className="muted">
          输入 recorded snapshot 中的 Issue。API 调用现有 Investigation Runtime（Snapshot
          Provider → Agent → Evidence → Independent Verifier → Failure / Recovery）。不使用
          mock 响应，也不调用 live GitHub。
        </p>
        <form onSubmit={onSubmit}>
          <textarea
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            rows={2}
            placeholder="microsoft/vscode#258694"
          />
          <div style={{ marginTop: 12 }}>
            <button className="primary" type="submit" disabled={loading || !issue.trim()}>
              {loading ? "Investigation 运行中…" : "Start Investigation"}
            </button>
          </div>
        </form>
        {error ? <p className="error">{error}</p> : null}
        <div className="kicker" style={{ marginTop: 16 }}>
          Real-v1 snapshots
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {catalog?.snapshots.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              onClick={() => {
                setIssue(issueText(item));
                void start({ caseId: item.id });
              }}
            >
              {item.id} {issueText(item)}
            </button>
          ))}
        </div>
        <div className="kicker" style={{ marginTop: 16 }}>
          Closed-loop recovery scenarios
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {catalog?.recovery.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              onClick={() => void start({ scenarioId: item.id })}
            >
              {item.id}
            </button>
          ))}
        </div>
      </section>

      {session ? (
        <section className="agent-grid">
          <article className="card">
            <h3>Progress / Attempts</h3>
            <p className="muted mono">
              {session.task.owner}/{session.task.repository}#{session.task.issueNumber} ·{" "}
              {session.dataSource} {session.catalogId ?? ""} · actor={session.actor}
            </p>
            {session.attempts.map((attempt) => (
              <div key={attempt.id} className="attempt" style={{ marginTop: 12 }}>
                <div className="kicker">
                  Attempt {attempt.attempt}
                  {attempt.parentAttemptId ? ` ← ${attempt.parentAttemptId}` : ""} ·{" "}
                  {attempt.status ?? "unknown"}
                </div>
                {attempt.strategy ? <p className="muted">strategy: {attempt.strategy}</p> : null}
                {attempt.failureType ? (
                  <p>
                    Failure: {attempt.failureType}
                    {attempt.failureReason ? ` — ${attempt.failureReason}` : ""}
                  </p>
                ) : null}
                {attempt.recoveryAction ? (
                  <p>
                    Recovery: {attempt.recoveryAction}
                    {attempt.recoveryReason ? ` — ${attempt.recoveryReason}` : ""}
                  </p>
                ) : null}
                <p className={`status ${statusClass(attempt.verificationStatus)}`}>
                  Verifier {attempt.verificationStatus ?? "n/a"}
                </p>
              </div>
            ))}
            <details style={{ marginTop: 12 }}>
              <summary>Tool calls</summary>
              <ol className="timeline">
                {session.steps.map((step) => (
                  <li key={`${step.step}-${step.tool}`}>
                    <span className="mono">
                      s{step.step} {step.tool}
                    </span>
                    <span>
                      {step.success ? "ok" : "fail"}
                      {step.reason ? ` · ${step.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          </article>

          <article className="card">
            <h3>Evidence / Claims</h3>
            {session.evidence.map((item) => (
              <div key={item.id} className="hit">
                <span>
                  {item.kind} · {item.summary}
                </span>
                <span className="mono">{item.trust}</span>
              </div>
            ))}
            <div className="kicker" style={{ marginTop: 16 }}>
              Claims
            </div>
            {session.claims.map((claim) => (
              <div key={claim.id} className="hit">
                <span>
                  {claim.critical ? "critical " : ""}
                  {claim.text}
                </span>
                <span className="mono">{claim.polarity}</span>
              </div>
            ))}
          </article>

          <article className="card highlight">
            <p className="kicker">Independent Completion Verifier</p>
            <h3>完成与否不看 Agent 终答</h3>
            <p className={`status ${statusClass(session.verification?.status)}`}>
              {session.verification?.status ?? "no verification"}
            </p>
            {session.verification?.checks.map((check) => (
              <div
                key={check.id}
                className={`check ${check.status === "pass" ? "ok" : "bad"}`}
              >
                {check.status.toUpperCase()} {check.name} · {check.message}
              </div>
            ))}
            {latest?.recoveryAction ? (
              <p className="muted" style={{ marginTop: 12 }}>
                Last recovery: {latest.recoveryAction}
              </p>
            ) : null}
            <div className="kicker" style={{ marginTop: 16 }}>
              Final report
            </div>
            <p>{session.report.conclusion}</p>
            <p className="muted">{session.report.uncertainty}</p>
            {session.report.openQuestions.map((question) => (
              <p key={question} className="muted">
                {question}
              </p>
            ))}
          </article>
        </section>
      ) : (
        <section className="card">
          <p className="muted">
            默认案例 microsoft/vscode#258694 使用 Real-v1 C01 snapshot。Recovery 按钮跑 Phase
            7.3 synthetic closed-loop scenarios。
          </p>
        </section>
      )}

      {benchmark ? (
        <section className="card">
          <h3>Last Real-v1 CLI benchmark</h3>
          <p className="muted">
            {benchmark.dataset} {benchmark.datasetVersion} · {benchmark.timestamp} · 只展示{" "}
            <span className="mono">npm run benchmark:real</span> 已写入的结果，不在页面里重跑评测器。
          </p>
          <p className="muted">
            taskSuccessRate {benchmark.metrics.taskSuccessRate} · recoveryRate{" "}
            {benchmark.metrics.recoveryRate} · avgAttempts {benchmark.metrics.averageAttempts}
          </p>
          {benchmark.cases.map((item) => (
            <div key={item.caseId} className="hit">
              <span>
                {item.caseId} observed={item.observedOutcome} expected={item.expectedOutcome}
              </span>
              <span className={`mono ${item.evaluation.passed ? "status pass" : "status fail"}`}>
                {item.evaluation.passed ? "eval pass" : "eval fail"}
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
