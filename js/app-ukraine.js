import { loadTransportData } from "./data-store-ukraine.js";
import { MapView } from "./map-view-ukraine.js";
import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS, TRANSPORT_LABELS, TYPE_LABELS, escapeHtml, formatDateTime, formatRelative } from "./formatters-ukraine.js";

const HISTORY_KEY="rail-ukraine-pulse:run-history:v2";
const state={
  data:null,transport:"all",statuses:new Set(Object.keys(POSITION_STATUSES)),
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
};
const mapView=new MapView("map",selectObject);

function readHistory(){
  try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||"{}");}catch{return {};}
}
function persistHistory(data){
  const store=readHistory();
  for(const object of data.objects){
    if(!object.position.coordinates)continue;
    const entries=Array.isArray(store[object.runId])?store[object.runId]:[];
    const timestamp=object.position.updatedAt||data.generatedAt;
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
  if(state.quick==="unknown")return object.position.status==="unknown";
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
  const health=d.sourceAgeMinutes<=25&&state.data.sourceStatus.status==="online"?"Свежие":d.sourceAgeMinutes<=90?"С задержкой":"Устарели";
  $("#diagnostic-health").textContent=health;
  $("#diagnostic-health").className=`health-${health==="Свежие"?"online":health==="С задержкой"?"stale":"offline"}`;
  $("#diagnostic-note").textContent=`Алгоритм ${d.algorithmVersion} · возраст снимка ${Math.round(d.sourceAgeMinutes)} мин · маршруты ${d.routeCoverage}/${d.totalRuns}`;
}

function render(){
  if(!state.data)return;
  const visible=filteredObjects();
  mapView.render(visible,state.data.routeMap);mapView.updateRegionSelection(state.regions);
  renderLiveFeed();renderFleet(visible);renderRegionSummary(visible);renderDiagnostics();
  elements.visibleCount.textContent=`${visible.length} объектов`;$("#mobile-total").textContent=visible.length;
  $("#running-count").textContent=visible.filter((object)=>object.operationalStatus==="moving").length;
  $("#depot-count").textContent=visible.filter((object)=>object.operationalStatus==="station").length;
  $("#unavailable-count").textContent=visible.filter((object)=>object.position.status==="unknown").length;
}

function evidenceTemplate(items){
  return `<div class="evidence-ledger">${items.map((item)=>`<article class="evidence-row evidence-${escapeHtml(item.kind)}"><span></span><div><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.value)}</p><small>${escapeHtml(item.source)} · ${formatRelative(item.timestamp)}</small></div></article>`).join("")}</div>`;
}

function routeTimelineTemplate(object){
  return `<div class="route-timeline">${object.routeTimeline.map((item)=>`<div class="route-step step-${item.kind}"><span></span><div><small>${item.kind==="origin"?"ОТПРАВЛЕНИЕ":item.kind==="destination"?"ПРИБЫТИЕ":"МОДЕЛЬ"}</small><strong>${escapeHtml(item.label)}</strong><b>${item.timestamp?formatDateTime(item.timestamp):item.evidence==="calculated"?"не подтверждено станцией":"время не опубликовано"}</b></div></div>`).join("")}</div>`;
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
  return `
    <p class="detail-kicker">${TRANSPORT_LABELS[object.transport]} · ${TYPE_LABELS[object.type]||object.type}</p>
    <h2>${escapeHtml(object.name)}</h2>
    <p class="detail-route">${escapeHtml(object.route)}</p>
    <div class="run-identity"><span>Рейс <b>${escapeHtml(object.serviceDate)}</b></span><code>${escapeHtml(object.runId)}</code></div>

    <div class="truth-grid">
      <section><small>ФАКТ УЗ</small><strong>${escapeHtml(object.liveUpdate?.publicStatus||"Нет статуса")}</strong><span>Задержка ${escapeHtml(object.liveUpdate?.delayLabel||"—")}</span></section>
      <section><small>РАСЧЁТ</small><strong style="color:${status.color}">${status.label}</strong><span>${position.status==="estimated"?"Не является GPS":"Координата не рассчитана"}</span></section>
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

    <div class="confidence-block"><div class="confidence-head"><span>Уверенность координаты</span><strong>${confidence}%</strong></div><div class="confidence-bar"><i style="width:${confidence}%"></i></div></div>
    <div class="data-grid">
      <div><small>Погрешность</small><strong>${position.errorKm==null?"Не определена":`± ${position.errorKm} км`}</strong></div>
      <div><small>Прогноз прибытия</small><strong>${forecast}</strong></div>
      <div><small>Метод</small><strong>${escapeHtml(position.method)}</strong></div>
      <div><small>Снимок УЗ</small><strong>${formatRelative(object.liveUpdate?.updatedAt)}</strong></div>
      <div><small>Причина задержки</small><strong>${escapeHtml(object.liveUpdate?.reason||"Не опубликована")}</strong></div>
      <div><small>Области маршрута</small><strong>${(object.regions||[]).length}</strong></div>
    </div>

    <h3 class="detail-section-title">Цепочка доказательств</h3>
    ${evidenceTemplate(object.evidence)}
    <h3 class="detail-section-title">История в этом браузере</h3>
    <div class="timeline">${historyTemplate(object)}</div>
    <button class="detail-action" id="history-button">Показать накопленную историю на карте</button>
    <button class="detail-action follow-button ${state.followedId===object.id?"active":""}" id="follow-button">${state.followedId===object.id?"Отменить слежение":"Следить за рейсом"}</button>
  `;
}

