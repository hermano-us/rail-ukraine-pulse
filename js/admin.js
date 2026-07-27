const loginCard = document.querySelector("#login-form");
const accountLoginLabel = document.createElement("label");
accountLoginLabel.htmlFor = "account-login";
accountLoginLabel.textContent = "Логин сотрудника (для ролевого доступа)";
const accountLoginInput = document.createElement("input");
accountLoginInput.id = "account-login"; accountLoginInput.autocomplete = "username";
accountLoginInput.placeholder = "Например: curator.kyiv";
loginCard.querySelector(".card-kicker").after(accountLoginLabel, accountLoginInput);
loginCard.querySelector('label[for="admin-token"]').textContent = "Ключ доступа или legacy admin token";

const nodes = {
  accountLogin: accountLoginInput,
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
  fuelIncidentRows: document.querySelector("#fuel-incident-rows"),
  fuelIncidentCount: document.querySelector("#fuel-incident-count"),
  fuelReviewDialog: document.querySelector("#fuel-review-dialog"),
  fuelReviewSource: document.querySelector("#fuel-review-source"),
  fuelReviewTitle: document.querySelector("#fuel-review-title"),
  fuelStationSearch: document.querySelector("#fuel-station-search"),
  fuelStationResults: document.querySelector("#fuel-station-results"),
  fuelSelectedStation: document.querySelector("#fuel-selected-station"),
  fuelReviewStatus: document.querySelector("#fuel-review-status"),
  fuelReviewError: document.querySelector("#fuel-review-error"),
  fuelReviewApprove: document.querySelector("#fuel-review-approve"),
  freightSourceRows: document.querySelector("#freight-source-rows"),
  freightEvidenceRows: document.querySelector("#freight-evidence-rows"),
  freightEvidenceCount: document.querySelector("#freight-evidence-count"),
};

let token = sessionStorage.getItem("rail-ops-token") || "";
let endpoint = "/api/admin/overview";
let intelligenceEndpoint = "/api/admin/intelligence";
let incidentEndpoint = "/api/fuel/admin/incidents";
let fuelSearchEndpoint = "/api/fuel/v1/search";
let freightEndpoint = "/api/admin/freight";
let authEndpoint = "/api/auth/session";
let evidenceEndpoint = "/api/restricted/evidence";
let refreshTimer;
let requestInFlight = false;
let sourceConfigById=new Map();
let activeFuelIncident=null,selectedFuelStation=null,fuelSearchTimer=null,fuelSearchController=null;

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

