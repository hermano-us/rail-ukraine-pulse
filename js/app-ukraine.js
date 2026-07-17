import { loadTransportData } from "./data-store-ukraine.js";
import { MapView } from "./map-view-ukraine.js";
import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS, TRANSPORT_LABELS, TYPE_LABELS, escapeHtml, formatDateTime, formatRelative, formatSpeed } from "./formatters-ukraine.js";

const state = { data:null, transport:"all", statuses:new Set(Object.keys(POSITION_STATUSES)), operations:new Set(Object.keys(OPERATION_LABELS)), regions:new Set(), minConfidence:0, query:"", selected:null, followedId:null };
const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar:$("#sidebar"), detail:$("#detail-panel"), detailContent:$("#detail-content"), statusFilters:$("#status-filters"), operationFilters:$("#operation-filters"), regionFilters:$("#region-filters"),
  confidenceRange:$("#confidence-range"), confidenceOutput:$("#confidence-output"), visibleCount:$("#visible-count"), toast:$("#toast"), search:$("#object-search"), liveFeed:$("#live-feed"), liveFeedCount:$("#live-feed-count"), freightStatus:$("#freight-status"),
};
const mapView = new MapView("map", selectObject);

function checkboxTemplate(key, label, color, group) {
  return `<label class="status-toggle" style="--status-color:${color}"><input type="checkbox" value="${key}" data-group="${group}" checked><span class="check">✓</span><span>${label}</span></label>`;
}

function initDynamicFilters() {
  elements.statusFilters.innerHTML = Object.entries(POSITION_STATUSES).map(([key,item])=>checkboxTemplate(key,item.label,item.color,"status")).join("");
  elements.operationFilters.innerHTML = Object.entries(OPERATION_LABELS).map(([key,label])=>checkboxTemplate(key,label,OPERATION_COLORS[key],"operation")).join("");
  const handle = (event) => {
    const set = event.target.dataset.group === "status" ? state.statuses : state.operations;
    event.target.checked ? set.add(event.target.value) : set.delete(event.target.value); render();
  };
  elements.statusFilters.addEventListener("change",handle); elements.operationFilters.addEventListener("change",handle);
}

function initRegions() {
  state.regions = new Set(state.data.regionList.map((region)=>region.id));
  elements.regionFilters.innerHTML = state.data.regionList.map((region)=>`<label class="region-toggle"><input type="checkbox" value="${region.id}" checked><span>${region.name}</span></label>`).join("");
  elements.regionFilters.addEventListener("change",(event)=>{event.target.checked?state.regions.add(event.target.value):state.regions.delete(event.target.value);render();});
  mapView.setRegions(state.data.regions,state.regions);
}


function filteredObjects() {
  const query=state.query.trim().toLocaleLowerCase("ru");
  return state.data.objects.filter((object)=>{
    const matchesTransport=state.transport==="all"||object.transport===state.transport;
    const matchesRegion=(object.regions||[]).some((id)=>state.regions.has(id));
    const matchesSearch=!query||`${object.name} ${object.route} ${object.description}`.toLocaleLowerCase("ru").includes(query);
    return matchesTransport&&matchesRegion&&matchesSearch&&state.statuses.has(object.position.status)&&state.operations.has(object.operationalStatus)&&((object.position.confidence??0)>=state.minConfidence);
  });
}

