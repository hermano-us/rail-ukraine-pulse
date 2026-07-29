const loginCard = document.querySelector("#login-form");
const accountLoginLabel = document.createElement("label");
accountLoginLabel.htmlFor = "account-login";
accountLoginLabel.textContent = "Логин сотрудника (для ролевого доступа)";
const accountLoginInput = document.createElement("input");
accountLoginInput.id = "account-login"; accountLoginInput.autocomplete = "username";
accountLoginInput.placeholder = "Например: curator.kyiv";
loginCard.querySelector(".card-kicker").after(accountLoginLabel, accountLoginInput);
loginCard.querySelector('label[for="admin-token"]').textContent = "Ключ доступа или legacy admin token";

const accessPanel=document.createElement("section");accessPanel.id="access-management";accessPanel.className="panel access-management collapsible-panel";accessPanel.hidden=true;
accessPanel.innerHTML=`<header class="panel-header"><div><p class="eyebrow">ACCESS CONTROL</p><h2>Пользователи и права</h2></div><div class="access-summary"><span id="access-user-count" class="tag">—</span><span id="access-session-count" class="tag">—</span></div></header>
  <p class="muted">Персональные аккаунты, роли и активные сессии закрытого контура. Legacy admin token остаётся только аварийным способом входа.</p>
  <form id="access-create-form" class="access-create-form">
    <label><span>Логин</span><input id="access-login" required minlength="3" maxlength="64" pattern="[a-z0-9._-]+" placeholder="curator.kyiv"></label>
    <label><span>Имя</span><input id="access-display-name" required maxlength="120" placeholder="Куратор Киев"></label>
    <label><span>Роль</span><select id="access-role"></select></label>
    <button type="submit">Создать пользователя</button>
  </form>
  <p id="access-error" class="error" role="alert"></p>
  <details class="collapsible-list access-user-list" data-collapse-key="access-users" open><summary>Реестр пользователей</summary><div class="table-wrap"><table class="access-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th>Сессии</th><th>Действия</th></tr></thead><tbody id="access-user-rows"></tbody></table></div></details>
  <details class="role-matrix"><summary>Матрица разрешений ролей</summary><div id="access-role-matrix"></div></details>
  <details class="access-audit"><summary>Журнал управления доступом</summary><div class="table-wrap"><table><thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Объект</th></tr></thead><tbody id="access-audit-rows"></tbody></table></div></details>`;
document.querySelector(".ops-grid").after(accessPanel);
const accessKeyDialog=document.createElement("dialog");accessKeyDialog.className="review-dialog access-key-dialog";
accessKeyDialog.innerHTML=`<form method="dialog" class="review-card"><header><div><p class="eyebrow">ONE-TIME CREDENTIAL</p><h2>Новый ключ доступа</h2></div><button class="secondary icon-button" value="cancel" aria-label="Закрыть">×</button></header><p class="muted">Ключ показывается только один раз. Передайте его сотруднику по защищённому каналу.</p><code id="access-key-value"></code><p id="access-key-copy-status" class="muted"></p><footer><button id="access-copy-key" type="button">Копировать ключ</button><button class="secondary" value="cancel">Готово</button></footer></form>`;
document.body.append(accessKeyDialog);

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
  accessPanel,
  accessCreateForm: document.querySelector("#access-create-form"),
  accessLogin: document.querySelector("#access-login"),
  accessDisplayName: document.querySelector("#access-display-name"),
  accessRole: document.querySelector("#access-role"),
  accessError: document.querySelector("#access-error"),
  accessUserCount: document.querySelector("#access-user-count"),
  accessSessionCount: document.querySelector("#access-session-count"),
  accessUserRows: document.querySelector("#access-user-rows"),
  accessRoleMatrix: document.querySelector("#access-role-matrix"),
  accessAuditRows: document.querySelector("#access-audit-rows"),
  accessKeyDialog,
  accessKeyValue: document.querySelector("#access-key-value"),
  platformUpdatedAt: document.querySelector("#platform-updated-at"),
  platformError: document.querySelector("#platform-error"),
  railIntelligenceMetrics: document.querySelector("#rail-intelligence-metrics"),
  railTwinRows: document.querySelector("#rail-twin-rows"),
  railObservationRows: document.querySelector("#rail-observation-rows"),
  entityResolutionRows: document.querySelector("#entity-resolution-rows"),
  witnessSubmissionRows: document.querySelector("#witness-submission-rows"),
  twinTransitionRows: document.querySelector("#twin-transition-rows"),
  operationsHubMetrics: document.querySelector("#operations-hub-metrics"),
  operationsMovementRows: document.querySelector("#operations-movement-rows"),
  operationsNotifications: document.querySelector("#operations-notifications"),
  operationsSelection: document.querySelector("#operations-selection"),
  operationsFilters: document.querySelector("#operations-filters"),
  operationsFilterCount: document.querySelector("#operations-filter-count"),
  analyticsNetworkMetrics: document.querySelector("#analytics-network-metrics"),
  nodeActivityRows: document.querySelector("#node-activity-rows"),
  networkAnomalyRows: document.querySelector("#network-anomaly-rows"),
  internationalCorridors: document.querySelector("#international-corridors"),
  calibrationProfileRows: document.querySelector("#calibration-profile-rows"),
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
let railIntelligenceEndpoint = "/api/restricted/rail-intelligence";
let operationsHubEndpoint = "/api/restricted/operations-hub";
let analyticsNetworkEndpoint = "/api/restricted/analytics-network";
let requestInFlight = false;
let sourceConfigById=new Map();
let activeFuelIncident=null,selectedFuelStation=null,fuelSearchTimer=null,fuelSearchController=null;
let operationsMap=null,operationsLayer=null,operationsTwinLayer=null;
let operationsFilter="all",latestOperationsHubData=null,operationsMapFingerprint="";

function initializeCollapsibleLists(root=document){
  for(const panel of root.querySelectorAll("details[data-collapse-key]")){
    if(panel.dataset.collapseReady)continue;
    panel.dataset.collapseReady="true";const key=`rail-ops-collapse:${panel.dataset.collapseKey}`;
    try{const saved=localStorage.getItem(key);if(saved!==null)panel.open=saved==="open";}catch{}
    panel.addEventListener("toggle",()=>{try{localStorage.setItem(key,panel.open?"open":"closed");}catch{}},{passive:true});
  }
}

