import { useEffect, useState, type FormEvent } from "react";
import { ApiError, fetchInvestigationCatalog, runInvestigationStream } from "../api/client";
import { AdvancedInfo } from "../components/AdvancedInfo";
import { AgentOutputFold } from "../components/AgentOutput";
import { EvidencePanel } from "../components/EvidencePanel";
import { InvestigationProcessPanel } from "../components/InvestigationProcessPanel";
import { ResultHero, tailPhaseNumbers } from "../components/ResultHero";
import { VerificationDetailsFold } from "../components/VerificationDetailsFold";
import {
  applyLiveStreamEvent,
  emptyLiveStreamState,
  type LiveStreamState,
} from "../lib/investigation-stream";
import { buildInvestigationResultView } from "../lib/investigation-presentation";
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
const EMPTY_RESULT_ITEMS = [
  "结果判定卡：结论 → 为什么 → 还差什么（以 Harness 独立验证为准）",
  "证据：调查收集到的 GitHub 原始记录",
  "验证明细：逐项证据检查、调查发现、待确认事项",
  "Agent 输出：Agent 的结论与关键说法（未验证输入）",
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
  const [focusEvidenceIds, setFocusEvidenceIds] = useState<string[]>([]);
  const [liveState, setLiveState] = useState<LiveStreamState>(emptyLiveStreamState());
  const mode = session ? investigationMode(session) : requestedMode;
  const result = session ? buildInvestigationResultView(session) : undefined;

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
    setFocusEvidenceIds([]);
    setLiveState(emptyLiveStreamState());
    setRequestedMode(body.mode === "snapshot" || body.caseId || body.scenarioId ? "snapshot" : "live");
    try {
      await runInvestigationStream(body, (event) => {
        if (event.type === "done") {
          setSession(event.session);
          setPhase("completed");
          return;
        }
        if (event.type === "error") {
          setError({ message: event.message });
          setPhase("failed");
          return;
        }
        setLiveState((current) => applyLiveStreamEvent(current, event));
      });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      setError((current) => current ?? { status, code, message });
      setPhase((current) => (current === "running" ? "failed" : current));
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

      {phase === "running" ? <InvestigationProcessPanel live={{ state: liveState }} /> : null}

      {session && result ? (
        <>
          <ResultHero view={result}>
            <EvidencePanel
              evidence={result.evidence}
              focusEvidenceIds={focusEvidenceIds}
              num={tailPhaseNumbers(result).evidence}
            />
            <VerificationDetailsFold
              view={result}
              num={tailPhaseNumbers(result).verification}
              onShowEvidence={(evidenceIds) => setFocusEvidenceIds([...evidenceIds])}
            />
            <AgentOutputFold view={result} num={tailPhaseNumbers(result).agent} />
          </ResultHero>
          <AdvancedInfo session={session} view={result} />
        </>
      ) : null}
    </div>
  );
}
