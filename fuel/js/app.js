import { fuelFetch } from "./api-client.js";

const UKRAINE=[[44.0,21.8],[52.5,40.5]]; const statusLabels={operating:"Работает",partially_operating:"Работает частично",temporarily_closed:"Временно закрыта",closed:"Закрыта",fuel_unavailable:"Топливо недоступно",unknown:"Нет оперативного статуса"};
const map=L.map("map",{zoomControl:false,minZoom:5,maxZoom:18}).setView([48.55,31.2],6); L.control.zoom({position:"bottomright"}).addTo(map);
const dark=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
map.setMaxBounds([[43,20],[54,42]]);
const layer=L.layerGroup().addTo(map); let controller; let currentStations=[]; let selectedMarker=null; let debounce;
const $=id=>document.getElementById(id); const escape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const age=value=>{const minutes=Math.max(0,Math.round((Date.now()-Date.parse(value||""))/60000));return Number.isFinite(minutes)?minutes<60?`${minutes} мин назад`:`${Math.floor(minutes/60)} ч назад`:"нет данных"};
function icon(status,count){const cluster=Number(count)>1;const className=cluster?"cluster-icon":`station-icon ${status||"unknown"}`;const size=cluster?Math.min(48,28+Math.log10(count)*9):19;return L.divIcon({className:"",html:`<div class="${className}" style="width:${size}px;height:${size}px">${cluster?count:""}</div>`,iconSize:[size,size],iconAnchor:[size/2,size/2]});}
function boundsParam(){const b=map.getBounds();return [b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(n=>n.toFixed(5)).join(",");}
function query(){const params=new URLSearchParams({bbox:boundsParam(),zoom:String(map.getZoom())});const status=$("status").value,fuel=$("fuel").value,search=$("search").value.trim();if(status!=="all")params.set("status",status);if(fuel)params.set("fuel",fuel);if(search)params.set("brand",search);return params;}
async function refresh(){
  controller?.abort();controller=new AbortController();$("loading").hidden=false;
  try{const data=await fuelFetch(`/api/fuel/v1/stations?${query()}`,{signal:controller.signal});layer.clearLayers();currentStations=data.stations||[];
    if(data.mode==="clusters") for(const group of data.clusters||[]){L.marker([group.lat,group.lng],{icon:icon("unknown",group.count)}).addTo(layer).on("click",()=>map.setView([group.lat,group.lng],Math.min(11,map.getZoom()+2)));}
    else for(const station of currentStations){const marker=L.marker([station.lat,station.lng],{icon:icon(station.status,1),title:station.name}).addTo(layer).on("click",()=>openStation(station.id,marker));marker.bindTooltip(escape(station.name),{direction:"top"});}
    renderList(data.mode);$("visible-count").textContent=data.mode==="clusters"?(data.clusters||[]).reduce((sum,item)=>sum+Number(item.count),0):currentStations.length;
  }catch(error){if(error.name!=="AbortError"){$("health-dot").className="health-dot error";$("health-title").textContent="API недоступен";$("health-detail").textContent=error.message;}}
  finally{$("loading").hidden=true;}
}
function schedule(){clearTimeout(debounce);debounce=setTimeout(refresh,220)}
function renderList(mode){const list=$("station-list");if(mode==="clusters"){list.innerHTML='<p class="empty">Приблизьте карту: количество показано кластерами без перегрузки карты.</p>';return;}const term=$("search").value.trim().toLowerCase();const stations=currentStations.filter(s=>!term||[s.name,s.brand,s.city,s.address].some(v=>String(v||"").toLowerCase().includes(term))).slice(0,150);list.innerHTML=stations.length?stations.map(s=>`<button class="station-row" data-id="${escape(s.id)}"><i class="status-pin ${escape(s.status)}"></i><span><strong>${escape(s.name)}</strong><small>${escape([s.city,s.address].filter(Boolean).join(" · ")||"Адрес не указан")}</small></span><em>${escape(statusLabels[s.status]||statusLabels.unknown)}</em></button>`).join(""):'<p class="empty">В этой области ничего не найдено.</p>';list.querySelectorAll("[data-id]").forEach(button=>button.onclick=()=>{const station=currentStations.find(s=>s.id===button.dataset.id);if(station){map.panTo([station.lat,station.lng]);openStation(station.id);}})}
function safeExternalUrl(value){try{const url=new URL(value);return ["https:","http:"].includes(url.protocol)?url.href:null}catch{return null}}
function enrichDetails(s){
  const services=s.services||{},media=services.media||{},details=$("details");
  const imageUrl=safeExternalUrl(media.imageUrl);
  const hero=imageUrl?`<img class="station-hero" src="${escape(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<div class="station-hero placeholder"><span>${escape((s.brand||s.name||"АЗС").slice(0,3).toUpperCase())}</span><small>Фото пока не найдено в открытых источниках</small></div>`;
  const amenities=[["shop","Магазин"],["cafe","Кафе"],["restaurant","Ресторан"],["toilets","WC"],["wifi","Wi-Fi"],["atm","Банкомат"],["carWash","Мойка"],["compressedAir","Подкачка шин"]].filter(([key])=>services[key]).map(([,label])=>label);
  if(services.wheelchair==="yes")amenities.push("Безбарьерный доступ");
  if(services.wheelchair==="limited")amenities.push("Частичная доступность");
  const catalogFuel=Object.entries(services.fuel||{}).filter(([key,value])=>key.startsWith("fuel:")&&value==="yes").map(([key])=>key.slice(5).replaceAll("_"," ").toUpperCase());
  const description=services.description?`<p class="station-description">${escape(services.description)}</p>`:"";
  const facts=(amenities.length||catalogFuel.length)?`<section class="catalog-facts">${catalogFuel.length?`<small>Топливо по каталогу</small><div class="chips">${catalogFuel.map(item=>`<span>${escape(item)}</span>`).join("")}</div>`:""}${amenities.length?`<small>Удобства</small><div class="chips">${amenities.map(item=>`<span>${escape(item)}</span>`).join("")}</div>`:""}</section>`:"";
  details.querySelector("h2")?.insertAdjacentHTML("afterend",hero+description+facts);
  const actions=details.querySelector(".actions");
  const website=safeExternalUrl(s.website),commons=safeExternalUrl(media.commonsUrl),mapillary=safeExternalUrl(media.mapillaryUrl);
  if(website)actions?.insertAdjacentHTML("beforeend",`<a href="${escape(website)}" target="_blank" rel="noopener">Сайт АЗС</a>`);
  if(s.phone)actions?.insertAdjacentHTML("beforeend",`<a href="tel:${escape(String(s.phone).replace(/[^+0-9]/g,""))}">Позвонить</a>`);
  if(commons)actions?.insertAdjacentHTML("beforeend",`<a href="${escape(commons)}" target="_blank" rel="noopener">Wikimedia</a>`);
  if(mapillary)actions?.insertAdjacentHTML("beforeend",`<a href="${escape(mapillary)}" target="_blank" rel="noopener">Панорама</a>`);
}

async function openStation(id,marker){
  selectedMarker=marker||selectedMarker;$("details").hidden=false;$("details").innerHTML='<p class="empty">Загружаем карточку…</p>';
  try{const data=await fuelFetch(`/api/fuel/v1/stations/${encodeURIComponent(id)}`);const s=data.station;const source=data.sources?.[0];const fuelEntries=Object.entries(s.fuels||{});const priceEntries=Object.entries(s.prices||{});$("details").innerHTML=`<button class="close" aria-label="Закрыть">×</button><div class="brand">${escape(s.brand||s.operator||"Независимая АЗС")}</div><h2>${escape(s.name)}</h2><div class="detail-status"><strong>${escape(statusLabels[s.status]||statusLabels.unknown)}</strong><br><small>Уверенность статуса ${Math.round((s.statusConfidence||0)*100)}% · ${escape(age(s.statusVerifiedAt))}${s.conflictState==="conflicting"?" · источники конфликтуют":""}</small></div><div class="detail-grid"><div><small>Адрес</small>${escape([s.city,s.address].filter(Boolean).join(", ")||"Не указан")}</div><div><small>Режим</small>${escape(s.openingHours||"Не указан")}</div><div><small>Топливо</small>${fuelEntries.length?fuelEntries.map(([key,val])=>`${escape(key.toUpperCase())}: ${escape(val.availability)}`).join("<br>"):"Нет оперативных данных"}</div><div><small>Цены</small>${priceEntries.length?priceEntries.map(([key,val])=>`${escape(key.toUpperCase())}: ${(val.priceMinor/100).toFixed(2)} ${escape(val.currency)}`).join("<br>"):"Нет подтверждённых цен"}</div></div><p class="source">Каталог: ${source?`<a href="${escape(source.url)}" target="_blank" rel="noopener">${escape(source.name)}</a> · ${escape(age(source.lastSeenAt))}`:"источник не указан"}. Доверие к карточке ${Math.round((s.catalogConfidence||0)*100)}%. Каталог и текущий статус — разные факты.</p><div class="actions"><a href="https://www.openstreetmap.org/directions?to=${s.lat}%2C${s.lng}" target="_blank" rel="noopener">Маршрут</a><a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}" target="_blank" rel="noopener">Открыть в картах</a></div>`;$("details").querySelector(".close").onclick=()=>$("details").hidden=true;
  enrichDetails(s);
  }catch(error){$("details").innerHTML=`<button class="close">×</button><p class="empty">Не удалось загрузить карточку: ${escape(error.message)}</p>`;$("details").querySelector(".close").onclick=()=>$("details").hidden=true;}
}
async function checkHealth(){try{const health=await fuelFetch("/api/fuel/v1/health");$("health-dot").className="health-dot online";$("health-title").textContent="Каталог подключён";$("health-detail").textContent=`${health.catalog.stations.toLocaleString("ru-RU")} реальных объектов · обновление ежедневно`;}catch(error){$("health-dot").className="health-dot error";$("health-title").textContent="Нет связи";$("health-detail").textContent=error.message;}}
function locate(){if(!navigator.geolocation)return;navigator.geolocation.getCurrentPosition(position=>{map.setView([position.coords.latitude,position.coords.longitude],12);L.circleMarker([position.coords.latitude,position.coords.longitude],{radius:7,color:"#5bd5ff",fillOpacity:1}).addTo(map).bindTooltip("Вы здесь").openTooltip();},()=>{$("map-caption").textContent="доступ к геопозиции не предоставлен";},{enableHighAccuracy:true,timeout:10000});}
map.on("moveend",schedule);[$("status"),$("fuel")].forEach(element=>element.onchange=refresh);$("search").oninput=()=>{renderList(map.getZoom()<8?"clusters":"stations");schedule()};$("locate").onclick=locate;$("nearby").onclick=locate;$("open-panel").onclick=()=>$("sidebar").classList.add("open");$("close-panel").onclick=()=>$("sidebar").classList.remove("open");$("theme").onclick=()=>document.body.classList.toggle("light");
checkHealth();refresh();