function sourceControlId(id){return String(id).includes("telegram")?"uz-suburban-telegram":String(id).includes("delay-dashboard")?"uz-delay-dashboard":id;}
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
    const control=document.createElement("td"),id=sourceControlId(source.source_id),config=sourceConfigById.get(id)||{enabled:1,priority:50};const priority=document.createElement("input");priority.type="number";priority.min="1";priority.max="100";priority.value=config.priority;priority.style.width="58px";const toggle=document.createElement("button");toggle.className="secondary";toggle.textContent=config.enabled===0?"Enable":"Disable";toggle.addEventListener("click",()=>adminAction({action:"configure-source",sourceId:id,enabled:config.enabled===0,priority:Number(priority.value),reliability:.8}).then(refresh));control.append(priority,toggle);row.append(control);
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
  const cycles=data.cycles||[], quarantine=data.quarantine||[], incomplete=data.incompleteRuns||[],quality=data.modelQuality||{},health=data.sourceHealth24h||[],unstable=health.filter(item=>Number(item.online_checks)<Number(item.checks)*.8).length;sourceConfigById=new Map((data.sourceConfig||[]).map(item=>[item.source_id,item]));
  nodes.cycleChart?.replaceChildren(...cycles.slice().reverse().map(cycle=>{const bar=document.createElement("i");bar.className=cycle.status==="success"?"ok":"error";bar.style.height=`${Math.max(8,Math.min(100,Number(cycle.duration_ms||0)/100))}%`;bar.title=`${formatDate(cycle.started_at)} · ${cycle.status} · ${cycle.duration_ms||0} ms`;return bar;}));
  nodes.intelligenceMetrics?.replaceChildren(metric("Циклы 24ч",cycles.length,"История collector"),metric("MAE модели",quality.maeMinutes==null?"—":`${quality.maeMinutes} мин`,`${quality.evaluations||0} проверок`,quality.maeMinutes>20?"warning":"ok"),metric("Покрытие P80",quality.p80Coverage==null?"—":`${quality.p80Coverage}%`,"Доля фактов внутри коридора",quality.p80Coverage!=null&&quality.p80Coverage<65?"warning":"ok"),metric("Источники 24ч",health.length,unstable?`${unstable} нестабильных`:"Стабильны",unstable?"warning":"ok"),metric("Карантин",quarantine.filter(x=>x.status==="open").length,"Требуют решения",quarantine.some(x=>x.status==="open")?"warning":"ok"),metric("Без полного маршрута",incomplete.length,"Нужна геометрия"));
  nodes.quarantineRows?.replaceChildren(...quarantine.slice(0,50).map(item=>{const row=document.createElement("tr");appendCell(row,formatDate(item.observed_at));appendCell(row,item.source_id);appendCell(row,item.train_number);const reason=appendCell(row,item.reasons_json);reason.title=item.raw_update_json||"";appendCell(row,item.status,`status-pill ${item.status}`);const action=document.createElement("td");if(item.status==="open"){const button=document.createElement("button");button.className="secondary";button.textContent="Review";button.addEventListener("click",async()=>{const station=prompt("Исправленная станция (оставьте пустой, чтобы только закрыть):","");if(station)await adminAction({action:"correct-station",trainNumber:item.train_number,station,reason:"quarantine review"});await adminAction({action:"resolve-quarantine",id:item.quarantine_id,resolution:station?"station-corrected":"reviewed-and-dismissed"});await refresh();});action.append(button);}row.append(action);return row;}));
}
function renderFuelIncidents(data={}) {
  const signals=data.signals||[]; nodes.fuelIncidentCount.textContent=`${signals.length} требуют проверки`; nodes.fuelIncidentRows.replaceChildren();
  if(!signals.length){const row=document.createElement("tr"),cell=appendCell(row,"Новых сигналов нет","empty-row");cell.colSpan=6;nodes.fuelIncidentRows.append(row);return;}
  for(const signal of signals){const row=document.createElement("tr");appendCell(row,formatDate(signal.published_at||signal.detected_at));appendCell(row,signal.incident_type,`status-pill ${signal.incident_type}`);appendCell(row,signal.station_name||signal.location_text||"Требуется локализация");const title=appendCell(row,signal.title);title.title=signal.snippet||signal.source_url;appendCell(row,`${Math.round(Number(signal.confidence||0)*100)}%`);const actions=document.createElement("td"),review=document.createElement("button");review.className="secondary";review.textContent="Разобрать";review.addEventListener("click",()=>openFuelIncidentReview(signal));actions.append(review);row.append(actions);nodes.fuelIncidentRows.append(row);}
}
function selectFuelStation(station){selectedFuelStation=station;nodes.fuelSelectedStation.hidden=false;nodes.fuelSelectedStation.textContent=`${station.name||station.brand||"АЗС"} · ${[station.city,station.address].filter(Boolean).join(" · ")||"адрес не указан"}`;nodes.fuelReviewApprove.disabled=false;}
function renderFuelStationResults(stations=[]){nodes.fuelStationResults.replaceChildren();if(!stations.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="Совпадений не найдено.";nodes.fuelStationResults.append(empty);return;}for(const station of stations){const button=document.createElement("button");button.type="button";button.className="station-choice";const strong=document.createElement("strong"),small=document.createElement("small");strong.textContent=station.name||station.brand||"АЗС";small.textContent=[station.city,station.address].filter(Boolean).join(" · ")||"Адрес не указан";button.append(strong,small);button.addEventListener("click",()=>selectFuelStation(station));nodes.fuelStationResults.append(button);}}
async function searchFuelStations(){const term=nodes.fuelStationSearch.value.trim();if(term.length<2){renderFuelStationResults([]);return;}fuelSearchController?.abort();fuelSearchController=new AbortController();try{const response=await fetch(`${fuelSearchEndpoint}?q=${encodeURIComponent(term)}&limit=50`,{signal:fuelSearchController.signal});if(!response.ok)throw new Error(`Search HTTP ${response.status}`);renderFuelStationResults((await response.json()).stations||[]);}catch(error){if(error.name!=="AbortError"){nodes.fuelReviewError.textContent=error.message;}}}
function openFuelIncidentReview(signal){activeFuelIncident=signal;selectedFuelStation=null;nodes.fuelReviewError.textContent="";nodes.fuelReviewTitle.textContent=signal.title;nodes.fuelReviewSource.href=signal.source_url;nodes.fuelReviewSource.textContent=`Открыть источник · ${signal.source_name||signal.source_id}`;nodes.fuelReviewStatus.value=signal.incident_type==="possible_reopening"?"operating":"damaged_reported";nodes.fuelStationSearch.value=signal.station_address||signal.location_text&&signal.location_text!=="Україна"?signal.station_address||signal.location_text:"";nodes.fuelStationResults.replaceChildren();nodes.fuelSelectedStation.hidden=true;nodes.fuelReviewApprove.disabled=true;if(signal.matched_station_id)selectFuelStation({id:signal.matched_station_id,name:signal.station_name,brand:signal.station_brand,address:signal.station_address});nodes.fuelReviewDialog.showModal();if(nodes.fuelStationSearch.value.length>=2)searchFuelStations();}
async function reviewFuelIncident(decision){if(!activeFuelIncident)return;if(decision==="approve"&&!selectedFuelStation){nodes.fuelReviewError.textContent="Сначала выберите конкретную АЗС.";return;}nodes.fuelReviewError.textContent="";const response=await fetch(`${incidentEndpoint}/review`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({signalId:activeFuelIncident.signal_id,decision,stationId:selectedFuelStation?.id,status:nodes.fuelReviewStatus.value})});if(!response.ok){const body=await response.json().catch(()=>({}));nodes.fuelReviewError.textContent=body.error||`Fuel review HTTP ${response.status}`;return;}nodes.fuelReviewDialog.close();activeFuelIncident=null;await refresh();}
function renderFreightIntelligence(data={}) {
  const sources=data.sources||[],recent=data.recent||[];nodes.freightEvidenceCount.textContent=`${recent.length} наблюдений`;nodes.freightSourceRows.replaceChildren();
  if(!sources.length){const row=document.createElement("tr"),cell=appendCell(row,"Источники ещё не опрошены","empty-row");cell.colSpan=7;nodes.freightSourceRows.append(row);}else for(const source of sources){const row=document.createElement("tr");appendCell(row,source.source_id);appendCell(row,source.status,`status-pill ${source.status}`);appendCell(row,formatAge(source.checked_at));appendCell(row,source.preview_messages);appendCell(row,source.accepted_observations);appendCell(row,Number(source.restricted_dropped||0)+Number(source.rejected_noise||0));appendCell(row,source.error);nodes.freightSourceRows.append(row);}
  nodes.freightEvidenceRows.replaceChildren();if(!recent.length){const row=document.createElement("tr"),cell=appendCell(row,"Подтверждённых грузовых сигналов пока нет","empty-row");cell.colSpan=6;nodes.freightEvidenceRows.append(row);}else for(const item of recent){const row=document.createElement("tr");appendCell(row,formatDate(item.occurred_at));appendCell(row,item.source_id);appendCell(row,item.corridor_code);appendCell(row,item.freight_type);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);const evidence=appendCell(row,item.evidence_excerpt);evidence.title=item.source_url;nodes.freightEvidenceRows.append(row);}
}
function renderEvidenceInbox(data={}) {
  const evidence=data.evidence||[],header=nodes.freightEvidenceRows.closest("table")?.querySelector("thead tr");
  if(header&&header.children.length===6){for(const title of ["Статус","Решение"]){const th=document.createElement("th");th.textContent=title;header.append(th);}}
  nodes.freightEvidenceCount.textContent=`${evidence.length} в очереди`;nodes.freightEvidenceRows.replaceChildren();
  if(!evidence.length){const row=document.createElement("tr"),cell=appendCell(row,"Очередь свидетельств пуста","empty-row");cell.colSpan=8;nodes.freightEvidenceRows.append(row);return;}
  for(const item of evidence){const row=document.createElement("tr");appendCell(row,formatDate(item.occurred_at));appendCell(row,item.source_id);appendCell(row,item.corridor_code);let classification={};try{classification=JSON.parse(item.classification_json||"{}");}catch{}appendCell(row,classification.freightType||item.domain);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);const excerpt=appendCell(row,item.evidence_excerpt);excerpt.title=item.source_url||"";appendCell(row,item.review_status,`status-pill ${item.review_status}`);const actions=document.createElement("td");for(const [status,label] of [["corroborated","Подтвердить"],["needs_context","Уточнить"],["rejected","Отклонить"]]){const button=document.createElement("button");button.className="secondary";button.textContent=label;button.addEventListener("click",()=>reviewEvidence(item.evidence_id,status));actions.append(button);}row.append(actions);nodes.freightEvidenceRows.append(row);}
}
async function reviewEvidence(evidenceId,status){const response=await fetch(`${evidenceEndpoint}/review`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({evidenceId,status})});if(!response.ok)throw new Error(`Evidence review HTTP ${response.status}`);await refresh();}

