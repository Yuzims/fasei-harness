export type View = "investigate" | "agent" | "overview" | "run" | "benchmark" | "retrieval";

export interface Route {
  view: View;
  scenarioId?: string;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "").replace(/^\//, "");
  const [view, scenarioId] = raw.split("/").filter(Boolean);
  if (view === "run" || view === "inject") {
    return { view: "run", scenarioId };
  }
  if (view === "lab" || view === "overview") {
    return { view: "overview" };
  }
  if (view === "agent") {
    return { view: "agent" };
  }
  if (view === "benchmark" || view === "retrieval") {
    return { view };
  }
  return { view: "investigate" };
}

export function toHash(route: Route): string {
  if (route.view === "investigate") {
    return "#/";
  }
  if (route.view === "overview") {
    return "#/lab";
  }
  if (route.view === "run") {
    return route.scenarioId ? `#/run/${route.scenarioId}` : "#/run";
  }
  return `#/${route.view}`;
}

export function navigate(route: Route) {
  const next = toHash(route);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}