function renderLiveFeed() {
  const updates = (state.data.liveFeed || []).slice(0, 8);
  elements.liveFeedCount.textContent = `${updates.length} событий`;
  if (!updates.length) {
    elements.liveFeed.innerHTML = '<p class="feed-empty">Свежих публичных статусов пока нет</p>';
    return;
  }
  elements.liveFeed.innerHTML = updates.map((update) => {
    const object = update.objectId ? state.data.objects.find((item) => item.id === update.objectId) : null;
    const tag = object ? "button" : "div";
    const objectId = object ? ` data-object-id="${escapeHtml(object.id)}"` : "";
    return `<${tag} class="feed-item"${objectId}><span class="feed-number">№${escapeHtml(update.trainNumber)}</span><span class="feed-route"><strong>${escapeHtml(update.route || "Маршрут не указан")}</strong><small>${escapeHtml(update.publicStatus || "Статус УЗ")} · ${formatRelative(update.updatedAt)}</small></span><span class="feed-delay">${escapeHtml(update.delayLabel || "—")}</span></${tag}>`;
  }).join("");
  elements.liveFeed.onclick = (event) => {
    const button = event.target.closest("[data-object-id]");
    if (!button) return;
    const object = state.data.objects.find((item) => item.id === button.dataset.objectId);
    if (object) selectObject(object);
  };
}
function render() {
  if(!state.data)return;
  const visible=filteredObjects(); mapView.render(visible,state.data.routeMap); mapView.updateRegionSelection(state.regions); renderLiveFeed();
  elements.visibleCount.textContent=`${visible.length} объектов`; $("#mobile-total").textContent=visible.length;
  $("#running-count").textContent=visible.filter((o)=>o.operationalStatus==="moving").length;
  $("#depot-count").textContent=visible.filter((o)=>o.operationalStatus==="depot").length;
  $("#unavailable-count").textContent=visible.filter((o)=>o.operationalStatus==="source-unavailable").length;
}

function selectObject(object) {
  state.selected=object; mapView.focusObject(object); elements.detailContent.innerHTML=detailTemplate(object);
  elements.detail.scrollTop=0;
  elements.detail.classList.add("open"); elements.detail.setAttribute("aria-hidden","false");
  const image=elements.detailContent.querySelector("#train-photo");
  image?.addEventListener("error",()=>{if(image.dataset.fallback&&!image.dataset.fallbackTried){image.dataset.fallbackTried="1";image.src=image.dataset.fallback;}else image.closest(".train-photo-wrap")?.classList.add("photo-unavailable");});
  elements.detailContent.querySelector("#history-button")?.addEventListener("click",()=>showToast(mapView.toggleHistory(object)?"История движения показана на карте":"Недостаточно подтверждённых точек истории"));
  elements.detailContent.querySelector("#follow-button")?.addEventListener("click",(event)=>{
    state.followedId=state.followedId===object.id?null:object.id;
    event.currentTarget.classList.toggle("active",state.followedId===object.id);
    event.currentTarget.textContent=state.followedId===object.id?"Отменить слежение":"Следить за поездом";
    showToast(state.followedId===object.id?`Слежение за ${object.name} включено`:"Слежение отключено");
  });}

