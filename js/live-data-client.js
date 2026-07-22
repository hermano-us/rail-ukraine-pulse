const DEFAULT_CONFIG = Object.freeze({
  apiBase: "",
  snapshotPath: "/api/v1/snapshot",
  historyPath: "/api/v1/history",
  streamPath: "/api/v1/stream",
  fallbackUrl: "data/live.json",
  requestTimeoutMs: 4500,
  refreshIntervalMs: 30_000,
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

export async function loadRunHistory(runId, options = {}) {
  const config = await loadRuntimeConfig();
  if (!config.apiBase || !runId) return { runId, snapshots: [], count: 0, transport: "unavailable" };
  const endpoint = new URL(config.historyPath, `${config.apiBase.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("runId", runId);
  endpoint.searchParams.set("limit", String(options.limit || 192));
  if (options.since) endpoint.searchParams.set("since", options.since);
  try {
    return { ...(await readJson(endpoint, { timeoutMs: config.requestTimeoutMs })), transport: "api" };
  } catch (error) {
    console.warn("Server history unavailable; using browser history", error);
    return { runId, snapshots: [], count: 0, transport: "browser-fallback" };
  }
}

export async function subscribeToLiveUpdates(onSnapshot, onState = () => {}) {
  const config = await loadRuntimeConfig();
  if (!config.apiBase || typeof EventSource === "undefined") {
    onState("polling");
    return () => {};
  }

  const endpoint = new URL(config.streamPath, `${config.apiBase.replace(/\/$/, "")}/`).toString();
  const stream = new EventSource(endpoint);
  stream.addEventListener("open", () => onState("streaming"));
  stream.addEventListener("snapshot", (event) => {
    try { onSnapshot(JSON.parse(event.data)); }
    catch (error) { console.warn("Invalid live stream event", error); }
  });
  stream.addEventListener("error", () => onState("reconnecting"));
  return () => stream.close();
}