async function adminAction(body){const response=await fetch(intelligenceEndpoint,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Action HTTP ${response.status}`);return response.json();}
async function loadConfig() {
  try {
    const response = await fetch("data/runtime-config.json", { cache: "no-store" });
    const config = await response.json();
    if (config.apiBase) {
      const base = config.apiBase.endsWith("/") ? config.apiBase.slice(0, -1) : config.apiBase;
      endpoint = new URL("/api/admin/overview", `${base}/`).toString();
      intelligenceEndpoint = new URL("/api/admin/intelligence", `${base}/`).toString();
      incidentEndpoint = new URL("/api/fuel/admin/incidents", `${base}/`).toString();
      fuelSearchEndpoint = new URL("/api/fuel/v1/search", `${base}/`).toString();
      freightEndpoint = new URL("/api/admin/freight", `${base}/`).toString();
      authEndpoint = new URL("/api/auth/session", `${base}/`).toString();
      evidenceEndpoint = new URL("/api/restricted/evidence", `${base}/`).toString();
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
    const incidents=await fetch(incidentEndpoint,{cache:"no-store",headers:{Authorization:`Bearer ${token}`}});if(incidents.ok)renderFuelIncidents(await incidents.json());
    const freight=await fetch(freightEndpoint,{cache:"no-store",headers:{Authorization:`Bearer ${token}`}});if(freight.ok)renderFreightIntelligence(await freight.json());
    const evidence=await fetch(evidenceEndpoint,{cache:"no-store",headers:{Authorization:`Bearer ${token}`}});if(evidence.ok)renderEvidenceInbox(await evidence.json());
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
  try {
    const accessKey=nodes.token.value.trim(),loginName=nodes.accountLogin.value.trim();
    if(!accessKey)return;
    if(loginName){
      const response=await fetch(authEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:loginName,accessKey})});
      if(!response.ok)throw new Error(response.status===401?"Неверный логин или ключ доступа":`Auth HTTP ${response.status}`);
      token=(await response.json()).token;
    }else token=accessKey;
    await refresh();
    sessionStorage.setItem("rail-ops-token", token);
    nodes.token.value = "";
    nodes.accountLogin.value = "";
    startAutoRefresh();
  } catch (error) {
    nodes.error.textContent = error.message;
  }
}

function logout() {
  if(token)fetch(authEndpoint,{method:"DELETE",headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});
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

nodes.fuelStationSearch.addEventListener("input",()=>{clearTimeout(fuelSearchTimer);fuelSearchTimer=setTimeout(searchFuelStations,220);});
nodes.fuelReviewApprove.addEventListener("click",()=>reviewFuelIncident("approve"));
document.querySelector("#fuel-review-reject").addEventListener("click",()=>reviewFuelIncident("reject"));