function detailTemplate(object) {
  const position=object.position,status=POSITION_STATUSES[position.status],operation=object.operationalStatus;
  const confidence=Math.round((position.confidence??0)*100), history=[...(object.history||[])].reverse().slice(0,6);
  const timeline=history.length?history.map((item)=>`<div class="timeline-item"><strong>${escapeHtml(item.label||"Событие")}</strong><span>${formatDateTime(item.timestamp)}</span></div>`).join(""):'<div class="timeline-item"><strong>История недоступна</strong><span>Ожидается публичное событие</span></div>';
  const photo=object.photo;
  const journey=object.journey||{};
  const progress=journey.progress==null?null:Math.round(journey.progress*100);
  const lastEvent=journey.lastEvent;
  const nextEvent=journey.nextEvent;
  const observation=object.liveUpdate
    ? `<section class="observation-card"><header><strong>Оперативное наблюдение</strong><span class="evidence-badge">официальный статус</span></header><p>УЗ сообщает: ${escapeHtml(object.liveUpdate.publicStatus||"статус не указан")} · задержка ${escapeHtml(object.liveUpdate.delayLabel||"не указана")}</p><small>${escapeHtml(object.liveUpdate.route||object.route)} · ${formatRelative(object.liveUpdate.updatedAt)}</small></section>`
    : lastEvent
      ? `<section class="observation-card"><header><strong>Последнее событие модели</strong><span class="evidence-badge">расчёт</span></header><p>По расписанию пройдена станция ${escapeHtml(lastEvent.label||lastEvent.id||"не указана")}</p><small>${formatDateTime(lastEvent.timestamp)} · не является фактической отметкой станции</small></section>`
      : `<section class="observation-card"><header><strong>Наблюдение отсутствует</strong><span class="evidence-badge">нет данных</span></header><p>Источник не сообщил прохождение станции.</p></section>`;
  const journeyBlock=progress==null?"":`<section class="journey-progress"><header><span>Прогресс маршрута</span><strong>${progress}%</strong></header><div class="journey-track"><i style="width:${progress}%"></i></div><div class="next-station"><span>Следующая станция</span><strong>${nextEvent?`${escapeHtml(nextEvent.label||nextEvent.id)} · ${formatDateTime(nextEvent.timestamp)}`:"Маршрут завершён"}</strong></div></section>`;
  const live=object.liveUpdate?`<div class="public-update"><strong>Публичное обновление UZ</strong><span>Задержка: ${object.liveUpdate.delayLabel||"нет данных"} · ${escapeHtml(object.liveUpdate.reliability||"надёжность не указана")}</span></div>`:"";
  return `
    <p class="detail-kicker">${TRANSPORT_LABELS[object.transport]} · ${TYPE_LABELS[object.type]||object.type}</p>
    <h2>${escapeHtml(object.name)}</h2><p class="detail-route">${escapeHtml(object.route)}</p>
    ${photo?`<figure class="train-photo-wrap"><img id="train-photo" src="${escapeHtml(photo.src)}" data-fallback="${escapeHtml(photo.fallback||"")}" alt="${escapeHtml(photo.alt)}"><figcaption>${photo.representative?"Фото типа подвижного состава, не подтверждение конкретного борта. ":""}<a href="${escapeHtml(photo.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(photo.credit)} · ${escapeHtml(photo.license)}</a></figcaption></figure>`:""}
    <p class="train-description">${escapeHtml(object.description||"Описание отсутствует")}</p>
    <div class="operation-banner" style="--operation-color:${OPERATION_COLORS[operation]}"><strong>${OPERATION_LABELS[operation]}</strong><span>${escapeHtml(object.rollingStock||"Подвижной состав не указан")}</span></div>
    <div class="position-banner" style="--position-color:${status.color}"><strong>${status.label}</strong><span>${position.status==="estimated"?"Координата рассчитана по публичному расписанию и упрощённому коридору":"Последнее доступное публичное состояние"}</span></div>
    ${live}
    ${observation}
    ${journeyBlock}
    <div class="confidence-block"><div class="confidence-head"><span>Уверенность позиции</span><strong>${confidence}%</strong></div><div class="confidence-bar"><i style="width:${confidence}%"></i></div></div>
    <div class="data-grid">
      <div><small>Погрешность</small><strong>${position.errorKm==null?"Не определена":`± ${position.errorKm} км`}</strong></div><div><small>Скорость</small><strong>${formatSpeed(object)}</strong></div>
      <div><small>Метод</small><strong>${escapeHtml(position.method)}</strong></div><div><small>Обновлено</small><strong>${formatRelative(position.updatedAt)}</strong></div>
      <div><small>Подтверждение</small><strong>${formatRelative(position.lastConfirmedAt)}</strong></div><div><small>Области</small><strong>${(object.regions||[]).length}</strong></div>
    </div>
    <h3 class="detail-section-title">Источники</h3><div class="source-tags">${(position.sources||[]).map((source)=>`<span>${escapeHtml(source)}</span>`).join("")||"Источник недоступен"}</div>
    <h3 class="detail-section-title">Последние события</h3><div class="timeline">${timeline}</div>
    <button class="detail-action" id="history-button">Показать историю на карте</button><button class="detail-action follow-button ${state.followedId===object.id?"active":""}" id="follow-button">${state.followedId===object.id?"Отменить слежение":"Следить за поездом"}</button>`;
}

function closeDetail(){elements.detail.classList.remove("open");elements.detail.setAttribute("aria-hidden","true");mapView.clearHistory();state.selected=null;}
function showToast(message){elements.toast.textContent=message;elements.toast.classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>elements.toast.classList.remove("show"),2400);}

function bindControls(){
  document.querySelectorAll("[data-transport]").forEach((button)=>button.addEventListener("click",()=>{document.querySelectorAll("[data-transport]").forEach((item)=>item.classList.remove("active"));button.classList.add("active");state.transport=button.dataset.transport;render();}));
  elements.search.addEventListener("input",()=>{state.query=elements.search.value;render();});
  elements.confidenceRange.addEventListener("input",()=>{state.minConfidence=Number(elements.confidenceRange.value)/100;elements.confidenceOutput.textContent=`${elements.confidenceRange.value}%`;render();});
  $("#region-select-all").addEventListener("click",()=>{state.regions=new Set(state.data.regionList.map((r)=>r.id));elements.regionFilters.querySelectorAll("input").forEach((i)=>i.checked=true);render();});
  $("#region-clear").addEventListener("click",()=>{state.regions.clear();elements.regionFilters.querySelectorAll("input").forEach((i)=>i.checked=false);render();});
  $("#reset-filters").addEventListener("click",()=>{state.transport="all";state.statuses=new Set(Object.keys(POSITION_STATUSES));state.operations=new Set(Object.keys(OPERATION_LABELS));state.regions=new Set(state.data.regionList.map((r)=>r.id));state.minConfidence=0;state.query="";elements.search.value="";elements.confidenceRange.value=0;elements.confidenceOutput.textContent="0%";document.querySelectorAll("[data-transport]").forEach((i)=>i.classList.toggle("active",i.dataset.transport==="all"));document.querySelectorAll('.status-toggle input,.region-toggle input').forEach((i)=>i.checked=true);render();});
  $("#fit-button").addEventListener("click",()=>mapView.fitAll());$("#detail-close").addEventListener("click",closeDetail);$("#menu-button").addEventListener("click",()=>elements.sidebar.classList.add("open"));$("#mobile-summary").addEventListener("click",()=>elements.sidebar.classList.add("open"));$("#sidebar-close").addEventListener("click",()=>elements.sidebar.classList.remove("open"));document.addEventListener("keydown",(event)=>{if(event.key==="Escape")closeDetail();});
}
function startClock(){const update=()=>{$("#clock").textContent=new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"Europe/Kyiv",timeZoneName:"short"}).format(new Date());};update();setInterval(update,1000);}

async function bootstrap(){
  initDynamicFilters();bindControls();startClock();
  try{state.data=await loadTransportData(new Date());initRegions();mapView.setRoutes(state.data.routes);$("#last-update").textContent=`Источник: ${state.data.sourceStatus.label||state.data.sourceStatus.status} · ${formatRelative(state.data.generatedAt)}`;$("#source-badge").textContent=state.data.liveFeed.length?"UZ STATUS":"MODEL";$("#marine-status").textContent=state.data.marineStatus.label;elements.freightStatus.textContent=state.data.freightStatus.label;render();mapView.fitAll();}
  catch(error){console.error(error);$("#last-update").textContent="Ошибка загрузки данных";showToast("Не удалось загрузить набор данных Украины");}
}
async function refreshData() {
  try {
    const refreshed = await loadTransportData(new Date());
    state.data = refreshed;
    mapView.setRoutes(refreshed.routes);
    $("#last-update").textContent = `Источник: ${refreshed.sourceStatus.label || refreshed.sourceStatus.status} · ${formatRelative(refreshed.generatedAt)}`;
    $("#marine-status").textContent = refreshed.marineStatus.label;
    elements.freightStatus.textContent = refreshed.freightStatus.label;
    render();
    if (state.followedId) {
      const followed = refreshed.objects.find((object) => object.id === state.followedId);
      if (followed) mapView.focusObject(followed);
    }
  } catch (error) {
    console.warn("Background data refresh failed", error);
  }
}

bootstrap();
window.setInterval(refreshData, 60_000);