function initializeLargePanels(root=document){
  const setCollapsed=(panel,collapsed)=>{panel.classList.toggle("panel-collapsed",collapsed);const button=panel.querySelector(":scope > .panel-header .panel-collapse-button");if(button){button.textContent=collapsed?"\u0420\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c":"\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c";button.setAttribute("aria-expanded",String(!collapsed));}try{localStorage.setItem(`rail-ops-panel:${panel.id}`,collapsed?"collapsed":"expanded");}catch{}if(!collapsed&&panel.id==="platform-suite")setTimeout(()=>operationsMap?.invalidateSize(),0);};
  for(const panel of root.querySelectorAll(".collapsible-panel")){if(!panel.id||panel.dataset.panelCollapseReady)continue;panel.dataset.panelCollapseReady="true";const header=panel.querySelector(":scope > .panel-header");if(!header)continue;const button=document.createElement("button");button.type="button";button.className="secondary panel-collapse-button";button.addEventListener("click",()=>setCollapsed(panel,!panel.classList.contains("panel-collapsed")));header.append(button);let collapsed=false;try{collapsed=localStorage.getItem(`rail-ops-panel:${panel.id}`)==="collapsed";}catch{}setCollapsed(panel,collapsed);}
  for(const button of root.querySelectorAll("[data-jump-target]"))button.addEventListener("click",()=>{const panel=document.getElementById(button.dataset.jumpTarget);if(!panel)return;if(panel.classList.contains("panel-collapsed"))setCollapsed(panel,false);panel.scrollIntoView({behavior:"smooth",block:"start"});});
  for(const button of root.querySelectorAll("[data-panel-action]"))button.addEventListener("click",()=>{const collapsed=button.dataset.panelAction==="collapse";for(const panel of root.querySelectorAll(".collapsible-panel"))setCollapsed(panel,collapsed);});
}
function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" });
}
let accessUsersEndpoint = "/api/admin/access/users";
let accessAuditEndpoint = "/api/admin/access/audit";
let authMeEndpoint = "/api/auth/me";

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
  const boardScheduler = data.snapshot?.collectorDiagnostics?.board?.scheduler || {};
  const trustedCollector = data.snapshot?.trustedCollector || null;
  const collectorTone = trustedCollector?.status === "healthy" ? "ok" : "warning";
  nodes.coverageMetrics.replaceChildren(
    metric("\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435 \u0442\u0430\u0431\u043b\u043e", boardScheduler.selectedStation || "\u2014", (boardScheduler.selectedReason || []).join(" \u00b7 ") || "\u041f\u043b\u0430\u043d\u0438\u0440\u043e\u0432\u0449\u0438\u043a \u043e\u0436\u0438\u0434\u0430\u0435\u0442 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0446\u0438\u043a\u043b"),
    metric("\u0414\u043e\u0432\u0435\u0440\u0435\u043d\u043d\u044b\u0439 collector", trustedCollector?.status || "\u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d", trustedCollector ? trustedCollector.collectorId + " / heartbeat " + formatAge(trustedCollector.checkedAt) : "\u0417\u0430\u0449\u0438\u0449\u0451\u043d\u043d\u044b\u0439 heartbeat \u0435\u0449\u0451 \u043d\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u043d", collectorTone),
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
  nodes.cycleChart?.replaceChildren(...cycles.slice().reverse().map(cycle=>{const bar=document.createElement("i");bar.className=cycle.status==="success"?"ok":cycle.status==="running"?"running":cycle.status==="degraded"?"degraded":"error";bar.style.height=`${Math.max(8,Math.min(100,Number(cycle.duration_ms||0)/100))}%`;bar.title=`${formatDate(cycle.started_at)} · ${cycle.status} · ${cycle.duration_ms||0} ms${cycle.error?` · ${cycle.error}`:""}`;return bar;}));
  nodes.intelligenceMetrics?.replaceChildren(metric("Циклы 24ч",cycles.length,"История collector"),metric("MAE модели",quality.maeMinutes==null?"—":`${quality.maeMinutes} мин`,`${quality.evaluations||0} проверок · ${quality.prospectiveEvaluations||0} live`,quality.maeMinutes>20?"warning":"ok"),metric("Покрытие P80",quality.p80Coverage==null?"—":`${quality.p80Coverage}%`,`${quality.readiness||"insufficient-evidence"} · ${quality.replayEvaluations||0} replay`,quality.p80Coverage!=null&&quality.p80Coverage<65?"warning":"ok"),metric("Источники 24ч",health.length,unstable?`${unstable} нестабильных`:"Стабильны",unstable?"warning":"ok"),metric("Карантин",quarantine.filter(x=>x.status==="open").length,"Требуют решения",quarantine.some(x=>x.status==="open")?"warning":"ok"),metric("Без полного маршрута",incomplete.length,"Нужна геометрия"));
  const cycleFailures=cycles.filter(item=>item.status==="failed").length,cycleRunning=cycles.filter(item=>item.status==="running").length,cycleSummary=nodes.intelligenceMetrics?.querySelector(".metric small");
  if(cycleSummary)cycleSummary.textContent=`${cycleFailures} ошибок${cycleRunning?` · ${cycleRunning} выполняются`:""}`;
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
let evidenceRenderSequence=0;
function canReviewEvidence(principal){return Boolean(principal?.permissions?.includes("*")||principal?.permissions?.includes("evidence.review"));}
function freightReviewStatus(message="",tone=""){const node=document.querySelector("#freight-review-status"),header=nodes.freightEvidenceRows.closest("table")?.querySelector("thead tr");if(header?.children.length===6)for(const title of ["Статус","Решение"]){const th=document.createElement("th");th.textContent=title;header.append(th);}if(node){node.textContent=message;node.dataset.tone=tone;}}
function renderFreightIntelligence(data={}){
  const sources=data.sources||[];nodes.freightSourceRows.replaceChildren();
  if(!sources.length){const row=document.createElement("tr"),cell=appendCell(row,"Источники ещё не опрошены","empty-row");cell.colSpan=7;nodes.freightSourceRows.append(row);return;}
  for(const source of sources){const row=document.createElement("tr");appendCell(row,source.source_id);appendCell(row,source.status,`status-pill ${source.status}`);appendCell(row,formatAge(source.checked_at));appendCell(row,source.preview_messages);appendCell(row,source.accepted_observations);appendCell(row,Number(source.restricted_dropped||0)+Number(source.rejected_noise||0));appendCell(row,source.error);nodes.freightSourceRows.append(row);}
}
async function renderEvidenceInbox(data={}){const sequence=++evidenceRenderSequence;let principal=null;try{const response=await fetch(authMeEndpoint,{cache:"no-store",headers:{Authorization:`Bearer ${token}`}});if(response.ok)principal=(await response.json()).user||null;}catch{}if(sequence!==evidenceRenderSequence)return;const evidence=data.evidence||[],canReview=canReviewEvidence(principal);nodes.freightEvidenceCount.textContent=`${evidence.length} в очереди`;nodes.freightEvidenceRows.replaceChildren();freightReviewStatus(canReview?"":"Решения доступны администратору или старшему куратору.");if(!evidence.length){const row=document.createElement("tr"),cell=appendCell(row,"Очередь свидетельств пуста","empty-row");cell.colSpan=8;nodes.freightEvidenceRows.append(row);return;}for(const item of evidence){const row=document.createElement("tr");row.dataset.evidenceId=item.evidence_id;appendCell(row,formatDate(item.occurred_at));appendCell(row,item.source_id);appendCell(row,item.corridor_code);let classification={};try{classification=JSON.parse(item.classification_json||"{}");}catch{}appendCell(row,classification.freightType||item.domain);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);const excerpt=appendCell(row,item.evidence_excerpt);excerpt.title=item.source_url||"";appendCell(row,item.review_status,`status-pill ${item.review_status}`);const actions=document.createElement("td");actions.className="evidence-actions";if(canReview){for(const [status,label] of [["corroborated","Подтвердить"],["needs_context","Уточнить"],["rejected","Отклонить"]]){const button=document.createElement("button");button.className="secondary";button.textContent=label;button.addEventListener("click",()=>reviewEvidence(item.evidence_id,status,row));actions.append(button);}}else actions.textContent="Только просмотр";row.append(actions);nodes.freightEvidenceRows.append(row);}}
async function reviewEvidence(evidenceId,status,row){const buttons=[...(row?.querySelectorAll("button")||[])];buttons.forEach(button=>button.disabled=true);freightReviewStatus("Сохраняем решение…");try{const response=await fetch(`${evidenceEndpoint}/review`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({evidenceId,status})});if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(response.status===403?"Недостаточно прав для разбора грузовых сигналов":body.error||`Evidence review HTTP ${response.status}`);}row?.remove();const remaining=nodes.freightEvidenceRows.querySelectorAll("tr[data-evidence-id]").length;nodes.freightEvidenceCount.textContent=`${remaining} в очереди`;freightReviewStatus("Решение сохранено","ok");}catch(error){buttons.forEach(button=>button.disabled=false);freightReviewStatus(error.message,"error");}}


