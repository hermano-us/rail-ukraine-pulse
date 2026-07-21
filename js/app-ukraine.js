import { loadTransportData } from "./data-store-ukraine.js?v=20260720-event-backend";
import { loadRuntimeConfig, subscribeToLiveUpdates } from "./live-data-client.js";
import { MapView } from "./map-view-ukraine.js";
import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS, TRANSPORT_LABELS, TYPE_LABELS, escapeHtml, formatDateTime, formatRelative } from "./formatters-ukraine.js";

const HISTORY_KEY="rail-ukraine-pulse:run-history:v2";
const FAVORITES_KEY="rail-ukraine-pulse:favorites:v1";
function readFavorites(){try{return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY)||"[]"));}catch{return new Set();}}
const LAYOUT_KEY="rail-ukraine-pulse:workspace-layout:v1";
const state={
  data:null,transport:"all",favorites:readFavorites(),statuses:new Set(Object.keys(POSITION_STATUSES)),
  operations:new Set(Object.keys(OPERATION_LABELS)),regions:new Set(),minConfidence:0,
  query:"",quick:"all",sort:"delay",selected:null,followedId:null,
};
const $=(selector)=>document.querySelector(selector);
const elements={
  sidebar:$("#sidebar"),detail:$("#detail-panel"),detailContent:$("#detail-content"),
  statusFilters:$("#status-filters"),operationFilters:$("#operation-filters"),regionFilters:$("#region-filters"),
  confidenceRange:$("#confidence-range"),confidenceOutput:$("#confidence-output"),visibleCount:$("#visible-count"),
  toast:$("#toast"),search:$("#object-search"),liveFeed:$("#live-feed"),liveFeedCount:$("#live-feed-count"),
  freightStatus:$("#freight-status"),fleetPanel:$("#fleet-panel"),fleetList:$("#fleet-list"),fleetCount:$("#fleet-count"),
  fleetSort:$("#fleet-sort"),regionSummary:$("#region-summary"),systemStatus:$("#system-status"),
  sourceRegistryList:$("#source-registry-list"),
};
const mapView=new MapView("map",selectObject);
const layoutState=(()=>{
  try{return {...{leftCollapsed:false,rightCollapsed:false,mapOnly:false},...JSON.parse(localStorage.getItem(LAYOUT_KEY)||"{}")};}
  catch{return {leftCollapsed:false,rightCollapsed:false,mapOnly:false};}
})();

function persistLayout(){
  try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layoutState));}catch{}
}

function updateLayoutButtons(){
  const leftHidden=layoutState.leftCollapsed||layoutState.mapOnly;
  const rightHidden=layoutState.rightCollapsed||layoutState.mapOnly;
  $("#left-panel-toggle")?.setAttribute("aria-pressed",String(leftHidden));
  $("#left-panel-toggle")?.setAttribute("aria-label",leftHidden?"Развернуть левую панель":"Свернуть левую панель");
  $("#fleet-toggle")?.setAttribute("aria-pressed",String(rightHidden));
  $("#fleet-toggle")?.setAttribute("aria-label",rightHidden?"Развернуть реестр":"Свернуть реестр");
  $("#map-only-toggle")?.setAttribute("aria-pressed",String(layoutState.mapOnly));
}

function applyWorkspaceLayout(){
  const shell=document.querySelector(".app-shell");
  shell.classList.toggle("left-collapsed",layoutState.leftCollapsed||layoutState.mapOnly);
  shell.classList.toggle("right-collapsed",layoutState.rightCollapsed||layoutState.mapOnly);
  shell.classList.toggle("map-only",layoutState.mapOnly);
  if(layoutState.mapOnly){elements.sidebar.classList.remove("open");elements.fleetPanel.classList.remove("open");}
  updateLayoutButtons();persistLayout();
  window.setTimeout(()=>mapView.invalidateSize(),270);
}

