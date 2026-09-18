import { useEffect, useState } from "react";
import { AgentView } from "./views/AgentView";
import { BenchmarkView } from "./views/BenchmarkView";
import { InvestigationView } from "./views/InvestigationView";
import { OverviewView } from "./views/OverviewView";
import { RetrievalView } from "./views/RetrievalView";
import { RunView } from "./views/RunView";
import { navigate, parseHash, type Route, type View } from "./lib/route";

const NAV: Array<{ view: View; label: string }> = [
  { view: "investigate", label: "Investigation" },
  { view: "agent", label: "工作台" },
  { view: "overview", label: "评测" },
  { view: "run", label: "注入失败" },
  { view: "benchmark", label: "对照" },
  { view: "retrieval", label: "检索" },
];

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <small>FASEI Harness</small>
          <h1>Failure-Aware Investigation</h1>
          <p className="muted">
            调查 GitHub Issue。Agent 收集证据，Independent Verifier 判定完成。失败按类型恢复，而不是统一 Retry。
          </p>
        </div>
        <div className="layers">
          <span>React UI</span>
          <span>Hono API</span>
          <span>Investigation Runtime</span>
        </div>
      </header>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.view}
            className={route.view === item.view ? "active" : ""}
            onClick={() => navigate({ view: item.view })}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {route.view === "investigate" ? <InvestigationView /> : null}
      {route.view === "agent" ? <AgentView /> : null}
      {route.view === "overview" ? <OverviewView /> : null}
      {route.view === "run" ? <RunView scenarioId={route.scenarioId} /> : null}
      {route.view === "benchmark" ? <BenchmarkView /> : null}
      {route.view === "retrieval" ? <RetrievalView /> : null}
    </div>
  );
}
