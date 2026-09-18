import { useEffect, useState, type FormEvent } from "react";
import { ApiError, fetchInvestigationCatalog, runInvestigation } from "../api/client";
import { AgentOutput } from "../components/AgentOutput";
import { AttemptPanel } from "../components/AttemptPanel";
import { ClaimPanel } from "../components/ClaimPanel";
import { EvidencePanel } from "../components/EvidencePanel";
import { TraceTimeline } from "../components/TraceTimeline";
import { VerificationChecks, VerificationSummary } from "../components/VerificationPanel";
import { investigationErrorTitle, issueRef, type RunPhase } from "../lib/workbench";
import type {
  InvestigationCatalogDTO,
  InvestigationCatalogItemDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
} from "@dto";

function catalogIssue(item: Pick<InvestigationCatalogItemDTO, "owner" | "repository" | "issueNumber">) {
  return issueRef(item);
}

export function InvestigationView() {
  const [catalog, setCatalog] = useState<InvestigationCatalogDTO>();
  const [issue, setIssue] = useState("microsoft/vscode#258694");
  const [session, setSession] = useState<InvestigationSessionDTO>();
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [error, setError] = useState<{ status?: number; message: string }>();

  useEffect(() => {
    fetchInvestigationCatalog()
      .then(setCatalog)
      .catch((err: Error) => setError({ message: err.message, status: err instanceof ApiError ? err.status : undefined }));
  }, []);

  async function start(body: InvestigationRequest) {
    if (phase === "running") {
      return;
    }
    setPhase("running");
    setError(undefined);
    setSession(undefined);
    try {
      const result = await runInvestigation(body);
      setSession(result);
      setPhase("completed");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      setError({ status, message });
      setPhase("failed");
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void start({ issue });
  }

  return (
    <div className="page">
      <section className="panel">
        <h2>Investigate GitHub Issue</h2>
        <form className="issue-form" onSubmit={onSubmit}>
          <input
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            placeholder="owner/repository#123"
            aria-label="GitHub issue"
          />
          <div className="issue-actions">
            <span className="muted">Status: {phase}</span>
            <button className="primary" type="submit" disabled={phase === "running" || !issue.trim()}>
              {phase === "running" ? "Investigating..." : "Investigate"}
            </button>
          </div>
          <p className="muted">Snapshot replay only. No live GitHub calls.</p>
        </form>
        {error ? (
          <div>
            <p className="error">{investigationErrorTitle(error)}</p>
            {error.message && investigationErrorTitle(error) !== error.message ? (
              <p className="muted">{error.message}</p>
            ) : null}
          </div>
        ) : null}
        {catalog ? (
          <details className="catalog-details">
            <summary className="muted">Snapshot catalog</summary>
            <p className="kicker" style={{ marginTop: 14 }}>
              Real-v1 snapshots
            </p>
            <div className="catalog">
              {catalog.snapshots.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  title={item.description}
                  disabled={phase === "running"}
                  onClick={() => {
                    setIssue(catalogIssue(item));
                    void start({ caseId: item.id });
                  }}
                >
                  {item.id} {catalogIssue(item)}
                </button>
              ))}
            </div>
            <p className="kicker" style={{ marginTop: 14 }}>
              Fixtures
            </p>
            <div className="catalog">
              {catalog.fixtures.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  title={item.description}
                  disabled={phase === "running"}
                  onClick={() => {
                    setIssue(catalogIssue(item));
                    void start({ scenarioId: item.id });
                  }}
                >
                  {item.id}
                </button>
              ))}
            </div>
            <p className="kicker" style={{ marginTop: 14 }}>
              Recovery scenarios
            </p>
            <div className="catalog">
              {catalog.recovery.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  title={item.description}
                  disabled={phase === "running"}
                  onClick={() => {
                    setIssue(catalogIssue(item));
                    void start({ scenarioId: item.id });
                  }}
                >
                  {item.id}
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      {phase === "running" ? (
        <section className="panel">
          <p className="empty">Investigating recorded snapshot…</p>
        </section>
      ) : null}

      {session ? (
        <>
          <p className="muted mono">
            {issueRef(session.task)} · {session.dataSource}
            {session.catalogId ? ` · ${session.catalogId}` : ""} · actor={session.actor}
          </p>
          <VerificationSummary session={session} />
          <div className="split">
            <VerificationChecks session={session} />
            <TraceTimeline session={session} />
          </div>
          <EvidencePanel session={session} />
          <ClaimPanel session={session} />
          <AttemptPanel session={session} />
          <AgentOutput session={session} />
        </>
      ) : phase === "idle" ? (
        <section className="panel">
          <p className="empty">
            Enter a recorded GitHub issue to start an investigation. Completion is decided by
            Independent Verification, not by the agent answer.
          </p>
        </section>
      ) : null}
    </div>
  );
}
