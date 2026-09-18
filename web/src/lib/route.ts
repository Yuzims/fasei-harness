export type View = "investigate" | "benchmarks";

export interface Route {
  view: View;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "").replace(/^\//, "");
  const [view] = raw.split("/").filter(Boolean);
  if (view === "benchmarks" || view === "benchmark") {
    return { view: "benchmarks" };
  }
  return { view: "investigate" };
}

export function toHash(route: Route): string {
  return route.view === "benchmarks" ? "#/benchmarks" : "#/";
}

export function navigate(route: Route) {
  const next = toHash(route);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}