const roleLabels={admin:"Администратор",senior_curator:"Старший куратор",logistics_coordinator:"Координатор логистики",operator:"Оператор",observer:"Наблюдатель"};
const statusLabels={active:"Активен",suspended:"Заблокирован",archived:"Архив"};
async function accessFetch(url,options={}){const response=await fetch(url,{cache:"no-store",...options,headers:{Authorization:`Bearer ${token}`,...(options.headers||{})}});if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error||`Access API HTTP ${response.status}`);error.status=response.status;throw error;}return response.json();}
function showAccessKey(value){nodes.accessKeyValue.textContent=value;document.querySelector("#access-key-copy-status").textContent="";nodes.accessKeyDialog.showModal();}
function makeSelect(values,current,labels,isSelf=false){const select=document.createElement("select");for(const value of values){const option=document.createElement("option");option.value=value;option.textContent=labels[value]||value;option.selected=value===current;if(isSelf&&value!==current)option.disabled=true;select.append(option);}return select;}
function renderRoleMatrix(roles=[],permissions={}){nodes.accessRoleMatrix.replaceChildren();for(const role of roles){const card=document.createElement("article"),title=document.createElement("strong"),list=document.createElement("p");title.textContent=roleLabels[role]||role;list.textContent=(permissions[role]||[]).join(" · ")||"Только базовый просмотр";card.append(title,list);nodes.accessRoleMatrix.append(card);}}
function renderAccessUsers(data={},audit=[],principal={}){
  const users=data.users||[],roles=data.roles||Object.keys(roleLabels);nodes.accessPanel.hidden=false;nodes.accessUserCount.textContent=`${users.length} пользователей`;nodes.accessSessionCount.textContent=`${users.reduce((sum,user)=>sum+Number(user.active_sessions||0),0)} активных сессий`;nodes.accessRole.innerHTML="";
  for(const role of roles){const option=document.createElement("option");option.value=role;option.textContent=roleLabels[role]||role;nodes.accessRole.append(option);}renderRoleMatrix(roles,data.rolePermissions||{});nodes.accessUserRows.replaceChildren();
  if(!users.length){const row=document.createElement("tr"),cell=appendCell(row,"Персональные пользователи ещё не созданы","empty-row");cell.colSpan=6;nodes.accessUserRows.append(row);}else for(const user of users){const row=document.createElement("tr"),identity=document.createElement("td"),name=document.createElement("strong"),login=document.createElement("small");name.textContent=user.display_name;login.textContent=user.login;identity.append(name,login);row.append(identity);const isSelf=principal.id===user.user_id,role=makeSelect(roles,user.role,roleLabels,isSelf),status=makeSelect(["active","suspended","archived"],user.status,statusLabels,isSelf);const roleCell=document.createElement("td"),statusCell=document.createElement("td");roleCell.append(role);statusCell.append(status);row.append(roleCell,statusCell);appendCell(row,formatDate(user.last_login_at));appendCell(row,user.active_sessions||0);const actions=document.createElement("td");actions.className="access-actions";
    const save=document.createElement("button");save.className="secondary";save.textContent="Сохранить";save.addEventListener("click",()=>updateAccessUser(user.user_id,{role:role.value,status:status.value,displayName:user.display_name}));
    const rotate=document.createElement("button");rotate.className="secondary";rotate.textContent="Новый ключ";rotate.disabled=isSelf;rotate.title=isSelf?"Собственный ключ нельзя заменить из активной сессии":"Отзывает прежний ключ и все сессии";rotate.addEventListener("click",()=>rotateAccessKey(user));
    const revoke=document.createElement("button");revoke.className="secondary danger";revoke.textContent="Завершить сессии";revoke.disabled=isSelf||!Number(user.active_sessions);revoke.addEventListener("click",()=>revokeAccessSessions(user));actions.append(save,rotate,revoke);row.append(actions);nodes.accessUserRows.append(row);}
  nodes.accessAuditRows.replaceChildren();for(const item of audit){const row=document.createElement("tr");appendCell(row,formatDate(item.occurred_at));appendCell(row,item.actor_id);appendCell(row,item.action);appendCell(row,[item.entity_type,item.entity_id].filter(Boolean).join(" · "));nodes.accessAuditRows.append(row);}
}
async function loadAccessManagement(){try{const [users,audit,me]=await Promise.all([accessFetch(accessUsersEndpoint),accessFetch(accessAuditEndpoint),accessFetch(authMeEndpoint)]);renderAccessUsers(users,audit.audit||[],me.user||{});nodes.accessError.textContent="";}catch(error){if([401,403].includes(error.status)){nodes.accessPanel.hidden=true;return;}nodes.accessPanel.hidden=false;nodes.accessError.textContent=error.message;}}
async function createAccessUser(event){event.preventDefault();nodes.accessError.textContent="";try{const result=await accessFetch(accessUsersEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:nodes.accessLogin.value.trim(),displayName:nodes.accessDisplayName.value.trim(),role:nodes.accessRole.value})});nodes.accessCreateForm.reset();showAccessKey(result.accessKey);await loadAccessManagement();}catch(error){nodes.accessError.textContent=error.message;}}
async function updateAccessUser(userId,changes){try{await accessFetch(`${accessUsersEndpoint}/${encodeURIComponent(userId)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(changes)});await loadAccessManagement();}catch(error){nodes.accessError.textContent=error.message;}}
async function rotateAccessKey(user){if(!confirm(`Выпустить новый ключ для ${user.login}? Все его сессии завершатся.`))return;try{const result=await accessFetch(`${accessUsersEndpoint}/${encodeURIComponent(user.user_id)}/rotate-key`,{method:"POST"});showAccessKey(result.accessKey);await loadAccessManagement();}catch(error){nodes.accessError.textContent=error.message;}}
async function revokeAccessSessions(user){if(!confirm(`Завершить все сессии ${user.login}?`))return;try{await accessFetch(`${accessUsersEndpoint}/${encodeURIComponent(user.user_id)}/revoke-sessions`,{method:"POST"});await loadAccessManagement();}catch(error){nodes.accessError.textContent=error.message;}}

async function adminAction(body){const response=await fetch(intelligenceEndpoint,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Action HTTP ${response.status}`);return response.json();}
function emptyTable(tbody,message,colspan){tbody.replaceChildren();const row=document.createElement("tr"),cell=appendCell(row,message,"empty-row");cell.colSpan=colspan;tbody.append(row);}
async function platformFetch(url,options={}){const response=await fetch(url,{cache:"no-store",...options,headers:{Authorization:`Bearer ${token}`,...(options.headers||{})}});if(response.status===403)return null;if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`Platform API HTTP ${response.status}`);}return response.json();}
async function platformAction(body){const result=await platformFetch(operationsHubEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});await loadPlatformSuite();return result;}
async function resolveObservationLink(eventId,decision,runId=null){
  const result=await platformFetch(railIntelligenceEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"resolve-observation-link",eventId,decision,runId})});
  if(!result)throw new Error("Недостаточно прав для решения Observation Fusion");await loadPlatformSuite();return result;
}
async function reviewWitnessSubmission(submissionId,decision){const result=await platformFetch(railIntelligenceEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"review-witness-submission",submissionId,decision})});if(!result)throw new Error("Insufficient permission to moderate observations");await loadPlatformSuite();return result;}


