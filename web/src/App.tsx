import { useEffect, useState } from "react";
import { BenchmarkView } from "./views/BenchmarkView";
import { InvestigationView } from "./views/InvestigationView";
import { navigate, parseHash, type Route } from "./lib/route";

const NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "investigate", label: "Investigations" },
  { view: "benchmarks", label: "Benchmarks" },
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
          <span className="brand-mark">FASEI</span>
          <span className="brand-sub">Investigation Workbench</span>
        </div>
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
        <div className="topbar-right">
          <span className="mode-badge" title="Deterministic recorded GitHub data">
            <span className="mode-dot" />
            Snapshot Mode
          </span>
        </div>
      </header>
      {route.view === "benchmarks" ? <BenchmarkView /> : <InvestigationView />}
    </div>
  );
}
