const nodes = {
  token: document.querySelector("#admin-token"),
  loginPanel: document.querySelector("#login-panel"),
  loginForm: document.querySelector("#login-form"),
  dashboard: document.querySelector("#dashboard"),
  error: document.querySelector("#login-error"),
  metrics: document.querySelector("#metrics"),
  coverageMetrics: document.querySelector("#coverage-metrics"),
  sourceRows: document.querySelector("#source-rows"),
  eventRows: document.querySelector("#event-rows"),
  updatedAt: document.querySelector("#updated-at"),
  connection: document.querySelector("#connection-badge"),
  systemHero: document.querySelector("#system-hero"),
  systemTitle: document.querySelector("#system-title"),
  systemCaption: document.querySelector("#system-caption"),
  pipelineBadge: document.querySelector("#pipeline-badge"),
  sourceSummary: document.querySelector("#source-summary"),
  storageSummary: document.querySelector("#storage-summary"),
  eventsCaption: document.querySelector("#events-caption"),
  refreshButton: document.querySelector("#refresh-button"),
  intelligenceMetrics: document.querySelector("#intelligence-metrics"),
  quarantineRows: document.querySelector("#quarantine-rows"),
  cycleChart: document.querySelector("#cycle-chart"),
};

let token = sessionStorage.getItem("rail-ops-token") || "";
let endpoint = "/api/admin/overview";
let intelligenceEndpoint = "/api/admin/intelligence";
let refreshTimer;
let requestInFlight = false;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" });
}

function ageMinutes(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 60000)) : null;
}

function formatAge(value) {
  const age = ageMinutes(value);
  if (age == null) return "—";
  if (age < 1) return "только что";
  if (age < 60) return `${age} мин`;
  return `${Math.floor(age / 60)} ч ${age % 60} мин`;
}

function setConnection(label, tone) {
  nodes.connection.dataset.tone = tone;
  nodes.connection.lastChild.textContent = label;
}

function metric(label, value, note, tone = "idle") {
  const card = document.createElement("article");
  card.className = "metric";
  card.dataset.tone = tone;
  const caption = document.createElement("span");
  caption.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value == null ? "—" : String(value);
  const detail = document.createElement("small");
  detail.textContent = note || "";
  card.append(caption, number, detail);
  return card;
}

function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderSources(sources) {
  nodes.sourceRows.replaceChildren();
  if (!sources.length) {
    const row = document.createElement("tr");
    const cell = appendCell(row, "Источники ещё не зарегистрированы", "empty-row");
    cell.colSpan = 5;
    nodes.sourceRows.append(row);
    return;
  }
  for (const source of sources) {
    const row = document.createElement("tr");
    appendCell(row, source.source_id);
    appendCell(row, source.status, `status-pill ${String(source.status || "").toLowerCase()}`);
    appendCell(row, formatAge(source.checked_at));
    appendCell(row, source.records_count);
    appendCell(row, source.error);
    nodes.sourceRows.append(row);
  }
}

function renderEvents(events) {
  nodes.eventRows.replaceChildren();
  if (!events.length) {
    const row = document.createElement("tr");
    const cell = appendCell(row, "События пока не записаны", "empty-row");
    cell.colSpan = 5;
    nodes.eventRows.append(row);
    return;
  }
  for (const event of events) {
    const row = document.createElement("tr");
    appendCell(row, formatDate(event.observedAt));
    appendCell(row, event.trainNumber || event.runId);
    appendCell(row, event.type);
    appendCell(row, event.station);
    appendCell(row, event.sourceId);
    nodes.eventRows.append(row);
  }
}

function render(data) {
  const pipeline = data.pipeline || {};
  const snapshotAge = Number.isFinite(pipeline.snapshotAgeMinutes)
    ? Math.round(pipeline.snapshotAgeMinutes)
    : ageMinutes(data.snapshot?.generatedAt);
  const status = pipeline.status || data.status || "unknown";
  const tone = status === "ok" ? "ok" : status === "degraded" ? "warning" : "error";
  const statusTitle = status === "ok" ? "Контур работает штатно" : status === "degraded" ? "Данные требуют внимания" : "Контур обновления нарушен";
  const activeSources = (data.sources || []).filter((source) => source.status === "online").length;
  const staleSources = (data.sources || []).filter((source) => source.status !== "online").length;

  nodes.systemHero.dataset.tone = tone;
  nodes.systemTitle.textContent = statusTitle;
  nodes.systemCaption.textContent = pipeline.message || `Последний снимок: ${formatDate(data.snapshot?.generatedAt)}`;
  nodes.pipelineBadge.textContent = String(status).toUpperCase();
  nodes.pipelineBadge.className = `tag status-pill ${status}`;
  nodes.sourceSummary.textContent = `${activeSources} активных · ${staleSources} требуют внимания`;
  nodes.storageSummary.textContent = `${data.runs?.total || 0} рейсов · ${data.events?.total || 0} событий`;
  nodes.eventsCaption.textContent = `${(data.recentEvents || []).length} последних записей`;

  nodes.metrics.replaceChildren(
    metric("Рейсы в снимке", data.snapshot?.updates, "Публичная проекция"),
    metric("Рейсы в D1", data.runs?.total, `Последнее событие ${formatAge(data.runs?.latest)}`),
    metric("События", data.events?.total, "Неизменяемый журнал"),
    metric("Возраст снимка", snapshotAge == null ? "—" : `${snapshotAge} мин`, pipeline.freshnessLabel || "Нет оценки", tone),
    metric("Источники online", `${activeSources}/${(data.sources || []).length}`, staleSources ? `${staleSources} требуют проверки` : "Все доступные источники активны", staleSources ? "warning" : "ok"),
  );

  const coverage = data.coverage || {};
  nodes.coverageMetrics.replaceChildren(
    metric("Найдено", coverage.discovered, "Все публичные рейсы"),
    metric("Маршрут определён", coverage.routed, "Начало и назначение"),
    metric("Есть прогноз", coverage.forecasted, "Прибытие или отправление"),
    metric("Станционный факт", coverage.stationAnchored, "Якоря позиционирования", coverage.stationAnchored ? "ok" : "warning"),
    metric("Изучено перегонов", coverage.learnedSegments, "Историческая калибровка"),
    metric("Карантин", coverage.quarantined, "Отклонённые аномалии", coverage.quarantined ? "warning" : "ok"),
  );
  renderSources(data.sources || []);
  renderEvents(data.recentEvents || []);
  nodes.updatedAt.textContent = `Диагностика: ${formatDate(data.checkedAt)}`;
  setConnection("Подключено", tone);
}