function selectObject(object){
  state.selected=object;mapView.focusObject(object);elements.detailContent.innerHTML=detailTemplate(object);
  elements.detail.scrollTop=0;elements.detail.classList.add("open");elements.detail.setAttribute("aria-hidden","false");
  renderFleet(filteredObjects());
  elements.detailContent.querySelector("#history-button")?.addEventListener("click",()=>showToast(mapView.toggleHistory(object)?"История показана":"Нужно минимум два сохранённых снимка"));
  elements.detailContent.querySelector("#follow-button")?.addEventListener("click",(event)=>{
    state.followedId=state.followedId===object.id?null:object.id;
    event.currentTarget.classList.toggle("active",state.followedId===object.id);
    event.currentTarget.textContent=state.followedId===object.id?"Отменить слежение":"Следить за рейсом";
    showToast(state.followedId===object.id?`Слежение за ${object.name} включено`:"Слежение отключено");
  });
}

function closeDetail(){elements.detail.classList.remove("open");elements.detail.setAttribute("aria-hidden","true");mapView.clearHistory();state.selected=null;renderFleet(filteredObjects());}
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
  $("#menu-button").addEventListener("click",()=>elements.sidebar.classList.add("open"));
  $("#mobile-summary").addEventListener("click",()=>elements.sidebar.classList.add("open"));
  $("#sidebar-close").addEventListener("click",()=>elements.sidebar.classList.remove("open"));
  $("#fleet-toggle").addEventListener("click",()=>elements.fleetPanel.classList.toggle("open"));
  $("#fleet-close").addEventListener("click",()=>elements.fleetPanel.classList.remove("open"));
  document.addEventListener("click",(event)=>{
    const target=event.target.closest("[data-object-id]");if(!target)return;
    const object=state.data?.objects.find((item)=>item.id===target.dataset.objectId);if(object)selectObject(object);
  });
  document.addEventListener("keydown",(event)=>{if(event.key==="Escape"){closeDetail();elements.fleetPanel.classList.remove("open");}});
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
  $("#source-badge").textContent=state.data.liveFeed.length?"UZ REAL":"NO DATA";
  $("#marine-status").textContent=state.data.marineStatus.label;
  elements.freightStatus.textContent=state.data.freightStatus.label;
}

async function bootstrap(){
  initDynamicFilters();bindControls();startClock();
  try{
    state.data=await loadTransportData(new Date());persistHistory(state.data);initRegions();mapView.setRoutes(state.data.routes);renderSourceStatus();render();mapView.fitAll();
  }catch(error){console.error(error);$("#last-update").textContent="Ошибка загрузки данных";showToast("Не удалось загрузить публичный набор УЗ");}
}

async function refreshData(){
  try{
    const refreshed=await loadTransportData(new Date());persistHistory(refreshed);state.data=refreshed;mapView.setRoutes(refreshed.routes);renderSourceStatus();render();
    if(state.followedId){const followed=refreshed.objects.find((object)=>object.id===state.followedId);if(followed)mapView.focusObject(followed);}
    if(state.selected){const selected=refreshed.objects.find((object)=>object.id===state.selected.id);if(selected)selectObject(selected);}
  }catch(error){console.warn("Background data refresh failed",error);}
}

bootstrap();
window.setInterval(refreshData,60_000);
