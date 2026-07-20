const DEFAULT_CONFIG = Object.freeze({
  apiBase: "",
  snapshotPath: "/api/v1/snapshot",
  fallbackUrl: "data/live.json",
  requestTimeoutMs: 4500,
});

let configPromise;

async function readJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadRuntimeConfig() {
  if (!configPromise) {
    configPromise = readJson("data/runtime-config.json", { timeoutMs: 2000 })
      .catch(() => ({}))
      .then((config) => ({ ...DEFAULT_CONFIG, ...config }));
  }
  return configPromise;
}

export async function loadLiveSnapshot() {
  const config = await loadRuntimeConfig();
  if (config.apiBase) {
    const endpoint = new URL(config.snapshotPath, `${config.apiBase.replace(/\/$/, "")}/`).toString();
    try {
      const snapshot = await readJson(endpoint, { timeoutMs: config.requestTimeoutMs });
      return { snapshot, transport: "api", endpoint };
    } catch (error) {
      console.warn("Live API unavailable; using published snapshot", error);
    }
  }
  return {
    snapshot: await readJson(config.fallbackUrl, { timeoutMs: config.requestTimeoutMs }),
    transport: "static-fallback",
    endpoint: config.fallbackUrl,
  };
}