function renderIntelligence(data={}) {
  const cycles=data.cycles||[], quarantine=data.quarantine||[], incomplete=data.incompleteRuns||[];
  nodes.cycleChart?.replaceChildren(...cycles.slice().reverse().map(cycle=>{const bar=document.createElement("i");bar.className=cycle.status==="success"?"ok":"error";bar.style.height=`${Math.max(8,Math.min(100,Number(cycle.duration_ms||0)/100))}%`;bar.title=`${formatDate(cycle.started_at)} · ${cycle.status} · ${cycle.duration_ms||0} ms`;return bar;}));
  nodes.intelligenceMetrics?.replaceChildren(metric("Циклы 24ч",cycles.length,"История collector"),metric("Карантин",quarantine.filter(x=>x.status==="open").length,"Требуют решения",quarantine.some(x=>x.status==="open")?"warning":"ok"),metric("Без полного маршрута",incomplete.length,"Нужна геометрия"),metric("Аудит",(data.audit||[]).length,"Административные действия"));
  nodes.quarantineRows?.replaceChildren(...quarantine.slice(0,50).map(item=>{const row=document.createElement("tr");appendCell(row,formatDate(item.observed_at));appendCell(row,item.source_id);appendCell(row,item.train_number);const reason=appendCell(row,item.reasons_json);reason.title=item.raw_update_json||"";appendCell(row,item.status,`status-pill ${item.status}`);const action=document.createElement("td");if(item.status==="open"){const button=document.createElement("button");button.className="secondary";button.textContent="Review";button.addEventListener("click",()=>adminAction({action:"resolve-quarantine",id:item.quarantine_id,resolution:"reviewed-and-dismissed"}).then(refresh));action.append(button);}row.append(action);return row;}));
}
async function adminAction(body){const response=await fetch(intelligenceEndpoint,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Action HTTP ${response.status}`);return response.json();}
async function loadConfig() {
  try {
    const response = await fetch("data/runtime-config.json", { cache: "no-store" });
    const config = await response.json();
    if (config.apiBase) {
      const base = config.apiBase.endsWith("/") ? config.apiBase.slice(0, -1) : config.apiBase;
      endpoint = new URL("/api/admin/overview", `${base}/`).toString();
      intelligenceEndpoint = new URL("/api/admin/intelligence", `${base}/`).toString();
    }
  } catch {}
}

async function refresh() {
  if (requestInFlight || !token) return;
  requestInFlight = true;
  nodes.refreshButton.disabled = true;
  setConnection("Синхронизация", "idle");
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status === 401) throw new Error("Неверный токен администратора");
    if (!response.ok) throw new Error(`Backend ответил HTTP ${response.status}`);
    render(await response.json());
    const intelligence=await fetch(intelligenceEndpoint,{cache:"no-store",headers:{Authorization:`Bearer ${token}`}});if(intelligence.ok)renderIntelligence(await intelligence.json());
    nodes.loginPanel.hidden = true;
    nodes.dashboard.hidden = false;
    nodes.error.textContent = "";
  } catch (error) {
    setConnection("Ошибка связи", "error");
    throw error;
  } finally {
    requestInFlight = false;
    nodes.refreshButton.disabled = false;
  }
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden) refresh().catch((error) => { nodes.systemCaption.textContent = error.message; });
  }, 15_000);
}

async function login(event) {
  event?.preventDefault();
  token = nodes.token.value.trim();
  if (!token) return;
  try {
    await refresh();
    sessionStorage.setItem("rail-ops-token", token);
    nodes.token.value = "";
    startAutoRefresh();
  } catch (error) {
    nodes.error.textContent = error.message;
  }
}

function logout() {
  token = "";
  clearInterval(refreshTimer);
  sessionStorage.removeItem("rail-ops-token");
  nodes.dashboard.hidden = true;
  nodes.loginPanel.hidden = false;
  setConnection("Ожидание", "idle");
}

nodes.loginForm.addEventListener("submit", login);
document.querySelector("#retry-collector")?.addEventListener("click",()=>adminAction({action:"retry-collector"}).then(refresh).catch(error=>{nodes.systemCaption.textContent=error.message;}));
nodes.refreshButton.addEventListener("click", () => refresh().catch((error) => { nodes.systemCaption.textContent = error.message; }));
document.querySelector("#logout-button").addEventListener("click", logout);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token) refresh().catch(() => {});
});

await loadConfig();
if (token) {
  refresh().then(startAutoRefresh).catch(() => {
    sessionStorage.removeItem("rail-ops-token");
    token = "";
  });
}