function readHistory(){
  try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||"{}");}catch{return {};}
}
function persistHistory(data){
  const store=readHistory();
  for(const object of data.objects){
    if(!object.position.coordinates)continue;
    const entries=Array.isArray(store[object.runId])?store[object.runId]:[];
    const calculatedAt=object.position.calculatedAt||data.calculatedAt||new Date().toISOString();
    const bucketMs=Math.floor(Date.parse(calculatedAt)/(15*60_000))*(15*60_000);
    const timestamp=new Date(bucketMs).toISOString();
    if(!entries.some((entry)=>entry.timestamp===timestamp)){
      entries.push({
        timestamp,coordinates:object.position.coordinates,status:object.position.status,
        confidence:object.position.confidence,errorKm:object.position.errorKm,
        delayMinutes:object.liveUpdate?.delayMinutes??null,
        label:`Расчётный снимок · задержка ${object.liveUpdate?.delayLabel||"—"}`,
        evidence:object.position.status==="estimated"?"calculated":"reported",
      });
    }
    store[object.runId]=entries.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).slice(-48);
    object.history=store[object.runId];
  }
  try{localStorage.setItem(HISTORY_KEY,JSON.stringify(store));}catch{}
}

function checkboxTemplate(key,label,color,group){
  return `<label class="status-toggle" style="--status-color:${color}"><input type="checkbox" value="${key}" data-group="${group}" checked><span class="check">✓</span><span>${label}</span></label>`;
}

function initDynamicFilters(){
  elements.statusFilters.innerHTML=Object.entries(POSITION_STATUSES).map(([key,item])=>checkboxTemplate(key,item.label,item.color,"status")).join("");
  elements.operationFilters.innerHTML=Object.entries(OPERATION_LABELS).map(([key,label])=>checkboxTemplate(key,label,OPERATION_COLORS[key],"operation")).join("");
  const handle=(event)=>{
    const set=event.target.dataset.group==="status"?state.statuses:state.operations;
    event.target.checked?set.add(event.target.value):set.delete(event.target.value);render();
  };
  elements.statusFilters.addEventListener("change",handle);
  elements.operationFilters.addEventListener("change",handle);
}

function initRegions(){
  state.regions=new Set(state.data.regionList.map((region)=>region.id));
  elements.regionFilters.innerHTML=state.data.regionList.map((region)=>`<label class="region-toggle"><input type="checkbox" value="${region.id}" checked><span>${region.name}</span></label>`).join("");
  elements.regionFilters.addEventListener("change",(event)=>{
    event.target.checked?state.regions.add(event.target.value):state.regions.delete(event.target.value);render();
  });
  mapView.setRegions(state.data.regions,state.regions);
}

function matchesQuick(object){
  if(state.quick==="moving")return object.operationalStatus==="moving";
  if(state.quick==="delayed")return Number(object.liveUpdate?.delayMinutes||0)>=60;
  if(state.quick==="fresh")return object.position.freshness?.key==="fresh";
  if(state.quick==="stale")return ["stale","unknown"].includes(object.position.status);
  if(state.quick==="unknown")return object.position.status==="unknown";
  if(state.quick==="favorites")return state.favorites.has(object.runId);
  return true;
}

function filteredObjects(){
  const query=state.query.trim().toLocaleLowerCase("uk");
  const allRegions=state.regions.size===state.data.regionList.length;
  return state.data.objects.filter((object)=>{
    const matchesTransport=state.transport==="all"||object.transport===state.transport;
    const matchesRegion=state.regions.size>0&&((object.regions||[]).some((id)=>state.regions.has(id))||(allRegions&&!(object.regions||[]).length));
    const haystack=`${object.name} ${object.trainNumber} ${object.route} ${object.origin} ${object.destination} ${object.description}`.toLocaleLowerCase("uk");
    return matchesTransport&&matchesRegion&&(!query||haystack.includes(query))&&matchesQuick(object)
      &&state.statuses.has(object.position.status)&&state.operations.has(object.operationalStatus)
      &&(object.position.confidence??0)>=state.minConfidence;
  });
}