const TWIN_STATE_LABELS={at_station:"На станции",dwelling:"Стоянка",departing:"Отправляется",in_transit:"В пути",approaching:"Приближается",overdue:"Нет ожидаемого факта",stale:"Устарело",unknown:"Неизвестно",unresolved:"Не определено"};
function renderRailIntelligence(data){
  if(!data)return;const counts=data.counts||{},geometryCoverage=counts.edges?Math.round(Number(counts.geometryEdges||0)/Number(counts.edges)*100):0;
  nodes.railIntelligenceMetrics.replaceChildren(metric("Узлы графа",counts.nodes||0,"Наблюдаемые станции"),metric("Рёбра графа",counts.edges||0,"Изученные перегоны"),metric("Цифровые двойники",counts.currentStates||0,`${counts.activeHypotheses||0} активных гипотез`),metric("Геометрия",`${geometryCoverage}%`,"Только реальные рёбра",geometryCoverage<60?"warning":"ok"),metric("Наблюдения",counts.observations||0,"Трассируемые факты"),metric("Калибровка",counts.resolvedPredictions||0,"Закрытые прогнозы"));
  const reference=data.graphReference;if(reference){
    const progress=reference.status==="active"?100:Math.round(((Number(reference.importedStations)||0)+(Number(reference.importedSegments)||0))/Math.max(1,(Number(reference.stations)||0)+(Number(reference.segments)||0))*100),lastProgressAge=reference.lastProgressAt?formatAge(reference.lastProgressAt):"—",eta=reference.estimatedCompletionAt?formatDate(reference.estimatedCompletionAt):"рассчитывается",diagnostics=reference.diagnostics,graphTone=reference.consecutiveFailures||reference.importError||diagnostics?.status==="degraded"?"warning":reference.status==="active"?"ok":"neutral";
    nodes.railIntelligenceMetrics.append(metric("OSM Rail Graph",reference.status==="active"?reference.segments:`${progress}%`,reference.status==="active"?`${reference.activeDirectedSegments} направленных участков`:`${reference.importedStations}/${reference.stations} станций · ETA ${eta}`,graphTone),metric("Темп импорта",reference.status==="active"?"готово":lastProgressAge,`${reference.recoveryCount||0} восстановлений · ${reference.consecutiveFailures||0} ошибок подряд`,graphTone),metric("Реестр станций",reference.stations,`${reference.aliases} алиасов · ${reference.stationCodes||0} кодов · ${reference.unmatchedStations} без пути`,reference.unmatchedStations>500?"warning":"ok"));
    if(diagnostics)nodes.railIntelligenceMetrics.append(metric("Связность графа",diagnostics.connectedComponents,`${diagnostics.largestComponentNodes}/${diagnostics.topologyNodes} узлов в крупнейшем компоненте · ${diagnostics.anomalousSegments} аномальных сегментов`,diagnostics.status==="healthy"?"ok":"warning"));
  }
  nodes.railIntelligenceMetrics.append(metric("\u041f\u0435\u0440\u0435\u0445\u043e\u0434\u044b v4",counts.stateTransitions||0,"Append-only история фаз"),metric("Нет ожидаемого факта",counts.overdueStates||0,"Требует нового станционного события",counts.overdueStates?"warning":"ok"));
  nodes.railIntelligenceMetrics.append(metric("\u041a\u044d\u0448 \u043c\u0430\u0440\u0448\u0440\u0443\u0442\u043e\u0432",counts.cachedRoutes||0,"\u0421\u043e\u0441\u0442\u0430\u0432\u043d\u0430\u044f OSM-\u0433\u0435\u043e\u043c\u0435\u0442\u0440\u0438\u044f"),metric("\u0421\u0432\u044f\u0437\u0430\u043d\u043d\u044b\u0435 \u0444\u0430\u043a\u0442\u044b",counts.linkedObservations||0,`${counts.pendingLinks||0} \u0442\u0440\u0435\u0431\u0443\u044e\u0442 \u0443\u0442\u043e\u0447\u043d\u0435\u043d\u0438\u044f`,counts.pendingLinks?"warning":"ok"));
  const expected=data.expectedRegistry?.runs||[],gaps=data.expectedRegistry?.gaps||[],fusion=data.observationFusion?.groups||[],external=data.externalSources||[],priorities=data.stationCoveragePriorities||[];
  nodes.railIntelligenceMetrics.append(metric("\u0421\u0443\u0442\u043e\u0447\u043d\u044b\u0439 \u0440\u0435\u0435\u0441\u0442\u0440",expected.length,`${expected.filter(item=>item.status==="planned").length} planned \u00b7 ${expected.filter(item=>item.status==="active").length} active`),metric("\u041c\u043e\u043b\u0447\u0430\u0449\u0438\u0435 \u0440\u0435\u0439\u0441\u044b",gaps.length,"\u041d\u0435 \u0438\u0441\u0447\u0435\u0437\u0430\u044e\u0442 \u0438\u0437 Operations Hub",gaps.length?"warning":"ok"),metric("Fusion v3",fusion.length,`${fusion.filter(item=>item.status==="conflict").length} \u043a\u043e\u043d\u0444\u043b\u0438\u043a\u0442\u043e\u0432`,fusion.some(item=>item.status==="conflict")?"warning":"ok"),metric("\u041f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442\u044b \u0442\u0430\u0431\u043b\u043e",priorities.length,`${priorities.filter(item=>Number(item.priority_score)>=40).length} \u0441\u0440\u043e\u0447\u043d\u044b\u0445 \u0441\u0442\u0430\u043d\u0446\u0438\u0439`),metric("\u041f\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u043d\u044b\u0435 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438",external.filter(item=>item.status==="online").length,`${external.length} \u0430\u0434\u0430\u043f\u0442\u0435\u0440\u043e\u0432 \u00b7 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u043d\u044b\u0435 \u043f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e \u0437\u0430\u043a\u0440\u044b\u0442\u044b`,external.some(item=>item.status==="unavailable")?"warning":"neutral"));
  const states=data.twinStates||[];if(!states.length)emptyTable(nodes.railTwinRows,"Прогнозы появятся после накопления последовательных станционных фактов.",8);else{nodes.railTwinRows.replaceChildren();for(const item of states.slice(0,100)){const row=document.createElement("tr");appendCell(row,item.train_number||item.run_id);appendCell(row,`${item.anchor_node_id} → ${item.next_node_id||"—"}${Number(item.alternatives_count)?` (+${item.alternatives_count})`:""}`);appendCell(row,formatDate(item.eta_p50));appendCell(row,`${formatDate(item.eta_p80_start)} — ${formatDate(item.eta_p80_end)}`);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);appendCell(row,item.uncertainty_km==null?"—":`±${Math.round(Number(item.uncertainty_km))} км`);appendCell(row,item.position_status,`status-pill ${item.position_status}`);appendCell(row,TWIN_STATE_LABELS[item.operational_state]||item.operational_state||"—",`status-pill ${item.operational_state||"unknown"}`);nodes.railTwinRows.append(row);}}
  const observations=data.observations||[];if(!observations.length)emptyTable(nodes.railObservationRows,"Подтверждённых наблюдений пока нет.",5);else{nodes.railObservationRows.replaceChildren();for(const item of observations.slice(0,100)){const row=document.createElement("tr");appendCell(row,formatDate(item.observed_at));appendCell(row,item.train_number||item.run_id);appendCell(row,item.station_name);appendCell(row,item.source_id);appendCell(row,`${Math.round(Number(item.reliability||0)*100)}%`);nodes.railObservationRows.append(row);}}
  const transitions=data.stateTransitions||[];
  if(nodes.twinTransitionRows){if(!transitions.length)emptyTable(nodes.twinTransitionRows,"Переходы появятся после первого цикла Rail Intelligence v4.",6);else{nodes.twinTransitionRows.replaceChildren();for(const item of transitions.slice(0,150)){const row=document.createElement("tr"),reason=item.reasons||{};appendCell(row,formatDate(item.calculated_at));appendCell(row,item.train_number||item.run_id);appendCell(row,`${TWIN_STATE_LABELS[item.from_state]||item.from_state||"Старт"} → ${TWIN_STATE_LABELS[item.to_state]||item.to_state}`);appendCell(row,`${item.anchor_node_id||"?"} → ${item.next_node_id||"?"}`);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);appendCell(row,(reason.reasons||[]).join(" · ")||"model transition");nodes.twinTransitionRows.append(row);}}}  const pendingLinks=data.entityResolution?.pending||[];
  if(nodes.entityResolutionRows){
    if(!pendingLinks.length)emptyTable(nodes.entityResolutionRows,"Спорных сопоставлений нет — очевидные события связаны автоматически.",5);else{
      nodes.entityResolutionRows.replaceChildren();
      for(const item of pendingLinks){
        const row=document.createElement("tr"),candidates=item.candidates||[],best=candidates[0],select=document.createElement("select"),actions=document.createElement("div"),confirmButton=document.createElement("button"),rejectButton=document.createElement("button");
        appendCell(row,formatDate(item.occurred_at));appendCell(row,`${item.train_number||"?"} · ${item.station||"станция не определена"} · ${item.source_id||"источник"}`);
        for(const candidate of candidates){const option=document.createElement("option");option.value=candidate.runId;option.textContent=`${Math.round(Number(candidate.probability||0)*100)}% · ${candidate.trainNumber||candidate.runId} · ${candidate.origin||"?"} → ${candidate.destination||"?"}`;select.append(option);}const candidateCell=document.createElement("td");candidateCell.append(select);row.append(candidateCell);
        const positive=(best?.features||[]).filter(feature=>feature.matched&&Number(feature.weight)>0).sort((a,b)=>Number(b.weight)-Number(a.weight)).slice(0,3).map(feature=>feature.label);appendCell(row,positive.join(" · ")||item.review_reason||"Недостаточно признаков");
        actions.className="entity-resolution-actions";confirmButton.type="button";confirmButton.textContent="Связать";confirmButton.disabled=!best;rejectButton.type="button";rejectButton.className="secondary";rejectButton.textContent="Отклонить";confirmButton.addEventListener("click",()=>resolveObservationLink(item.event_id,"link",select.value).catch(error=>nodes.platformError.textContent=error.message));rejectButton.addEventListener("click",()=>resolveObservationLink(item.event_id,"reject").catch(error=>nodes.platformError.textContent=error.message));actions.append(confirmButton,rejectButton);const actionCell=document.createElement("td");actionCell.append(actions);row.append(actionCell);nodes.entityResolutionRows.append(row);
      }
    }
  }
  const submissions=data.witnessSubmissions||[];if(nodes.witnessSubmissionRows){if(!submissions.length)emptyTable(nodes.witnessSubmissionRows,"Новых пассажирских наблюдений нет.",5);else{nodes.witnessSubmissionRows.replaceChildren();for(const item of submissions){const row=document.createElement("tr"),actions=document.createElement("div"),approve=document.createElement("button"),reject=document.createElement("button"),cell=document.createElement("td");appendCell(row,formatDate(item.observed_at));appendCell(row,item.train_number);appendCell(row,item.station_name);appendCell(row,item.note||"—");actions.className="entity-resolution-actions";approve.textContent="Подтвердить";reject.textContent="Отклонить";reject.className="secondary";approve.addEventListener("click",()=>reviewWitnessSubmission(item.submission_id,"approve").catch(error=>nodes.platformError.textContent=error.message));reject.addEventListener("click",()=>reviewWitnessSubmission(item.submission_id,"reject").catch(error=>nodes.platformError.textContent=error.message));actions.append(approve,reject);cell.append(actions);row.append(cell);nodes.witnessSubmissionRows.append(row);}}}
}
const FREIGHT_CORRIDOR_GEOMETRY={
  "kyiv-korosten":{kind:"line",label:"Київ — Коростень",coordinates:[[30.484,50.4406],[30.259,50.521],[29.917,50.64],[29.25,50.77],[28.642,50.953]],terminals:{"київ":"start","киев":"start","коростень":"end"}},
  "kryvyi-rih":{kind:"area",label:"Криворізький залізничний район",coordinates:[[32.95,47.72],[33.95,47.72],[33.95,48.35],[32.95,48.35]]},
  "zaporizhzhia":{kind:"area",label:"Запорізький залізничний район",coordinates:[[34.45,47.45],[35.75,47.45],[35.75,48.15],[34.45,48.15]]}
};
const FREIGHT_STATION_FALLBACKS=new Map([["київ",[30.484,50.4406]],["киев",[30.484,50.4406]],["ірпінь",[30.259,50.521]],["ирпень",[30.259,50.521]],["коростень",[28.642,50.953]]]);
let operationsStationLookupPromise=null,operationsMapRenderSequence=0,operationsMapHasInitialFit=false,selectedMovementId=null;
let operationsMarkers=new Map(),operationsMovements=new Map();
function normalizeOperationsStation(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu,"").trim();}
function validUkraineOperationsPoint(latitude,longitude){return Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=43.8&&latitude<=53&&longitude>=21&&longitude<=41.5;}
function operationsMetadata(item){try{return JSON.parse(item?.metadata_json||"{}")||{};}catch{return {};}}
function filterOperationsMovements(movements,workflows=[]){
  const decisionIds=new Set(workflows.filter(item=>item.state!=="resolved").map(item=>item.movement_id));
  const now=Date.now();
  return movements.filter(item=>{
    if(operationsFilter==="decision")return decisionIds.has(item.movement_id)||["attention","investigating"].includes(item.workflow_state)||operationsMetadata(item).ambiguous;
    if(operationsFilter==="silent")return now-Date.parse(item.last_observed_at||0)>90*60000;
    if(operationsFilter==="low-confidence")return Number(item.confidence||0)<.5;
    if(operationsFilter==="changed")return Boolean(item.predictionChanges?.length);
    return true;
  });
}
function operationsStationLookup(){if(!operationsStationLookupPromise)operationsStationLookupPromise=fetch("data/stations.json",{cache:"force-cache"}).then(response=>response.ok?response.json():{stations:[]}).then(data=>{const lookup=new Map();for(const station of data.stations||[])for(const name of [station.name,...(station.aliases||[])])lookup.set(normalizeOperationsStation(name),station);return lookup;}).catch(()=>new Map());return operationsStationLookupPromise;}
function ensureOperationsMap(){if(operationsMap||!window.L||!document.querySelector("#operations-map"))return;operationsMap=L.map("operations-map",{zoomControl:true,attributionControl:true,maxBounds:[[42.5,19.5],[54.5,43]],maxBoundsViscosity:.7}).setView([49.1,31.2],6);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:"© OpenStreetMap"}).addTo(operationsMap);operationsLayer=L.layerGroup().addTo(operationsMap);operationsTwinLayer=L.layerGroup().addTo(operationsMap);}
function hypothesisCoordinates(hypothesis){const geometry=hypothesis?.geometry;const coordinates=geometry?.type==="LineString"?geometry.coordinates:Array.isArray(geometry)?geometry:null;if(!Array.isArray(coordinates)||coordinates.length<2)return null;const latLngs=coordinates.map(point=>[Number(point?.[1]),Number(point?.[0])]);return latLngs.every(([lat,lon])=>validUkraineOperationsPoint(lat,lon))?latLngs:null;}
function renderSelectedTwinLayer(item){if(!operationsTwinLayer)return;operationsTwinLayer.clearLayers();if(!item)return;for(const [index,hypothesis] of (item.twinHypotheses||[]).slice(0,3).entries()){const latLngs=hypothesisCoordinates(hypothesis);if(!latLngs)continue;const probability=Number(hypothesis.probability||0),uncertainty=Number(hypothesis.uncertainty_km||0),primary=index===0;L.polyline(latLngs,{color:primary?"#5ce1c5":"#8da8ff",weight:Math.max(12,Math.min(30,uncertainty/3)),opacity:.08,interactive:false,lineCap:"round"}).addTo(operationsTwinLayer);const line=L.polyline(latLngs,{color:primary?"#5ce1c5":"#8da8ff",weight:primary?4:3,opacity:Math.max(.35,probability),dashArray:primary?"10 7":"5 8"}).addTo(operationsTwinLayer);line.bindTooltip(`${primary?"Основная":"Альтернатива"}: ${hypothesis.from_node_id} → ${hypothesis.to_node_id} · ${Math.round(probability*100)}%`);}}
function focusOperationsMovement(id,{zoom=true}={}){const item=operationsMovements.get(id);if(!item)return;selectedMovementId=id;for(const row of nodes.operationsMovementRows?.querySelectorAll("tr[data-movement-id]")||[])row.classList.toggle("selected",row.dataset.movementId===id);renderOperationsSelection(item);renderSelectedTwinLayer(item);const marker=operationsMarkers.get(id);if(marker){if(zoom)operationsMap.setView(marker.getLatLng(),Math.max(operationsMap.getZoom(),8));marker.openPopup();}}
function renderOperationsSelection(item){
  if(!nodes.operationsSelection)return;nodes.operationsSelection.replaceChildren();
  if(!item){renderSelectedTwinLayer(null);const empty=document.createElement("p");empty.className="muted";empty.textContent="Выберите маркер или строку реестра.";nodes.operationsSelection.append(empty);return;}
  const meta=operationsMetadata(item),state=item.twinState||{},hypotheses=item.twinHypotheses||[],card=document.createElement("article"),title=document.createElement("strong"),route=document.createElement("p"),facts=document.createElement("small"),actions=document.createElement("div"),take=document.createElement("button"),form=document.createElement("form"),station=document.createElement("input"),note=document.createElement("input"),submit=document.createElement("button"),status=document.createElement("small");
  card.className="operations-selection-card";title.textContent=`Поезд ${item.train_number||item.run_id}`;route.textContent=`${item.origin||"—"} → ${item.destination||"—"}`;facts.textContent=`${item.position_status||"unknown"} · уверенность ${Math.round(Number(item.confidence||0)*100)}% · последний факт ${item.last_station||"станция не указана"} (${formatAge(item.last_observed_at)})${Number.isFinite(Number(meta.uncertaintyKm))?` · погрешность ~${Math.round(Number(meta.uncertaintyKm))} км`:""}${meta.coordinateQuality?` · ${meta.coordinateQuality}`:""}${state.method?` · ${state.method}`:""}`;
  actions.className="operations-selection-actions";take.type="button";take.className="secondary";take.textContent=item.workflow_state==="investigating"?"Уже в работе":"Взять в работу";take.disabled=item.workflow_state==="investigating";take.addEventListener("click",()=>platformAction({action:"update-movement",id:item.movement_id,workflowState:"investigating"}).catch(error=>nodes.platformError.textContent=error.message));actions.append(take);
  card.append(title,route,facts);if(item.predictionChanges?.length){const heading=document.createElement("b"),list=document.createElement("ul");heading.className="prediction-changes-title";heading.textContent="Изменения прогноза за 24 часа";list.className="prediction-changes";for(const change of item.predictionChanges.slice(0,5)){const entry=document.createElement("li");entry.textContent=(change.change_type||"change")+" · "+formatDate(change.detected_at)+" · "+String(change.previous??"—")+" → "+String(change.current??"—");list.append(entry);}card.append(heading,list);}if(hypotheses.length){const heading=document.createElement("b"),list=document.createElement("ol");heading.className="twin-hypotheses-title";heading.textContent="Вероятные следующие участки";list.className="twin-hypotheses";for(const [index,hypothesis] of hypotheses.slice(0,3).entries()){const entry=document.createElement("li");entry.textContent=`${index===0?"Основной":"Альтернатива"}: ${hypothesis.from_node_id} → ${hypothesis.to_node_id} · ${Math.round(Number(hypothesis.probability||0)*100)}% · ETA ${formatDate(hypothesis.eta_p50)} · ±${Math.round(Number(hypothesis.uncertainty_km||0))} км${hypothesis.geometry?"":" · без геометрии"}`;list.append(entry);}card.append(heading,list);}card.append(actions);
  form.className="station-fact-form";station.name="station";station.placeholder="Подтверждённая станция";station.required=true;note.name="note";note.placeholder="Источник или примечание";submit.type="submit";submit.textContent="Добавить факт";status.className="review-status";form.append(station,note,submit,status);form.addEventListener("submit",async event=>{event.preventDefault();submit.disabled=true;status.textContent="Сохраняем…";try{const result=await platformFetch(railIntelligenceEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:item.run_id,trainNumber:item.train_number,station:station.value,observedAt:new Date().toISOString(),reliability:.78,evidenceType:"operator_station_fact",note:note.value})});if(!result)throw new Error("Недостаточно прав для добавления станционного факта");status.dataset.tone="ok";status.textContent="Факт сохранён; автоматический пересчёт — до 5 минут.";station.value="";note.value="";await loadPlatformSuite();}catch(error){status.dataset.tone="error";status.textContent=error.message;}finally{submit.disabled=false;}});
  card.append(form);nodes.operationsSelection.append(card);
}
async function renderOperationsMap(movements=[],freightCorridors=[],freightStationFacts=[]){
  const sequence=++operationsMapRenderSequence;ensureOperationsMap();if(!operationsLayer)return;const fingerprint=JSON.stringify({movements:movements.map(item=>[item.movement_id,item.latitude,item.longitude,item.position_status,item.last_observed_at]),corridors:freightCorridors.map(item=>[item.corridorId,item.confidence,item.lastObservedAt]),facts:freightStationFacts.map(item=>[item.factId,item.occurredAt])});if(fingerprint===operationsMapFingerprint){if(selectedMovementId&&operationsMovements.has(selectedMovementId))focusOperationsMovement(selectedMovementId,{zoom:false});return;}operationsMapFingerprint=fingerprint;const stationLookup=await operationsStationLookup();if(sequence!==operationsMapRenderSequence)return;operationsLayer.clearLayers();operationsMarkers=new Map();const bounds=[];
  for(const item of movements){const lat=Number(item.latitude),lon=Number(item.longitude);if(!validUkraineOperationsPoint(lat,lon))continue;const marker=L.marker([lat,lon],{icon:L.divIcon({className:"",html:`<span class="ops-train-marker ${item.position_status==="confirmed"?"":"estimated"}">R</span>`,iconSize:[24,24],iconAnchor:[12,12]})});const content=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p");title.textContent=`Поезд ${item.train_number||item.run_id}`;const meta=operationsMetadata(item);detail.textContent=`${item.origin||"—"} → ${item.destination||"—"} · ${item.position_status||"estimated"} · ${Math.round(Number(item.confidence||0)*100)}%${Number.isFinite(Number(meta.uncertaintyKm))?` · ±${Math.round(Number(meta.uncertaintyKm))} км`:""}`;content.append(title,detail);marker.bindPopup(content);marker.on("click",()=>focusOperationsMovement(item.movement_id,{zoom:false}));marker.addTo(operationsLayer);operationsMarkers.set(item.movement_id,marker);bounds.push([lat,lon]);}
  for(const corridor of freightCorridors){const definition=FREIGHT_CORRIDOR_GEOMETRY[corridor.corridorCode];if(!definition)continue;const latLngs=definition.coordinates.map(([lon,lat])=>[lat,lon]);let shape;if(definition.kind==="area"){shape=L.polygon(latLngs,{color:"#ffad68",weight:2,opacity:.75,fillColor:"#ff9d52",fillOpacity:.08,dashArray:corridor.status==="corroborated"?null:"8 8"}).addTo(operationsLayer);}else{L.polyline(latLngs,{color:"#ff9d52",weight:Math.max(10,Math.min(28,Number(corridor.uncertaintyKm||50)/4)),opacity:.1,lineCap:"round",interactive:false}).addTo(operationsLayer);shape=L.polyline(latLngs,{color:"#ffad68",weight:4,opacity:.85,dashArray:corridor.status==="corroborated"?null:"10 9"}).addTo(operationsLayer);}const popup=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p"),evidence=document.createElement("small");title.textContent=`Грузовой ${definition.kind==="area"?"район":"коридор"} · ${definition.label}`;detail.textContent=`${corridor.status} · уверенность ${Math.round(Number(corridor.confidence||0)*100)}% · погрешность около ${corridor.uncertaintyKm} км`;evidence.textContent=`${corridor.observationCount} наблюдений · ${corridor.independentSources} источников · ${corridor.direction?`направление ${corridor.direction}`:"направление не определено"}`;popup.append(title,detail,evidence);shape.bindPopup(popup);for(const point of latLngs)bounds.push(point);if(definition.kind==="line"){const terminal=definition.terminals[normalizeOperationsStation(corridor.direction)],arrowPoint=terminal==="start"?latLngs[0]:terminal==="end"?latLngs.at(-1):null;if(arrowPoint)L.marker(arrowPoint,{icon:L.divIcon({className:"",html:'<span class="ops-freight-arrow">→</span>',iconSize:[26,26],iconAnchor:[13,13]})}).addTo(operationsLayer);}}
  for(const fact of freightStationFacts){const normalized=normalizeOperationsStation(fact.station),station=stationLookup.get(normalized),coordinates=station?.coordinates||FREIGHT_STATION_FALLBACKS.get(normalized);if(!Array.isArray(coordinates)||coordinates.length<2)continue;const [lon,lat]=coordinates;if(!validUkraineOperationsPoint(Number(lat),Number(lon)))continue;const marker=L.circleMarker([lat,lon],{radius:8,color:fact.factStatus==="confirmed"?"#5ce1c5":"#ffad68",weight:2,fillColor:"#071b23",fillOpacity:.9,dashArray:fact.factStatus==="confirmed"?null:"4 3"});const popup=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p"),excerpt=document.createElement("small");title.textContent=`Станционный факт · ${station?.name||fact.station}`;detail.textContent=`${fact.factStatus} · ${Math.round(Number(fact.confidence||0)*100)}% · ${formatDate(fact.occurredAt)}`;excerpt.textContent=fact.excerpt||fact.sourceId;popup.append(title,detail,excerpt);marker.bindPopup(popup);marker.addTo(operationsLayer);bounds.push([lat,lon]);}
  if(bounds.length&&!operationsMapHasInitialFit&&!selectedMovementId){operationsMap.fitBounds(bounds,{padding:[30,30],maxZoom:9});operationsMapHasInitialFit=true;}if(selectedMovementId&&operationsMovements.has(selectedMovementId))focusOperationsMovement(selectedMovementId,{zoom:false});setTimeout(()=>operationsMap?.invalidateSize(),0);
}
async function renderOperationsHub(data){
  if(!data)return;latestOperationsHubData=data;const movements=data.movements||[],notifications=data.notifications||[],workflows=data.workflows||[],freightCorridors=data.freightCorridors||[],freightStationFacts=data.freightStationFacts||[],freightTracks=data.freightTracks||[],visibleMovements=filterOperationsMovements(movements,workflows);if(nodes.operationsFilterCount)nodes.operationsFilterCount.textContent=visibleMovements.length+" / "+movements.length;operationsMovements=new Map(movements.map(item=>[item.movement_id,item]));const invalidCoordinates=movements.filter(item=>item.latitude!=null&&item.longitude!=null&&!validUkraineOperationsPoint(Number(item.latitude),Number(item.longitude))).length,reviewWorkflows=workflows.filter(item=>item.workflow_type==="twin_ambiguity");
  nodes.operationsHubMetrics.replaceChildren(metric("Перевозки",movements.length,"Закрытый реестр"),metric("Грузовые коридоры",freightCorridors.length,"Вероятностный слой",freightCorridors.length?"warning":"ok"),metric("Связанные сигналы",freightTracks.length,"Только по устойчивому идентификатору"),metric("Станционные факты",freightStationFacts.length,"Только явные упоминания"),metric("Задержки 1ч+",movements.filter(item=>Number(item.delay_minutes)>=60).length,"Требуют внимания"),metric("Спорные гипотезы",reviewWorkflows.length,"Требуют станционного факта",reviewWorkflows.length?"warning":"ok"),metric("Уведомления",notifications.length,"Не прочитаны",notifications.length?"warning":"ok"),metric("Геозащита",invalidCoordinates,invalidCoordinates?"Скрыты неверные координаты":"Координаты валидны",invalidCoordinates?"warning":"ok"));await renderOperationsMap(visibleMovements,freightCorridors,freightStationFacts);
  if(selectedMovementId&&!visibleMovements.some(item=>item.movement_id===selectedMovementId))selectedMovementId=null;renderOperationsSelection(selectedMovementId?operationsMovements.get(selectedMovementId):null);
  if(nodes.freightTrackRows){if(!freightTracks.length)emptyTable(nodes.freightTrackRows,"Связанные наблюдения появятся после повторной фиксации устойчивого идентификатора.",6);else{nodes.freightTrackRows.replaceChildren();for(const track of freightTracks.slice(0,100)){const row=document.createElement("tr");if(track.linkedMovementId){row.className="linked-track";row.addEventListener("click",()=>focusOperationsMovement(track.linkedMovementId));}appendCell(row,track.locomotive||track.trainNumber||track.trackId);appendCell(row,(track.corridorCodes||[]).join(", ")||"—");appendCell(row,track.direction||"—");appendCell(row,(track.stationSequence||[]).map(item=>item.station).join(" → ")||"—");appendCell(row,track.independentSources);appendCell(row,`${Math.round(Number(track.confidence||0)*100)}%`,`status-pill ${track.status}`);nodes.freightTrackRows.append(row);}}}
  if(!visibleMovements.length)emptyTable(nodes.operationsMovementRows,"Активных перевозок пока нет.",7);else{nodes.operationsMovementRows.replaceChildren();for(const item of visibleMovements.slice(0,250)){const row=document.createElement("tr");row.className="operations-movement-row";row.dataset.movementId=item.movement_id;row.classList.toggle("selected",item.movement_id===selectedMovementId);row.addEventListener("click",()=>focusOperationsMovement(item.movement_id));appendCell(row,item.train_number||item.run_id);appendCell(row,`${item.origin||"—"} → ${item.destination||"—"}`);appendCell(row,item.status,`status-pill ${item.status}`);appendCell(row,item.delay_minutes==null?"—":`${Math.round(item.delay_minutes)} мин`);appendCell(row,formatDate(item.eta));appendCell(row,item.last_station||formatAge(item.last_observed_at));const cell=document.createElement("td"),select=document.createElement("select");select.className="workflow-select";for(const value of ["monitoring","attention","investigating","resolved"]){const option=document.createElement("option");option.value=value;option.textContent=value;option.selected=value===item.workflow_state;select.append(option);}select.addEventListener("click",event=>event.stopPropagation());select.addEventListener("change",()=>platformAction({action:"update-movement",id:item.movement_id,workflowState:select.value}).catch(error=>nodes.platformError.textContent=error.message));cell.append(select);row.append(cell);nodes.operationsMovementRows.append(row);}}
  nodes.operationsNotifications.replaceChildren();
  for(const item of reviewWorkflows.slice(0,30)){const card=document.createElement("article"),title=document.createElement("b"),message=document.createElement("small"),show=document.createElement("button");card.className="notification-item medium twin-review-item";title.textContent=item.title;message.textContent=item.description||"Неоднозначная траектория требует нового станционного факта.";show.className="secondary";show.textContent="Открыть поезд";show.disabled=!operationsMovements.has(item.movement_id);show.addEventListener("click",()=>focusOperationsMovement(item.movement_id));card.append(title,message,show);nodes.operationsNotifications.append(card);}
  if(!notifications.length&&!reviewWorkflows.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="Новых уведомлений нет.";nodes.operationsNotifications.append(empty);}else for(const item of notifications.slice(0,50)){const card=document.createElement("article"),title=document.createElement("b"),message=document.createElement("small"),actions=document.createElement("div"),show=document.createElement("button"),take=document.createElement("button"),ack=document.createElement("button");card.className=`notification-item ${item.severity}`;title.textContent=item.title;message.textContent=item.message;actions.className="notification-actions";show.className="secondary";show.textContent="Показать";show.disabled=!operationsMovements.has(item.movement_id);show.addEventListener("click",()=>focusOperationsMovement(item.movement_id));take.className="secondary";take.textContent="В работу";take.disabled=!operationsMovements.has(item.movement_id);take.addEventListener("click",()=>platformAction({action:"update-movement",id:item.movement_id,workflowState:"investigating"}).catch(error=>nodes.platformError.textContent=error.message));ack.className="secondary";ack.textContent="Прочитано";ack.addEventListener("click",()=>platformAction({action:"ack-notification",id:item.notification_id}).catch(error=>nodes.platformError.textContent=error.message));actions.append(show,take,ack);card.append(title,message,actions);nodes.operationsNotifications.append(card);}
}
function renderAnalyticsNetwork(data){if(!data)return;const activity=data.nodeActivity||[],anomalies=data.anomalies||[],corridors=data.corridors||[],calibration=data.calibration||{},qualityGate=data.qualityGate||{},cycles=data.cycles||[],profiles=data.calibrationProfiles||[];nodes.analyticsNetworkMetrics.replaceChildren(metric("Активные узлы",activity.length,"Node Activity Score"),metric("Аномалии",anomalies.length,"Открытые сигналы",anomalies.length?"warning":"ok"),metric("MAE",calibration.maeMinutes==null?"—":`${calibration.maeMinutes} мин`,`${calibration.prospectiveEvaluations||0} live · ${calibration.replayEvaluations||0} replay`),metric("P80",calibration.p80Coverage==null?"—":`${calibration.p80Coverage}%`,calibration.readiness||"insufficient-evidence"),metric("Автономные циклы",cycles.filter(item=>item.status==="success").length,"Успешные запуски"));
  nodes.analyticsNetworkMetrics.append(metric("\u041f\u0440\u043e\u0444\u0438\u043b\u0438 \u043c\u043e\u0434\u0435\u043b\u0438",calibration.operationalProfiles||0,`${calibration.warmingProfiles||0} warming`,calibration.operationalProfiles?"ok":"warning"));
  nodes.analyticsNetworkMetrics.append(metric("QUALITY GATE",qualityGate.status||"insufficient-evidence",(qualityGate.samples||0)+" перспективных проверок",qualityGate.status==="degraded"?"warning":qualityGate.status==="healthy"?"ok":"neutral"));
  const latestCycle=cycles[0]||{};
  nodes.analyticsNetworkMetrics.append(metric("Fusion v3",latestCycle.fused_observations||0,`${latestCycle.fusion_ambiguous||0} \u043a\u043e\u043d\u0444\u043b\u0438\u043a\u0442\u043e\u0432`,Number(latestCycle.fusion_ambiguous)?"warning":"ok"),metric("Twin v4",latestCycle.twins_recalculated||0,"\u041f\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u043d\u043e \u043f\u043e \u043d\u043e\u0432\u044b\u043c \u0444\u0430\u043a\u0442\u0430\u043c"),metric("\u041f\u043e\u043a\u0440\u044b\u0442\u0438\u0435 \u0442\u0430\u0431\u043b\u043e",latestCycle.board_priorities||0,"\u0410\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u044b\u0435 \u043f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442\u044b \u0441\u0442\u0430\u043d\u0446\u0438\u0439"));
  if(nodes.calibrationProfileRows){if(!profiles.length)emptyTable(nodes.calibrationProfileRows,"Профили появятся после накопления проверок «прогноз → факт».",8);else{nodes.calibrationProfileRows.replaceChildren();for(const item of profiles.slice(0,250)){const row=document.createElement("tr");appendCell(row,item.dimension_type);appendCell(row,item.dimension_key);appendCell(row,item.evaluation_count);appendCell(row,item.prospective_count);appendCell(row,item.mae_minutes==null?"—":`${Number(item.mae_minutes).toFixed(1)} мин`);appendCell(row,item.p80_coverage==null?"—":`${Number(item.p80_coverage).toFixed(1)}%`);appendCell(row,`bias ${Number(item.bias_minutes||0).toFixed(1)} · ×${Number(item.uncertainty_multiplier||1).toFixed(2)}`);appendCell(row,item.readiness,`status-pill ${item.readiness==="operational"?"online":item.readiness==="warming"?"neutral":"unknown"}`);nodes.calibrationProfileRows.append(row);}}}  if(!activity.length)emptyTable(nodes.nodeActivityRows,"Оценки появятся после первого автономного цикла.",5);else{nodes.nodeActivityRows.replaceChildren();for(const item of activity.slice(0,100)){const row=document.createElement("tr");appendCell(row,item.station_name||item.node_id);const score=appendCell(row,item.activity_score,"activity-score");score.title=`baseline ${item.baseline_per_hour}`;appendCell(row,item.observation_count);appendCell(row,`${Number(item.change_ratio||1).toFixed(1)}×`);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);nodes.nodeActivityRows.append(row);}}
  if(!anomalies.length)emptyTable(nodes.networkAnomalyRows,"Сетевых аномалий не обнаружено.",5);else{nodes.networkAnomalyRows.replaceChildren();for(const item of anomalies.slice(0,100)){const row=document.createElement("tr");appendCell(row,formatDate(item.detected_at));appendCell(row,item.node_id||item.corridor_id||"—");appendCell(row,item.anomaly_type);appendCell(row,item.severity,`status-pill ${item.severity}`);appendCell(row,item.summary);nodes.networkAnomalyRows.append(row);}}
  nodes.internationalCorridors.replaceChildren();for(const item of corridors){const card=document.createElement("article"),title=document.createElement("b"),detail=document.createElement("small");card.className="corridor-card";title.textContent=item.name;detail.textContent=`${(item.countries||[]).join(" ↔ ")} · activity ${Number(item.activity_score||0).toFixed(1)} · ${item.status}`;card.append(title,detail);nodes.internationalCorridors.append(card);}
}

async function loadPlatformSuite(){try{const [rail,operations,analytics]=await Promise.all([platformFetch(railIntelligenceEndpoint),platformFetch(operationsHubEndpoint),platformFetch(analyticsNetworkEndpoint)]);renderRailIntelligence(rail);await renderOperationsHub(operations);renderAnalyticsNetwork(analytics);nodes.platformUpdatedAt.textContent=`Обновлено ${formatDate(new Date().toISOString())}`;nodes.platformError.textContent="";}catch(error){nodes.platformError.textContent=error.message;}}
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
      accessUsersEndpoint = new URL("/api/admin/access/users", `${base}/`).toString();
      accessAuditEndpoint = new URL("/api/admin/access/audit", `${base}/`).toString();
      authMeEndpoint = new URL("/api/auth/me", `${base}/`).toString();
      railIntelligenceEndpoint = new URL("/api/restricted/rail-intelligence", `${base}/`).toString();
      operationsHubEndpoint = new URL("/api/restricted/operations-hub", `${base}/`).toString();
      analyticsNetworkEndpoint = new URL("/api/restricted/analytics-network", `${base}/`).toString();
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
    await loadAccessManagement();
    nodes.loginPanel.hidden = true;
    await loadPlatformSuite();
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
  nodes.accessPanel.hidden = true;
  clearInterval(refreshTimer);
  sessionStorage.removeItem("rail-ops-token");
  nodes.dashboard.hidden = true;
  nodes.loginPanel.hidden = false;
  setConnection("Ожидание", "idle");
}

nodes.loginForm.addEventListener("submit", login);
nodes.accessCreateForm.addEventListener("submit",createAccessUser);
document.querySelector("#access-copy-key").addEventListener("click",async()=>{const status=document.querySelector("#access-key-copy-status");try{await navigator.clipboard.writeText(nodes.accessKeyValue.textContent);status.textContent="Ключ скопирован.";}catch{status.textContent="Не удалось скопировать автоматически — выделите ключ вручную.";}});

for(const button of document.querySelectorAll("[data-platform-tab]")){button.addEventListener("click",()=>{const target=button.dataset.platformTab;for(const item of document.querySelectorAll("[data-platform-tab]"))item.classList.toggle("active",item===button);for(const panel of document.querySelectorAll("[data-platform-panel]")){const active=panel.dataset.platformPanel===target;panel.hidden=!active;panel.classList.toggle("active",active);}if(target==="operations")setTimeout(()=>operationsMap?.invalidateSize(),0);});}
nodes.operationsFilters?.addEventListener("click",event=>{const button=event.target.closest("[data-operations-filter]");if(!button)return;operationsFilter=button.dataset.operationsFilter;for(const item of nodes.operationsFilters.querySelectorAll("[data-operations-filter]"))item.classList.toggle("active",item===button);operationsMapFingerprint="";if(latestOperationsHubData)renderOperationsHub(latestOperationsHubData).catch(error=>nodes.platformError.textContent=error.message);});
document.querySelector("#retry-collector")?.addEventListener("click",()=>adminAction({action:"retry-collector"}).then(refresh).catch(error=>{nodes.systemCaption.textContent=error.message;}));
nodes.refreshButton.addEventListener("click", () => refresh().catch((error) => { nodes.systemCaption.textContent = error.message; }));
document.querySelector("#logout-button").addEventListener("click", logout);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token) refresh().catch(() => {});
});

initializeCollapsibleLists();
initializeLargePanels();
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
