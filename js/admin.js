const loginCard = document.querySelector("#login-form");
const accountLoginLabel = document.createElement("label");
accountLoginLabel.htmlFor = "account-login";
accountLoginLabel.textContent = "Логин сотрудника (для ролевого доступа)";
const accountLoginInput = document.createElement("input");
accountLoginInput.id = "account-login"; accountLoginInput.autocomplete = "username";
accountLoginInput.placeholder = "Например: curator.kyiv";
loginCard.querySelector(".card-kicker").after(accountLoginLabel, accountLoginInput);
loginCard.querySelector('label[for="admin-token"]').textContent = "Ключ доступа или legacy admin token";

const accessPanel=document.createElement("section");accessPanel.id="access-management";accessPanel.className="panel access-management";accessPanel.hidden=true;
accessPanel.innerHTML=`<header class="panel-header"><div><p class="eyebrow">ACCESS CONTROL</p><h2>Пользователи и права</h2></div><div class="access-summary"><span id="access-user-count" class="tag">—</span><span id="access-session-count" class="tag">—</span></div></header>
  <p class="muted">Персональные аккаунты, роли и активные сессии закрытого контура. Legacy admin token остаётся только аварийным способом входа.</p>
  <form id="access-create-form" class="access-create-form">
    <label><span>Логин</span><input id="access-login" required minlength="3" maxlength="64" pattern="[a-z0-9._-]+" placeholder="curator.kyiv"></label>
    <label><span>Имя</span><input id="access-display-name" required maxlength="120" placeholder="Куратор Киев"></label>
    <label><span>Роль</span><select id="access-role"></select></label>
    <button type="submit">Создать пользователя</button>
  </form>
  <p id="access-error" class="error" role="alert"></p>
  <div class="table-wrap"><table class="access-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th>Сессии</th><th>Действия</th></tr></thead><tbody id="access-user-rows"></tbody></table></div>
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
  operationsHubMetrics: document.querySelector("#operations-hub-metrics"),
  operationsMovementRows: document.querySelector("#operations-movement-rows"),
  operationsNotifications: document.querySelector("#operations-notifications"),
  analyticsNetworkMetrics: document.querySelector("#analytics-network-metrics"),
  nodeActivityRows: document.querySelector("#node-activity-rows"),
  networkAnomalyRows: document.querySelector("#network-anomaly-rows"),
  internationalCorridors: document.querySelector("#international-corridors"),
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
let operationsMap=null,operationsLayer=null;

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
  nodes.cycleChart?.replaceChildren(...cycles.slice().reverse().map(cycle=>{const bar=document.createElement("i");bar.className=cycle.status==="success"?"ok":cycle.status==="running"?"running":"error";bar.style.height=`${Math.max(8,Math.min(100,Number(cycle.duration_ms||0)/100))}%`;bar.title=`${formatDate(cycle.started_at)} · ${cycle.status} · ${cycle.duration_ms||0} ms${cycle.error?` · ${cycle.error}`:""}`;return bar;}));
  nodes.intelligenceMetrics?.replaceChildren(metric("Циклы 24ч",cycles.length,"История collector"),metric("MAE модели",quality.maeMinutes==null?"—":`${quality.maeMinutes} мин`,`${quality.evaluations||0} проверок`,quality.maeMinutes>20?"warning":"ok"),metric("Покрытие P80",quality.p80Coverage==null?"—":`${quality.p80Coverage}%`,"Доля фактов внутри коридора",quality.p80Coverage!=null&&quality.p80Coverage<65?"warning":"ok"),metric("Источники 24ч",health.length,unstable?`${unstable} нестабильных`:"Стабильны",unstable?"warning":"ok"),metric("Карантин",quarantine.filter(x=>x.status==="open").length,"Требуют решения",quarantine.some(x=>x.status==="open")?"warning":"ok"),metric("Без полного маршрута",incomplete.length,"Нужна геометрия"));
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

function renderRailIntelligence(data){if(!data)return;const counts=data.counts||{};nodes.railIntelligenceMetrics.replaceChildren(metric("Узлы графа",counts.nodes||0,"Наблюдаемые станции"),metric("Рёбра графа",counts.edges||0,"Изученные перегоны"),metric("Наблюдения",counts.observations||0,"Трассируемые факты"),metric("Активные прогнозы",counts.pendingPredictions||0,"Цифровые двойники"),metric("Закрытые прогнозы",counts.resolvedPredictions||0,"Доступны для калибровки"));
  const twins=data.twins||[];if(!twins.length)emptyTable(nodes.railTwinRows,"Прогнозы появятся после накопления последовательных станционных фактов.",6);else{nodes.railTwinRows.replaceChildren();for(const item of twins.slice(0,80)){const row=document.createElement("tr");appendCell(row,item.train_number||item.run_id);appendCell(row,`${item.from_node_id} → ${item.to_node_id}`);appendCell(row,formatDate(item.eta_p50));appendCell(row,`${formatDate(item.eta_p80_start)} — ${formatDate(item.eta_p80_end)}`);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);appendCell(row,item.status,`status-pill ${item.status}`);nodes.railTwinRows.append(row);}}
  const observations=data.observations||[];if(!observations.length)emptyTable(nodes.railObservationRows,"Подтверждённых наблюдений пока нет.",5);else{nodes.railObservationRows.replaceChildren();for(const item of observations.slice(0,100)){const row=document.createElement("tr");appendCell(row,formatDate(item.observed_at));appendCell(row,item.train_number||item.run_id);appendCell(row,item.station_name);appendCell(row,item.source_id);appendCell(row,`${Math.round(Number(item.reliability||0)*100)}%`);nodes.railObservationRows.append(row);}}
}

const FREIGHT_CORRIDOR_GEOMETRY={"kyiv-korosten":{label:"Київ — Коростень",coordinates:[[30.484,50.4406],[30.259,50.521],[29.917,50.64],[29.25,50.77],[28.642,50.953]],terminals:{"київ":"start","киев":"start","коростень":"end"}}};
const FREIGHT_STATION_FALLBACKS=new Map([["київ",[30.484,50.4406]],["киев",[30.484,50.4406]],["ірпінь",[30.259,50.521]],["ирпень",[30.259,50.521]],["коростень",[28.642,50.953]]]);
let operationsStationLookupPromise=null,operationsMapRenderSequence=0;
function normalizeOperationsStation(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu,"").trim();}
function operationsStationLookup(){if(!operationsStationLookupPromise)operationsStationLookupPromise=fetch("data/stations.json",{cache:"force-cache"}).then(response=>response.ok?response.json():{stations:[]}).then(data=>{const lookup=new Map();for(const station of data.stations||[])for(const name of [station.name,...(station.aliases||[])])lookup.set(normalizeOperationsStation(name),station);return lookup;}).catch(()=>new Map());return operationsStationLookupPromise;}
function ensureOperationsMap(){if(operationsMap||!window.L||!document.querySelector("#operations-map"))return;operationsMap=L.map("operations-map",{zoomControl:true,attributionControl:true}).setView([49.1,31.2],6);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:"© OpenStreetMap"}).addTo(operationsMap);operationsLayer=L.layerGroup().addTo(operationsMap);}
async function renderOperationsMap(movements=[],freightCorridors=[],freightStationFacts=[]){
  const sequence=++operationsMapRenderSequence;ensureOperationsMap();if(!operationsLayer)return;const stationLookup=await operationsStationLookup();if(sequence!==operationsMapRenderSequence)return;operationsLayer.clearLayers();const bounds=[];
  for(const item of movements){const lat=Number(item.latitude),lon=Number(item.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;const marker=L.marker([lat,lon],{icon:L.divIcon({className:"",html:`<span class="ops-train-marker ${item.position_status==="confirmed"?"":"estimated"}">R</span>`,iconSize:[24,24],iconAnchor:[12,12]})});const content=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p");title.textContent=`Поезд ${item.train_number||item.run_id}`;detail.textContent=`${item.origin||"—"} → ${item.destination||"—"} · ${item.position_status||"estimated"} · ${Math.round(Number(item.confidence||0)*100)}%`;content.append(title,detail);marker.bindPopup(content);marker.addTo(operationsLayer);bounds.push([lat,lon]);}
  for(const corridor of freightCorridors){const definition=FREIGHT_CORRIDOR_GEOMETRY[corridor.corridorCode];if(!definition)continue;const latLngs=definition.coordinates.map(([lon,lat])=>[lat,lon]);L.polyline(latLngs,{color:"#ff9d52",weight:Math.max(10,Math.min(28,Number(corridor.uncertaintyKm||50)/4)),opacity:.1,lineCap:"round",interactive:false}).addTo(operationsLayer);const line=L.polyline(latLngs,{color:"#ffad68",weight:4,opacity:.85,dashArray:corridor.status==="corroborated"?null:"10 9"}).addTo(operationsLayer);const popup=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p"),evidence=document.createElement("small");title.textContent=`Грузовой коридор · ${definition.label}`;detail.textContent=`${corridor.status} · уверенность ${Math.round(Number(corridor.confidence||0)*100)}% · погрешность около ${corridor.uncertaintyKm} км`;evidence.textContent=`${corridor.observationCount} наблюдений · ${corridor.independentSources} источников · ${corridor.direction?`направление ${corridor.direction}`:"направление не определено"}`;popup.append(title,detail,evidence);line.bindPopup(popup);for(const point of latLngs)bounds.push(point);const terminal=definition.terminals[normalizeOperationsStation(corridor.direction)],arrowPoint=terminal==="start"?latLngs[0]:terminal==="end"?latLngs.at(-1):null;if(arrowPoint)L.marker(arrowPoint,{icon:L.divIcon({className:"",html:'<span class="ops-freight-arrow">→</span>',iconSize:[26,26],iconAnchor:[13,13]})}).addTo(operationsLayer);}
  for(const fact of freightStationFacts){const normalized=normalizeOperationsStation(fact.station),station=stationLookup.get(normalized),coordinates=station?.coordinates||FREIGHT_STATION_FALLBACKS.get(normalized);if(!Array.isArray(coordinates)||coordinates.length<2)continue;const [lon,lat]=coordinates,marker=L.circleMarker([lat,lon],{radius:8,color:fact.factStatus==="confirmed"?"#5ce1c5":"#ffad68",weight:2,fillColor:"#071b23",fillOpacity:.9,dashArray:fact.factStatus==="confirmed"?null:"4 3"});const popup=document.createElement("div"),title=document.createElement("strong"),detail=document.createElement("p"),excerpt=document.createElement("small");title.textContent=`Станционный факт · ${station?.name||fact.station}`;detail.textContent=`${fact.factStatus} · ${Math.round(Number(fact.confidence||0)*100)}% · ${formatDate(fact.occurredAt)}`;excerpt.textContent=fact.excerpt||fact.sourceId;popup.append(title,detail,excerpt);marker.bindPopup(popup);marker.addTo(operationsLayer);bounds.push([lat,lon]);}
  if(bounds.length)operationsMap.fitBounds(bounds,{padding:[30,30],maxZoom:9});setTimeout(()=>operationsMap?.invalidateSize(),0);
}
async function renderOperationsHub(data){if(!data)return;const movements=data.movements||[],notifications=data.notifications||[],workflows=data.workflows||[],freightCorridors=data.freightCorridors||[],freightStationFacts=data.freightStationFacts||[];nodes.operationsHubMetrics.replaceChildren(metric("Перевозки",movements.length,"Закрытый реестр"),metric("Грузовые коридоры",freightCorridors.length,"Вероятностный слой",freightCorridors.length?"warning":"ok"),metric("Станционные факты",freightStationFacts.length,"Только явные упоминания"),metric("Задержки 1ч+",movements.filter(item=>Number(item.delay_minutes)>=60).length,"Требуют внимания"),metric("Уведомления",notifications.length,"Не подтверждены",notifications.length?"warning":"ok"),metric("Workflow",workflows.length,"Открытые задачи"));await renderOperationsMap(movements,freightCorridors,freightStationFacts);
  if(!movements.length)emptyTable(nodes.operationsMovementRows,"Активных перевозок пока нет.",7);else{nodes.operationsMovementRows.replaceChildren();for(const item of movements.slice(0,250)){const row=document.createElement("tr");appendCell(row,item.train_number||item.run_id);appendCell(row,`${item.origin||"—"} → ${item.destination||"—"}`);appendCell(row,item.status,`status-pill ${item.status}`);appendCell(row,item.delay_minutes==null?"—":`${Math.round(item.delay_minutes)} мин`);appendCell(row,formatDate(item.eta));appendCell(row,item.last_station||formatAge(item.last_observed_at));const cell=document.createElement("td"),select=document.createElement("select");select.className="workflow-select";for(const value of ["monitoring","attention","investigating","resolved"]){const option=document.createElement("option");option.value=value;option.textContent=value;option.selected=value===item.workflow_state;select.append(option);}select.addEventListener("change",()=>platformAction({action:"update-movement",id:item.movement_id,workflowState:select.value}).catch(error=>nodes.platformError.textContent=error.message));cell.append(select);row.append(cell);nodes.operationsMovementRows.append(row);}}
  nodes.operationsNotifications.replaceChildren();if(!notifications.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="Новых уведомлений нет.";nodes.operationsNotifications.append(empty);}else for(const item of notifications.slice(0,50)){const card=document.createElement("article"),title=document.createElement("b"),message=document.createElement("small"),button=document.createElement("button");card.className=`notification-item ${item.severity}`;title.textContent=item.title;message.textContent=item.message;button.className="secondary";button.textContent="Подтвердить";button.addEventListener("click",()=>platformAction({action:"ack-notification",id:item.notification_id}).catch(error=>nodes.platformError.textContent=error.message));card.append(title,message,button);nodes.operationsNotifications.append(card);}
}

function renderAnalyticsNetwork(data){if(!data)return;const activity=data.nodeActivity||[],anomalies=data.anomalies||[],corridors=data.corridors||[],calibration=data.calibration||{},cycles=data.cycles||[];nodes.analyticsNetworkMetrics.replaceChildren(metric("Активные узлы",activity.length,"Node Activity Score"),metric("Аномалии",anomalies.length,"Открытые сигналы",anomalies.length?"warning":"ok"),metric("MAE",calibration.maeMinutes==null?"—":`${calibration.maeMinutes} мин`,`${calibration.evaluations||0} проверок`),metric("P80",calibration.p80Coverage==null?"—":`${calibration.p80Coverage}%`,"Факты внутри коридора"),metric("Автономные циклы",cycles.filter(item=>item.status==="success").length,"Успешные запуски"));
  if(!activity.length)emptyTable(nodes.nodeActivityRows,"Оценки появятся после первого автономного цикла.",5);else{nodes.nodeActivityRows.replaceChildren();for(const item of activity.slice(0,100)){const row=document.createElement("tr");appendCell(row,item.station_name||item.node_id);const score=appendCell(row,item.activity_score,"activity-score");score.title=`baseline ${item.baseline_per_hour}`;appendCell(row,item.observation_count);appendCell(row,`${Number(item.change_ratio||1).toFixed(1)}×`);appendCell(row,`${Math.round(Number(item.confidence||0)*100)}%`);nodes.nodeActivityRows.append(row);}}
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