function sortedObjects(objects){
  const copy=[...objects];
  if(state.sort==="number")return copy.sort((a,b)=>String(a.trainNumber).localeCompare(String(b.trainNumber),"ru",{numeric:true}));
  if(state.sort==="quality")return copy.sort((a,b)=>b.quality-a.quality);
  if(state.sort==="updated")return copy.sort((a,b)=>Date.parse(b.position.updatedAt||0)-Date.parse(a.position.updatedAt||0));
  return copy.sort((a,b)=>Number(b.liveUpdate?.delayMinutes||0)-Number(a.liveUpdate?.delayMinutes||0));
}

function renderLiveFeed(){
  const updates=(state.data.liveFeed||[]).slice(0,5);
  elements.liveFeedCount.textContent=`${state.data.liveFeed.length} событий`;
  if(!updates.length){elements.liveFeed.innerHTML='<p class="feed-empty">Свежих публичных статусов пока нет</p>';return;}
  elements.liveFeed.innerHTML=updates.map((update)=>{
    const object=state.data.objects.find((item)=>item.id===update.objectId);
    return `<button class="feed-item" data-object-id="${escapeHtml(object?.id||"")}"><span class="feed-number">№${escapeHtml(update.trainNumber)}</span><span class="feed-route"><strong>${escapeHtml(update.route||"Маршрут не указан")}</strong><small>${escapeHtml(update.publicStatus||"Статус УЗ")} · ${formatRelative(update.updatedAt)}</small></span><span class="feed-delay">${escapeHtml(update.delayLabel||"—")}</span></button>`;
  }).join("");
}

function qualityClass(value){return value>=.72?"high":value>=.5?"medium":"low";}

function renderFleet(objects){
  const sorted=sortedObjects(objects);
  elements.fleetCount.textContent=`${sorted.length} рейсов`;
  $("#fleet-source-age").textContent=`снимок ${formatRelative(state.data.generatedAt)}`;
  if(!sorted.length){elements.fleetList.innerHTML='<p class="fleet-empty">Нет рейсов по выбранным фильтрам</p>';return;}
  elements.fleetList.innerHTML=sorted.map((object)=>{
    const position=POSITION_STATUSES[object.position.status],delay=object.liveUpdate?.delayMinutes;
    const selected=state.selected?.id===object.id?" selected":"";
    return `<button class="fleet-card${selected}" data-object-id="${escapeHtml(object.id)}">
      <span class="fleet-status" style="--fleet-color:${position.color}"></span>
      <span class="fleet-main"><strong>№${escapeHtml(object.trainNumber)} <i>${escapeHtml(object.liveUpdate?.publicStatus||"")}</i></strong><b>${escapeHtml(object.origin)} <em>→</em> ${escapeHtml(object.destination)}</b><small>Обновлено ${formatRelative(object.liveUpdate?.updatedAt)} · ${position.label}</small></span>
      <span class="fleet-meta"><strong>${escapeHtml(object.liveUpdate?.delayLabel||"—")}</strong><small class="quality-${qualityClass(object.quality)}">Q ${Math.round(object.quality*100)}</small></span>
    </button>`;
  }).join("");
}

function renderRegionSummary(objects){
  const names=state.data.regionList.filter((region)=>state.regions.has(region.id)).map((region)=>region.name);
  const delayed=objects.filter((object)=>Number(object.liveUpdate?.delayMinutes||0)>=60).length;
  const positioned=objects.filter((object)=>object.position.coordinates).length;
  const title=names.length===state.data.regionList.length?"Все выбранные области":names.length===1?names[0]:`${names.length} областей выбрано`;
  elements.regionSummary.innerHTML=`<span class="region-summary-icon">⌖</span><div><strong>${escapeHtml(title)}</strong><p>${objects.length} рейсов · ${positioned} с координатой · ${delayed} с задержкой 1ч+</p></div>`;
}

