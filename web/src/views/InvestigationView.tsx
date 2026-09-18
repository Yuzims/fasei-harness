import { useEffect, useState, type FormEvent } from "react";
import { ApiError, fetchInvestigationCatalog, runInvestigation } from "../api/client";
import { AgentOutput } from "../components/AgentOutput";
import { AttemptPanel } from "../components/AttemptPanel";
import { ClaimPanel } from "../components/ClaimPanel";
import { EvidencePanel } from "../components/EvidencePanel";
import { LlmProfilingPanel } from "../components/LlmProfilingPanel";
import { TraceTimeline } from "../components/TraceTimeline";
import { VerificationChecks, VerificationSummary } from "../components/VerificationPanel";
import {
  catalogRunRequest,
  exampleHeading,
  featuredExamples,
  investigationErrorTitle,
  investigationMode,
  investigationModeDetail,
  investigationModeLabel,
  issueRef,
  verificationLabel,
  verificationSubtitle,
  type RunPhase,
} from "../lib/workbench";
import type {
  InvestigationCatalogDTO,
  InvestigationCatalogItemDTO,
  InvestigationRequest,
  InvestigationSessionDTO,
} from "@dto";

const WORKFLOW_STEPS = ["Issue", "Investigation", "Evidence", "Independent Verification", "Result"] as const;
const OUTCOMES = ["verified_complete", "not_verified", "insufficient_evidence"] as const;
const EMPTY_RESULT_ITEMS = [
  "Verification result",
  "Evidence",
  "Investigation trace",
  "Claims",
  "Failure / recovery history when applicable",
] as const;

function catalogIssue(item: Pick<InvestigationCatalogItemDTO, "owner" | "repository" | "issueNumber">) {
  return issueRef(item);
}

function ExampleCard({
  item,
  disabled,
  onSelect,
}: {
  item: InvestigationCatalogItemDTO;
  disabled: boolean;
  onSelect: (item: InvestigationCatalogItemDTO) => void;
}) {
  return (
    <button
      type="button"
      className="example-card"
      disabled={disabled}
      title={item.description}
      onClick={() => onSelect(item)}
    >
      <strong>{exampleHeading(item)}</strong>
      <span className="muted mono">{catalogIssue(item)}</span>
      <span className="example-id">{item.id}</span>
    </button>
  );
}

