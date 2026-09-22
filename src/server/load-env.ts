import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(filePath = ".env"): void {
  if (!existsSync(filePath)) {
    return;
  }

  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Node >= 24 global fetch only honors HTTPS_PROXY/NO_PROXY when
 * NODE_USE_ENV_PROXY is set, and the dispatcher is created lazily on the
 * first fetch, so calling this at process bootstrap is enough.
 */
export function enableEnvProxyForFetch(): void {
  process.env.NODE_USE_ENV_PROXY ??= "1";
}