function renderDiagnostics(){
  const d=state.data.diagnostics;
  $("#diagnostic-total").textContent=d.totalRuns;
  $("#diagnostic-positioned").textContent=`${d.positionedRuns}/${d.totalRuns}`;
  $("#diagnostic-forecast").textContent=`${d.forecastCoverage}/${d.totalRuns}`;
  $("#diagnostic-quality").textContent=`${Math.round(d.averageQuality*100)}%`;
  const health=d.freshness.key==="fresh"?"Свежие":d.freshness.key==="expired"?"Устарели":"С задержкой";
  $("#diagnostic-health").textContent=health;
  $("#diagnostic-health").className=`health-${health==="Свежие"?"online":health==="С задержкой"?"stale":"offline"}`;
  $("#diagnostic-note").textContent=`Алгоритм ${d.algorithmVersion} · данные УЗ ${Math.round(d.sourceAgeMinutes)} мин назад · свежие ${d.freshRuns}/${d.totalRuns} · заморожены ${d.frozenRuns}`;
}

function renderSourceRegistry(){
  const labels={online:"LIVE",stale:"УСТАРЕЛ",snapshot:"СНИМОК",archive:"АРХИВ",protected:"ЗАЩИЩЁН",candidate:"К ПОДКЛЮЧЕНИЮ","requires-key":"НУЖЕН КЛЮЧ","reference-only":"ТОЛЬКО СВЕРКА",unavailable:"НЕДОСТУПЕН"};
  const summary=state.data.sourceSummary||{connected:0,total:0};
  $("#source-registry-summary").textContent=`${summary.connected}/${summary.total} подключено`;
  elements.sourceRegistryList.innerHTML=(state.data.sourceRegistry||[]).map((source)=>`<article class="source-item source-${escapeHtml(source.state)}">
    <span></span><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.note||"")}</small></div>
    <b>${escapeHtml(source.authority==="aggregator"?"СВЕРКА":labels[source.state]||source.state)}</b>
  </article>`).join("");
}

function render(){
  if(!state.data)return;
  const visible=filteredObjects();
  const focused=state.selected&&visible.find((object)=>object.id===state.selected.id);
  mapView.render(focused?[focused]:visible,state.data.routeMap,focused||null);mapView.updateRegionSelection(state.regions);
  renderLiveFeed();renderFleet(visible);renderRegionSummary(visible);renderDiagnostics();renderSourceRegistry();renderFreshnessPulse();
  elements.visibleCount.textContent=`${visible.length} объектов`;$("#mobile-total").textContent=visible.length;
  $("#running-count").textContent=visible.filter((object)=>object.operationalStatus==="moving").length;
  $("#depot-count").textContent=visible.filter((object)=>object.operationalStatus==="station").length;
  $("#unavailable-count").textContent=visible.filter((object)=>object.position.status==="unknown").length;
}

function renderFreshnessPulse(){
  const d=state.data.diagnostics,f=d.freshness;
  const panel=$("#freshness-pulse");if(!panel)return;
  panel.dataset.tone=f.tone;
  $("#pulse-source-age").textContent=Number.isFinite(d.sourceAgeMinutes)?`${Math.round(d.sourceAgeMinutes)} мин`:"—";
  $("#pulse-calculated-at").textContent=new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Kyiv"}).format(new Date(state.data.calculatedAt));
  $("#pulse-mode").textContent=f.label;
  $("#pulse-extrapolation").textContent=f.frozen?"остановлена на 90 мин":`${Math.round(f.modelAgeMinutes)} мин`;
}

function evidenceTemplate(items){
  return `<div class="evidence-ledger">${items.map((item)=>`<article class="evidence-row evidence-${escapeHtml(item.kind)}"><span></span><div><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.value)}</p><small>${escapeHtml(item.source)} · ${formatRelative(item.timestamp)}</small></div></article>`).join("")}</div>`;
}

function routeTimelineTemplate(object){
  return `<div class="route-timeline">${object.routeTimeline.map((item)=>{
    const caption=item.caption||(item.kind==="origin"?"ОТПРАВЛЕНИЕ":item.kind==="destination"?"ПРИБЫТИЕ":"МОДЕЛЬ");
    const note=item.timestamp?formatDateTime(item.timestamp):item.evidence==="calculated"?"не подтверждено станцией":item.evidence==="geometry"?"не является фактом прохождения":"время не опубликовано";
    return `<div class="route-step step-${item.kind}"><span></span><div><small>${escapeHtml(caption)}</small><strong>${escapeHtml(item.label)}</strong><b>${note}</b></div></div>`;
  }).join("")}</div>`;
}

