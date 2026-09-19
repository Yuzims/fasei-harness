import { useEffect, useState, type FormEvent } from "react";
import { ApiError, fetchInvestigationCatalog, runInvestigation } from "../api/client";
import { AdvancedInfo } from "../components/AdvancedInfo";
import { AgentOutput } from "../components/AgentOutput";
import { EvidencePanel } from "../components/EvidencePanel";
import { FailureRecoveryPanel } from "../components/FailureRecoveryPanel";
import { AgentHarnessCompare, VerificationChecks, VerificationSummary } from "../components/VerificationPanel";
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

const WORKFLOW_STEPS = ["Issue", "调查", "证据", "独立验证", "结果"] as const;
const OUTCOMES = ["verified_complete", "not_verified", "insufficient_evidence"] as const;
const EMPTY_RESULT_ITEMS = ["调查结果（来自 Harness 独立验证）", "Agent 调查结论与过程", "Harness 独立验证"] as const;

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

  return (
    <div className="page">
      <section className="panel">
        <div className="hero-head">
          <h2 className="page-title">GitHub Issue 调查</h2>
          <span className={`mode-badge ${mode}`} title={investigationModeDetail(mode)}>
            <span className="mode-dot" />
            {investigationModeLabel(mode)}
          </span>
        </div>
        <p className="hero-copy">让 Agent 调查 Issue，并由 Harness 独立验证结果。</p>
        <form className="issue-form" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="issue-url">
            GitHub Issue 地址
          </label>
          <div className="issue-row">
            <input
              id="issue-url"
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
              placeholder="例如：https://github.com/microsoft/vscode/issues/258694"
              aria-label="GitHub Issue 地址"
            />
            <button className="primary" type="submit" disabled={phase === "running" || !issue.trim()}>
              {phase === "running" ? "调查中…" : "开始调查"}
            </button>
          </div>
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
          <h2 className="section-heading">试试示例</h2>
          <p className="muted">以下示例使用已录制的 GitHub 数据，便于复现。最终是否完成由独立验证决定。</p>
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
            <summary>显示全部示例</summary>
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
            <summary className="muted">开发者场景</summary>
            <p className="kicker" style={{ marginTop: 14 }}>
              夹具
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
              恢复场景
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
        <section className="panel">
          <h2 className="section-heading">怎么看结果</h2>
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
          <p className="muted proof-note">Agent 的结论不会作为完成证明。</p>
          {phase !== "failed" ? (
            <div className="empty-state">
              <p className="empty-lead">输入 GitHub Issue 地址后开始调查。</p>
              <p className="muted">调查结束后将显示：</p>
              <ul className="empty-list">
                {EMPTY_RESULT_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {phase === "running" ? (
        <section className="panel" aria-live="polite">
          <p className="empty-lead">正在调查 GitHub Issue…</p>
          <p className="muted">正在获取证据，并由 Harness 独立验证。</p>
        </section>
      ) : null}

      {session ? (
        <>
          <VerificationSummary session={session} />
          <AgentHarnessCompare session={session} />
          <div className="split lanes">
            <AgentOutput session={session} />
            <VerificationChecks session={session} />
          </div>
          <FailureRecoveryPanel session={session} />
          <EvidencePanel session={session} />
          <AdvancedInfo session={session} />
        </>
      ) : null}
    </div>
  );
}