export function InvestigationView() {
  const [catalog, setCatalog] = useState<InvestigationCatalogDTO>();
  const [issue, setIssue] = useState("");
  const [session, setSession] = useState<InvestigationSessionDTO>();
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [error, setError] = useState<{ status?: number; message: string; code?: string }>();
  const [requestedMode, setRequestedMode] = useState<"live" | "snapshot">("live");
  const mode = session ? investigationMode(session) : requestedMode;

  useEffect(() => {
    fetchInvestigationCatalog()
      .then(setCatalog)
      .catch((err: Error) =>
        setError({
          message: err.message,
          status: err instanceof ApiError ? err.status : undefined,
          code: err instanceof ApiError ? err.code : undefined,
        }),
      );
  }, []);

  async function start(body: InvestigationRequest) {
    if (phase === "running") {
      return;
    }
    setPhase("running");
    setError(undefined);
    setSession(undefined);
    setRequestedMode(body.mode === "snapshot" || body.caseId || body.scenarioId ? "snapshot" : "live");
    try {
      const result = await runInvestigation(body);
      setSession(result);
      setPhase("completed");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      setError({ status, code, message });
      setPhase("failed");
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void start({ issue, mode: "live" });
  }

  function onSelectExample(item: InvestigationCatalogItemDTO) {
    setIssue(catalogIssue(item));
    void start(catalogRunRequest(item));
  }

  const featured = catalog ? featuredExamples(catalog.snapshots) : [];
  const showOnboarding = !session && phase !== "running";
  const issueTitle = session?.issue.title || session?.issue.summary;

  return (
    <div className="page">
      <section className="panel">
        <div className="hero-head">
          <h2>Investigate a GitHub Issue</h2>
          <span className={`mode-badge ${mode}`} title={investigationModeDetail(mode)}>
            <span className="mode-dot" />
            {investigationModeLabel(mode)}
          </span>
        </div>
        <p className="hero-copy">
          Verify whether an Agent actually resolved a GitHub Issue using independent evidence.
        </p>
        <p className="muted snapshot-note">{investigationModeDetail(mode)}</p>
        <form className="issue-form" onSubmit={onSubmit}>
          <div className="issue-row">
            <input
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
              placeholder="https://github.com/owner/repo/issues/123"
              aria-label="GitHub issue"
            />
            <button className="primary" type="submit" disabled={phase === "running" || !issue.trim()}>
              {phase === "running" ? "Investigating..." : "Investigate"}
            </button>
          </div>
          <p className="muted snapshot-note">Or enter owner/repo#123</p>
        </form>
        {error ? (
          <div className="error-block" role="alert">
            <p className="error">{investigationErrorTitle(error)}</p>
            {error.message && investigationErrorTitle(error) !== error.message ? (
              <p className="muted">{error.message}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      {catalog ? (
        <section className="panel">
          <h2>Try an example</h2>
          <p className="muted">
            Snapshot examples use recorded GitHub data for deterministic evaluation. Completion is decided by
            independent verification.
          </p>
          <div className="example-grid">
            {featured.map((item) => (
              <ExampleCard
                key={item.id}
                item={item}
                disabled={phase === "running"}
                onSelect={onSelectExample}
              />
            ))}
          </div>
          <details className="catalog-details">
            <summary>Show all examples</summary>
            <div className="example-grid example-grid-compact">
              {catalog.snapshots.map((item) => (
                <ExampleCard
                  key={item.id}
                  item={item}
                  disabled={phase === "running"}
                  onSelect={onSelectExample}
                />
              ))}
            </div>
          </details>
          <details className="catalog-details">
            <summary className="muted">Developer scenarios</summary>
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
                  onClick={() => onSelectExample(item)}
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
                  onClick={() => onSelectExample(item)}
                >
                  {item.id}
                </button>
              ))}
            </div>
          </details>
        </section>
      ) : null}

      {showOnboarding ? (
        <>
          <section className="panel">
            <h2>How FASEI works</h2>
            <ol className="workflow">
              {WORKFLOW_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="outcome-legend">
              {OUTCOMES.map((status) => (
                <div key={status} className={`outcome-item ${status}`}>
                  <strong>{verificationLabel(status)}</strong>
                  <span className="muted">{verificationSubtitle(status)}</span>
                </div>
              ))}
            </div>
            <p className="muted proof-note">The Agent's conclusion is not used as proof of completion.</p>
            {phase !== "failed" ? (
              <div className="empty-state">
                <p className="empty-lead">Enter a GitHub Issue to start an investigation.</p>
                <p className="muted">After you investigate, this page will show:</p>
                <ul className="empty-list">
                  {EMPTY_RESULT_ITEMS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {phase === "running" ? (
        <section className="panel" aria-live="polite">
          <p className="empty-lead">Investigating GitHub Issue…</p>
          <p className="muted">Fetching evidence and verifying resolution…</p>
        </section>
      ) : null}

      {session ? (
        <>
          <section className="panel" data-testid="issue-panel">
            <h2>Issue</h2>
            <p className="mono">
              {session.issue.owner}/{session.issue.repository}#{session.issue.number}
            </p>
            {issueTitle ? <p>{issueTitle}</p> : null}
            {session.issue.state ? <p className="muted">State: {session.issue.state}</p> : null}
            {session.issue.url ? (
              <p className="muted mono">{session.issue.url}</p>
            ) : null}
          </section>
          <p className="muted mono">
            {issueRef(session.task)} · {session.mode}
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
          <LlmProfilingPanel session={session} />
          <AgentOutput session={session} />
        </>
      ) : null}
    </div>
  );
}