function eventLedgerTemplate(events){
  return `<div class="event-ledger">${(events||[]).map((event)=>`<article><span>${escapeHtml(event.authority==="official"?"ФАКТ":"СОБЫТИЕ")}</span><div><strong>${escapeHtml(event.label)}</strong><p>${escapeHtml(event.value)}</p><small>${escapeHtml(event.sourceLabel)} · ${formatRelative(event.occurredAt)}</small></div></article>`).join("")}</div>`;
}

function historyTemplate(object){
  const items=[...(object.history||[])].reverse().slice(0,8);
  if(!items.length)return '<div class="timeline-item"><strong>История ещё не накоплена</strong><span>Снимки сохраняются в этом браузере каждые 15 минут</span></div>';
  return items.map((item)=>`<div class="timeline-item ${item.evidence==="calculated"?"calculated":""}"><strong>${escapeHtml(item.label)}</strong><span>${formatDateTime(item.timestamp)} · confidence ${Math.round((item.confidence||0)*100)}% · ±${item.errorKm||"?"} км</span></div>`).join("");
}

function detailTemplate(object){
  const position=object.position,status=POSITION_STATUSES[position.status],operation=object.operationalStatus;
  const confidence=Math.round((position.confidence??0)*100),progress=object.journey?.progress==null?null:Math.round(object.journey.progress*100);
  const forecast=object.forecast?.arrivalAt?formatDateTime(object.forecast.arrivalAt):"Не опубликован";
  const quality=Math.round(object.quality*100);
  const corridor=object.corridor,previousWaypoint=object.journey?.previousWaypoint,nextWaypoint=object.journey?.nextWaypoint;
  return `
    <p class="detail-focus-note">РЕЖИМ ФОКУСА · НА КАРТЕ ТОЛЬКО ЭТОТ РЕЙС, ЕГО МАРШРУТ И СТАНЦИИ</p>
    <p class="detail-kicker">${TRANSPORT_LABELS[object.transport]} · ${TYPE_LABELS[object.type]||object.type}</p>
    <h2>${escapeHtml(object.name)}</h2>
    <p class="detail-route">${escapeHtml(object.route)}</p>
    <div class="run-identity"><span>Рейс <b>${escapeHtml(object.serviceDate)}</b></span><code>${escapeHtml(object.runId)}</code></div>

    <div class="truth-grid">
      <section><small>ФАКТ УЗ</small><strong>${escapeHtml(object.liveUpdate?.publicStatus||"Нет статуса")}</strong><span>Задержка ${escapeHtml(object.liveUpdate?.delayLabel||"—")}</span></section>
      <section><small>РАСЧЁТ</small><strong style="color:${status.color}">${status.label}</strong><span>${position.status==="estimated"?"Не является GPS":position.status==="stale"?"Маркер больше не движется":"Координата не рассчитана"}</span></section>
    </div>

    <div class="operation-banner" style="--operation-color:${OPERATION_COLORS[operation]}"><strong>${OPERATION_LABELS[operation]}</strong><span>${escapeHtml(object.rollingStock)}</span></div>
    <div class="quality-panel">
      <div><span>Качество данных</span><strong class="quality-${qualityClass(object.quality)}">${quality}%</strong></div>
      <div class="quality-track"><i style="width:${quality}%"></i></div>
      <p>Композитная оценка свежести источника, наличия прогноза и покрытия железнодорожной геометрией.</p>
    </div>

    <h3 class="detail-section-title">Маршрут и прогноз</h3>
    ${routeTimelineTemplate(object)}
    ${progress==null?"":`<section class="journey-progress"><header><span>Расчётный прогресс</span><strong>${progress}%</strong></header><div class="journey-track"><i style="width:${progress}%"></i></div></section>`}
    ${corridor?`<section class="corridor-card">
      <header><span>ВЕРОЯТНЫЙ УЧАСТОК</span><strong>${corridor.fromKm}–${corridor.toKm} км</strong></header>
      <div class="corridor-track"><i style="left:${Math.round(corridor.fromKm/corridor.totalKm*100)}%;width:${Math.max(2,Math.round(corridor.widthKm/corridor.totalKm*100))}%"></i></div>
      <p>Модель допускает нахождение поезда на участке длиной ${corridor.widthKm} км. Это диапазон неопределённости, а не GPS-трек.</p>
      <div class="corridor-waypoints"><span>Позади модели: <b>${escapeHtml(previousWaypoint?.name||"нет ориентира")}</b></span><span>Впереди модели: <b>${escapeHtml(nextWaypoint?.name||"нет ориентира")}</b></span></div>
    </section>`:""}

    <div class="confidence-block"><div class="confidence-head"><span>Уверенность координаты</span><strong>${confidence}%</strong></div><div class="confidence-bar"><i style="width:${confidence}%"></i></div></div>
    <div class="confidence-reasons">${(position.confidenceReasons||[]).map((reason)=>`<p class="${reason.positive?"positive":"negative"}"><span>${reason.positive?"+":"−"}</span>${escapeHtml(reason.text)}</p>`).join("")}</div>
    <div class="data-grid">
      <div><small>Погрешность</small><strong>${position.errorKm==null?"Не определена":`± ${position.errorKm} км`}</strong></div>
      <div><small>Прогноз прибытия</small><strong>${forecast}</strong></div>
      <div><small>Метод</small><strong>${escapeHtml(position.method)}</strong></div>
      <div><small>Исходные данные УЗ</small><strong>${formatRelative(position.sourceUpdatedAt)}</strong></div>
      <div><small>Расчёт выполнен</small><strong>${formatRelative(position.calculatedAt)}</strong></div>
      <div><small>Экстраполяция</small><strong>${Math.round(position.calculation?.extrapolationMinutes??0)} мин${position.freshness?.frozen?" · остановлена":""}</strong></div>
      <div><small>Причина задержки</small><strong>${escapeHtml(object.liveUpdate?.reason||"Не опубликована")}</strong></div>
      <div><small>Области маршрута</small><strong>${(object.regions||[]).length}</strong></div>
    </div>

    <h3 class="detail-section-title">Журнал официальных событий</h3>
    ${eventLedgerTemplate(object.events)}
    <h3 class="detail-section-title">Цепочка доказательств</h3>
    ${evidenceTemplate(object.evidence)}
    <h3 class="detail-section-title">История в этом браузере</h3>
    <div class="timeline">${historyTemplate(object)}</div>
    <button class="detail-action" id="history-button">Показать накопленную историю на карте</button>
    <button class="detail-action follow-button ${state.followedId===object.id?"active":""}" id="follow-button">${state.followedId===object.id?"Отменить слежение":"Следить за рейсом"}</button>
    <button class="detail-action" id="favorite-button">${state.favorites.has(object.runId)?"Удалить из избранного":"Добавить в избранное"}</button>
    <button class="detail-action" id="share-button">Скопировать ссылку на рейс</button>
  `;
}

