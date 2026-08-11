const DEFAULT_CONFIG = Object.freeze({
  apiBase: "",
  snapshotPath: "/api/v1/snapshot",
  historyPath: "/api/v1/history",
  timelinePath: "/api/v1/timeline",
  streamPath: "/api/v1/stream",
  freightPath: "/api/v1/freight/public",
  railRoutesPath: "/api/v1/rail-routes",
  fallbackUrl: "data/live.json",
  freightFallbackUrl: "data/freight-aggregates.json",
  requestTimeoutMs: 4500,
  refreshIntervalMs: 30_000,
});

let configPromise;
const publicRailRouteCache=new Map();
let publicRailRouteVersion=null;

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

export async function loadFreightSnapshot() {
  const config = await loadRuntimeConfig();
  if (config.apiBase) {
    const endpoint = new URL(config.freightPath, `${config.apiBase.replace(/\/$/, "")}/`).toString();
    try {
      const snapshot = await readJson(endpoint, { timeoutMs: config.requestTimeoutMs });
      return { snapshot, transport: "api", endpoint };
    } catch (error) {
      console.warn("Public freight projection unavailable; using safe static fallback", error);
    }
  }
  try {
    return { snapshot: await readJson(config.freightFallbackUrl, { timeoutMs: config.requestTimeoutMs }), transport: "static-fallback", endpoint: config.freightFallbackUrl };
  } catch {
    return { snapshot: { schemaVersion: 2, objects: [], corridors: [], sourceStatus: { status: "unavailable", label: "Грузовой слой временно недоступен" } }, transport: "unavailable", endpoint: null };
  }
}

export function publicRailRouteKey(item={}){return `v2|${item.trainNumber||""}|${item.origin||""}|${item.destination||""}|${item.serviceDate||"undated"}`;}

export async function loadPublicRailRoutes(updates = [], { force = false } = {}) {
  const config=await loadRuntimeConfig();
  if(!config.apiBase||!updates.length)return {routes:[],transport:"unavailable"};
  const endpoint=new URL(config.railRoutesPath||"/api/v1/rail-routes",`${config.apiBase.replace(/\/$/,"")}/`).toString();
  const now=Date.now(),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(7000,Number(config.requestTimeoutMs)||4500));
  try{
    const descriptors=[...new Map(updates.filter((item)=>item?.origin&&item?.destination).sort((left,right)=>Number(right.operationalStatus==="moving")-Number(left.operationalStatus==="moving")||Number(Boolean(right.reportedStation))-Number(Boolean(left.reportedStation))).map((item)=>{const key=publicRailRouteKey(item);return [key,{key,trainNumber:item.trainNumber,origin:item.origin,destination:item.destination,reportedStation:item.reportedStation||null,serviceDate:item.serviceDate||null,runId:item.runId||null}];})).values()];
    const pending=descriptors.filter((item)=>force||(publicRailRouteCache.get(item.key)?.expiresAt||0)<=now).slice(0,20);
    if(!pending.length)return {routes:descriptors.map((item)=>publicRailRouteCache.get(item.key)?.route).filter(Boolean),versionId:publicRailRouteVersion,transport:"memory-cache"};
    const response=await fetch(endpoint,{method:"POST",cache:"no-store",signal:controller.signal,headers:{Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({routes:pending})});
    if(!response.ok)throw new Error(`${endpoint}: HTTP ${response.status}`);
    const payload=await response.json();if(payload.versionId&&publicRailRouteVersion&&payload.versionId!==publicRailRouteVersion)publicRailRouteCache.clear();publicRailRouteVersion=payload.versionId||publicRailRouteVersion;
    for(const route of payload.routes||[])publicRailRouteCache.set(route.key,{route,expiresAt:now+(route.status==="ready"?5*60_000:2*60_000)});
    return {...payload,routes:descriptors.map((item)=>publicRailRouteCache.get(item.key)?.route).filter(Boolean),transport:"api"};
  }catch(error){console.warn("OSM rail route service unavailable; verified geometry remains unavailable",error);return {routes:updates.map((item)=>publicRailRouteCache.get(publicRailRouteKey(item))?.route).filter(Boolean),versionId:publicRailRouteVersion,transport:"fallback",error:String(error?.message||error)};}
  finally{clearTimeout(timeout);}
}

export async function loadRunHistory(runId, options = {}) {
  const config = await loadRuntimeConfig();
  if (!config.apiBase || !runId) return { runId, snapshots: [], count: 0, transport: "unavailable" };
  const endpoint = new URL(config.historyPath, `${config.apiBase.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("runId", runId);
  endpoint.searchParams.set("limit", String(options.limit || 672));
  if (options.since) endpoint.searchParams.set("since", options.since);
  try {
    return { ...(await readJson(endpoint, { timeoutMs: config.requestTimeoutMs })), transport: "api" };
  } catch (error) {
    console.warn("Server history unavailable; using browser history", error);
    return { runId, snapshots: [], count: 0, transport: "browser-fallback" };
  }
}

export async function loadMapTimeline(at) {
  const config = await loadRuntimeConfig();
  if (!config.apiBase) return { at, snapshots: [], count: 0, transport: "unavailable" };
  const endpoint = new URL(config.timelinePath || "/api/v1/timeline", `${config.apiBase.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("at", new Date(at).toISOString());
  try {
    return { ...(await readJson(endpoint, { timeoutMs: config.requestTimeoutMs })), transport: "api" };
  } catch (error) {
    console.warn("Global timeline unavailable", error);
    return { at, snapshots: [], count: 0, transport: "unavailable", error: String(error?.message || error) };
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