function selectObject(object){
  state.selected=object;const url=new URL(location.href);url.searchParams.set("train",object.runId);history.replaceState(null,"",url);render();mapView.focusObject(object);elements.detailContent.innerHTML=detailTemplate(object);
  elements.detail.scrollTop=0;elements.detail.classList.add("open");elements.detail.setAttribute("aria-hidden","false");
  renderFleet(filteredObjects());
  elements.detailContent.querySelector("#history-button")?.addEventListener("click",()=>showToast(mapView.toggleHistory(object)?"История показана":"Нужно минимум два сохранённых снимка"));
  elements.detailContent.querySelector("#favorite-button")?.addEventListener("click",(event)=>{
    state.favorites.has(object.runId)?state.favorites.delete(object.runId):state.favorites.add(object.runId);
    localStorage.setItem(FAVORITES_KEY,JSON.stringify([...state.favorites]));event.currentTarget.textContent=state.favorites.has(object.runId)?"Удалить из избранного":"Добавить в избранное";
  });
  elements.detailContent.querySelector("#share-button")?.addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(location.href);showToast("Ссылка на рейс скопирована");}catch{showToast(location.href);}
  });
  elements.detailContent.querySelector("#follow-button")?.addEventListener("click",(event)=>{
    state.followedId=state.followedId===object.id?null:object.id;
    event.currentTarget.classList.toggle("active",state.followedId===object.id);
    event.currentTarget.textContent=state.followedId===object.id?"Отменить слежение":"Следить за рейсом";
    showToast(state.followedId===object.id?`Слежение за ${object.name} включено`:"Слежение отключено");
  });
}

function closeDetail(){const url=new URL(location.href);url.searchParams.delete("train");history.replaceState(null,"",url);elements.detail.classList.remove("open");elements.detail.setAttribute("aria-hidden","true");mapView.clearHistory();state.selected=null;render();}
function showToast(message){elements.toast.textContent=message;elements.toast.classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>elements.toast.classList.remove("show"),2400);}

function resetFilters(){
  state.transport="all";state.quick="all";state.statuses=new Set(Object.keys(POSITION_STATUSES));state.operations=new Set(Object.keys(OPERATION_LABELS));
  state.regions=new Set(state.data.regionList.map((region)=>region.id));state.minConfidence=0;state.query="";
  elements.search.value="";elements.confidenceRange.value=0;elements.confidenceOutput.textContent="0%";
  document.querySelectorAll("[data-transport]").forEach((item)=>item.classList.toggle("active",item.dataset.transport==="all"));
  document.querySelectorAll("[data-quick]").forEach((item)=>item.classList.toggle("active",item.dataset.quick==="all"));
  document.querySelectorAll('.status-toggle input,.region-toggle input').forEach((input)=>input.checked=true);render();
}

function bindControls(){
  document.querySelectorAll("[data-transport]").forEach((button)=>button.addEventListener("click",()=>{
    document.querySelectorAll("[data-transport]").forEach((item)=>item.classList.remove("active"));button.classList.add("active");state.transport=button.dataset.transport;render();
  }));
  document.querySelectorAll("[data-quick]").forEach((button)=>button.addEventListener("click",()=>{
    document.querySelectorAll("[data-quick]").forEach((item)=>item.classList.remove("active"));button.classList.add("active");state.quick=button.dataset.quick;render();
  }));
  elements.search.addEventListener("input",()=>{state.query=elements.search.value;render();});
  elements.confidenceRange.addEventListener("input",()=>{state.minConfidence=Number(elements.confidenceRange.value)/100;elements.confidenceOutput.textContent=`${elements.confidenceRange.value}%`;render();});
  elements.fleetSort.addEventListener("change",()=>{state.sort=elements.fleetSort.value;renderFleet(filteredObjects());});
  $("#region-select-all").addEventListener("click",()=>{state.regions=new Set(state.data.regionList.map((region)=>region.id));elements.regionFilters.querySelectorAll("input").forEach((input)=>input.checked=true);render();});
  $("#region-clear").addEventListener("click",()=>{state.regions.clear();elements.regionFilters.querySelectorAll("input").forEach((input)=>input.checked=false);render();});
  $("#reset-filters").addEventListener("click",resetFilters);
  $("#fit-button").addEventListener("click",()=>mapView.fitAll());
  $("#detail-close").addEventListener("click",closeDetail);
  const openMobileSidebar=()=>{layoutState.mapOnly=false;applyWorkspaceLayout();elements.sidebar.classList.add("open");};
  $("#menu-button").addEventListener("click",openMobileSidebar);
  $("#mobile-summary").addEventListener("click",openMobileSidebar);
  $("#sidebar-close").addEventListener("click",()=>elements.sidebar.classList.remove("open"));
  $("#left-panel-toggle").addEventListener("click",()=>{
    layoutState.mapOnly=false;layoutState.leftCollapsed=!layoutState.leftCollapsed;applyWorkspaceLayout();
  });
  $("#fleet-toggle").addEventListener("click",()=>{
    layoutState.mapOnly=false;
    if(window.innerWidth>1180){layoutState.rightCollapsed=!layoutState.rightCollapsed;applyWorkspaceLayout();}
    else{elements.fleetPanel.classList.toggle("open");updateLayoutButtons();}
  });
  $("#fleet-close").addEventListener("click",()=>{
    elements.fleetPanel.classList.remove("open");
    if(window.innerWidth>1180){layoutState.rightCollapsed=true;applyWorkspaceLayout();}
  });
  $("#map-only-toggle").addEventListener("click",()=>{
    layoutState.mapOnly=!layoutState.mapOnly;
    if(layoutState.mapOnly)closeDetail();
    applyWorkspaceLayout();
  });
  document.addEventListener("click",(event)=>{
    const target=event.target.closest("[data-object-id]");if(!target)return;
    const object=state.data?.objects.find((item)=>item.id===target.dataset.objectId);if(object)selectObject(object);
  });
  document.addEventListener("keydown",(event)=>{if(event.key==="Escape"){closeDetail();elements.fleetPanel.classList.remove("open");}});
  window.addEventListener("resize",()=>{clearTimeout(applyWorkspaceLayout.timer);applyWorkspaceLayout.timer=setTimeout(applyWorkspaceLayout,120);});
  applyWorkspaceLayout();
}

function startClock(){
  const update=()=>{$("#clock").textContent=new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"Europe/Kyiv",timeZoneName:"short"}).format(new Date());};
  update();setInterval(update,1000);
}

function renderSourceStatus(){
  const status=state.data.sourceStatus.status||"unavailable";
  elements.systemStatus.dataset.status=status;
  elements.systemStatus.querySelector("strong").textContent=status==="online"?"Публичный контур активен":status==="stale"?"Используется последний снимок":"Источник недоступен";
  $("#last-update").textContent=`${state.data.sourceStatus.label||status} · ${formatRelative(state.data.generatedAt)}`;
  $("#source-badge").textContent=status==="online"&&state.data.liveFeed.length?"UZ EVENT":status==="stale"?"UZ STALE":"NO DATA";
  $("#marine-status").textContent=state.data.marineStatus.label;
  elements.freightStatus.textContent=state.data.freightStatus.label;
}

async function bootstrap(){
  initDynamicFilters();bindControls();startClock();
  try{
    state.data=await loadTransportData(new Date());persistHistory(state.data);initRegions();mapView.setRoutes(state.data.routes);renderSourceStatus();render();mapView.fitUkraine();const requested=new URL(location.href).searchParams.get("train");const target=state.data.objects.find((object)=>object.runId===requested);if(target)selectObject(target);
  }catch(error){console.error(error);$("#last-update").textContent="Ошибка загрузки данных";showToast("Не удалось загрузить публичный набор УЗ");}
}

let refreshInFlight;
async function refreshData(){
  if(refreshInFlight)return refreshInFlight;
  refreshInFlight=(async()=>{
    try{
      const refreshed=await loadTransportData(new Date());persistHistory(refreshed);state.data=refreshed;mapView.setRoutes(refreshed.routes);renderSourceStatus();render();
      if(state.followedId){const followed=refreshed.objects.find((object)=>object.id===state.followedId);if(followed)mapView.focusObject(followed);}
      if(state.selected){const selected=refreshed.objects.find((object)=>object.id===state.selected.id);if(selected)selectObject(selected);}
    }catch(error){console.warn("Background data refresh failed",error);}
  })();
  try{return await refreshInFlight;}finally{refreshInFlight=null;}
}

await bootstrap();
const runtimeConfig=await loadRuntimeConfig();
let lastStreamSnapshot=state.data?.generatedAt||null;
const stopLiveStream=await subscribeToLiveUpdates((message)=>{
  if(message.generatedAt&&message.generatedAt!==lastStreamSnapshot){
    lastStreamSnapshot=message.generatedAt;
    refreshData();
  }
},(transport)=>{document.documentElement.dataset.liveTransport=transport;});
window.setInterval(refreshData,Math.max(30_000,Number(runtimeConfig.refreshIntervalMs)||60_000));
window.addEventListener("beforeunload",stopLiveStream,{once:true});