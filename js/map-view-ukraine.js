import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS, escapeHtml } from "./formatters-ukraine.js?v=20260808-freight-v2";

const GLYPHS={moving:"↗",station:"■",depot:"D","source-unavailable":"?"};

export class MapView{
  constructor(elementId,onSelect){
    this.onSelect=onSelect;this.viewMode="all";
    this.map=L.map(elementId,{zoomControl:false,minZoom:4,worldCopyJump:false}).setView([49.1,31.1],6);
    L.control.zoom({position:"bottomleft"}).addTo(this.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.regionLayer=L.geoJSON(null,{interactive:false}).addTo(this.map);
    this.routeLayer=L.geoJSON(null,{interactive:false,style:(feature)=>{const count=this.routeIntensity?.get(feature?.properties?.id)||1,provisional=Boolean(feature?.properties?.probabilisticFallback);return {color:provisional?"#a87645":count>4?"#f3b562":"#2f8a9d",weight:provisional?1.2:1.1+Math.min(4,Math.log2(count+1)),opacity:provisional?.24:.12+Math.min(.5,count*.055),dashArray:provisional?"3 9":null};}}).addTo(this.map);
    this.uncertaintyLayer=L.layerGroup().addTo(this.map);
    this.selectedLayer=L.layerGroup().addTo(this.map);
    this.markerLayer=L.layerGroup().addTo(this.map);
    this.freightLayer=L.layerGroup().addTo(this.map);
    this.stationQueueLayer=L.layerGroup().addTo(this.map);
    this.historyLayer=L.layerGroup().addTo(this.map);
    this.markers=new Map();
    this.objects=new Map();
    this.map.on("zoomend",()=>this.syncLabelVisibility());
    this.syncLabelVisibility();
  }

  syncLabelVisibility(){
    this.map.getContainer().classList.toggle("map-labels-visible",this.map.getZoom()>=9);
  }

  setRegions(regions,selectedIds){
    this.regions=regions;this.selectedRegionIds=selectedIds;this.regionLayer.clearLayers();this.regionLayer.addData(regions);
    this.regionLayer.eachLayer((layer)=>layer.setStyle(this.regionStyle(layer.feature.properties.id)));
  }

  regionStyle(id){
    const active=this.selectedRegionIds?.has(id);
    return {color:active?"#4bc9d4":"#42515a",weight:active?1.2:.6,opacity:active ? .55 : .18,fillColor:active?"#1c6370":"#15232b",fillOpacity:active ? .08 : .025};
  }

  updateRegionSelection(selectedIds){
    this.selectedRegionIds=selectedIds;
    this.regionLayer.eachLayer((layer)=>layer.setStyle(this.regionStyle(layer.feature.properties.id)));
  }

  setRoutes(routes){
    this.routes=routes;
    this.routeLayer.clearLayers();
    this.routeLayer.addData(routes);
  }

  render(objects,routeMap,focusedObject=null,stationQueues=[]){
    this.currentRouteMap=routeMap;this.routeIntensity=new Map();for(const item of objects)this.routeIntensity.set(item.routeId,(this.routeIntensity.get(item.routeId)||0)+1);this.markerLayer.clearLayers();this.freightLayer.clearLayers();this.uncertaintyLayer.clearLayers();this.selectedLayer.clearLayers();this.stationQueueLayer.clearLayers();
    this.routeLayer.clearLayers();
    if(!focusedObject&&this.routes){
      const visibleRouteIds=new Set(objects.filter((object)=>Array.isArray(object.position.coordinates)).map((object)=>object.routeId));
      this.routeLayer.addData({type:"FeatureCollection",features:(this.routes.features||[]).filter((feature)=>visibleRouteIds.has(feature.properties?.id))});
    }
    this.markers.clear();this.objects=new Map(objects.map((object)=>[object.id,object]));
    const visibleStationQueues=focusedObject?[]:(stationQueues||[]).map((group)=>({...group,entries:(group.entries||[]).filter((entry)=>this.objects.has(entry.objectId))})).filter((group)=>group.entries.length);
    const queuedObjectIds=new Set(visibleStationQueues.flatMap((group)=>group.entries.map((entry)=>entry.objectId)));
    const bounds=[];
    this.renderFreightCorridors(objects.filter((object)=>object.type==="freight"),bounds);
    if(this.viewMode==="density"&&!focusedObject){
      const cells=new Map();
      for(const object of objects){const [lon,lat]=object.position.coordinates||[];if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;const key=`${Math.round(lat/.65)}:${Math.round(lon/.8)}`,cell=cells.get(key)||{lat:0,lon:0,count:0};cell.lat+=lat;cell.lon+=lon;cell.count+=1;cells.set(key,cell);}
      for(const cell of cells.values()){
        const lat=cell.lat/cell.count,lon=cell.lon/cell.count,size=Math.min(72,30+Math.sqrt(cell.count)*9);
        const icon=L.divIcon({
          className:"density-marker-shell",
          html:`<div class="density-marker" style="width:${size}px;height:${size}px">${cell.count}</div>`,
          iconSize:[size,size],iconAnchor:[size/2,size/2],
        });
        L.marker([lat,lon],{icon,interactive:false}).addTo(this.markerLayer);
        bounds.push([lat,lon]);
      }
      this.currentBounds=bounds;return;
    }
    objects.forEach((object)=>{
      if(object.type==="freight")return;
      const [lon,lat]=object.position.coordinates||[];
      if(queuedObjectIds.has(object.id))return;
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
      const status=object.position.status,operation=object.operationalStatus||"moving";
      const color=["stale","unknown"].includes(status)?POSITION_STATUSES[status].color:(OPERATION_COLORS[operation]||POSITION_STATUSES[status].color);
      const estimateLabel=object.disruption?.held?"<em>Остановка · последнее вероятное положение</em>":status==="estimated"?"<em>Расчётное · не GPS</em>":status==="stale"?`<em>${escapeHtml(object.stationPresence?.label||"Расчёт остановлен")}</em>`:`<em>${escapeHtml(object.stationPresence?.label||OPERATION_LABELS[operation])}</em>`;
      const delay=object.liveUpdate?.delayLabel||"—",qualitySignal=Math.round((object.quality||0)*100),freshSignal=object.position.freshness?.key==="fresh"?100:object.position.freshness?.key==="delayed"?55:20;
      const icon=L.divIcon({
        className:"transport-marker",
        html:`<div class="transport-icon ${status} operation-${operation}" style="--marker-color:${color}"><b>${GLYPHS[operation]}</b><span class="marker-label">${object.name}<small>${delay}</small>${estimateLabel}${object.timelineChange?`<em class="marker-change">Δ ${escapeHtml(object.timelineChange)}</em>`:""}<span class="marker-signal" title="Качество / свежесть"><i style="--signal:${qualitySignal}%"></i><i style="--signal:${freshSignal}%;--signal-color:#48d9e6"></i></span></span></div>`,
        iconSize:[30,30],iconAnchor:[15,15],
      });
      const marker=L.marker([lat,lon],{
        icon,keyboard:true,alt:`${object.name}: ${object.route}`,title:`${object.name}: ${object.route}`,zIndexOffset:status==="estimated"?2000:2500,riseOnHover:true,riseOffset:4000,
      }).addTo(this.markerLayer);
      marker.on("click",()=>this.onSelect(object));
      marker.bindTooltip(`${object.name} · ${object.route} · ${delay}`,{direction:"top",offset:[0,-14]});
      this.markers.set(object.id,marker);bounds.push([lat,lon]);
      if(this.viewMode==="all"&&["estimated","stale"].includes(status)&&Number.isFinite(object.position.errorKm)){
        L.circle([lat,lon],{
          radius:object.position.errorKm*1000,color:status==="stale"?"#82919a":"#ff9d52",weight:1,opacity:.22,fillColor:status==="stale"?"#82919a":"#ff9d52",fillOpacity:.025,
          interactive:false,className:"uncertainty-zone",
        }).addTo(this.uncertaintyLayer);
      }
    });
    this.currentBounds=bounds;
    this.renderStationQueues(visibleStationQueues,bounds);
  }

  renderFreightCorridors(objects,bounds=[]){
    const groups=new Map();
    for(const object of objects){const key=object.freight?.corridorCode||object.routeId,group=groups.get(key)||[];group.push(object);groups.set(key,group);}
    for(const group of groups.values()){
      const object=group[0],coordinates=(object.routeCoordinates||[]).map(([lon,lat])=>[lat,lon]).filter(([lat,lon])=>Number.isFinite(lat)&&Number.isFinite(lon));if(coordinates.length<2)continue;
      const area=object.freight?.corridorKind==="area",confidence=Math.round((Math.max(...group.map((item)=>item.position.confidence||0)))*100);
      const shape=area?L.polygon(coordinates,{className:"freight-public-corridor",color:"#d99a45",weight:2,opacity:.76,fillColor:"#d99a45",fillOpacity:.07,dashArray:"7 9"}):L.polyline(coordinates,{className:"freight-public-corridor",color:"#d99a45",weight:5,opacity:.7,dashArray:"5 10",lineCap:"round"});shape.addTo(this.freightLayer);
      const anchor=area?shape.getBounds().getCenter():coordinates[Math.floor((coordinates.length-1)/2)],icon=L.divIcon({className:"freight-corridor-anchor-shell",html:`<div class="freight-corridor-anchor"><b>${group.length}</b></div>`,iconSize:[42,42],iconAnchor:[21,21]});
      const marker=L.marker(anchor,{icon,keyboard:true,title:`${object.route}: агрегированная грузовая активность, не точная позиция`}).addTo(this.freightLayer),popup=document.createElement("section");popup.className="freight-corridor-popup";
      const header=document.createElement("header"),title=document.createElement("strong"),meta=document.createElement("small");title.textContent=object.route;meta.textContent=`${group.length} вероятностных объектов · confidence до ${confidence}%`;header.append(title,meta);popup.append(header);
      const warning=document.createElement("p");warning.textContent="Публичная агрегация с задержкой не менее 24 часов. Линия показывает коридор, а не координату состава.";popup.append(warning);
      for(const item of group){const button=document.createElement("button"),name=document.createElement("b"),description=document.createElement("span"),state=document.createElement("em");name.textContent=item.name;description.textContent=`${item.freight?.observationCount||0} наблюдений · ${item.freight?.independentSources||0} источника`;state.textContent=`±${Math.round(item.position.errorKm||0)} км`;button.append(name,description,state);button.addEventListener("click",()=>{marker.closePopup();this.onSelect(item);});popup.append(button);}
      marker.bindPopup(popup,{minWidth:300,maxWidth:380,maxHeight:360});shape.on("click",()=>marker.openPopup());bounds.push(...coordinates);
    }
  }


  renderStationQueues(groups,bounds=[]){
    for(const group of groups){
      const [lon,lat]=group.coordinates||[];
      if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
      const confirmed=group.entries.filter((entry)=>["depot","standing"].includes(entry.state)).length;
      const icon=L.divIcon({className:"station-queue-shell",html:`<div class="station-queue-marker ${confirmed?"confirmed":"expected"}"><b>${group.entries.length}</b><span>&#9636;</span></div>`,iconSize:[40,40],iconAnchor:[20,20]});
      const marker=L.marker([lat,lon],{icon,keyboard:true,title:`${group.station}: ${group.entries.length} \u043f\u043e\u0435\u0437\u0434\u043e\u0432`}).addTo(this.stationQueueLayer);
      const popup=document.createElement("section");popup.className="station-queue-popup";
      const header=document.createElement("header"),title=document.createElement("strong"),meta=document.createElement("small");
      title.textContent=group.station;meta.textContent=`${group.entries.length} \u043f\u043e\u0435\u0437\u0434\u043e\u0432 \u00b7 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e ${confirmed}`;header.append(title,meta);popup.append(header);
      for(const entry of group.entries){
        const button=document.createElement("button"),number=document.createElement("b"),description=document.createElement("span"),state=document.createElement("em");
        number.textContent=`\u2116${entry.trainNumber}`;description.textContent=entry.route||"\u041c\u0430\u0440\u0448\u0440\u0443\u0442 \u0443\u0442\u043e\u0447\u043d\u044f\u0435\u0442\u0441\u044f";state.textContent=entry.label;button.className=`station-queue-entry state-${entry.state}`;
        button.append(number,description,state);button.addEventListener("click",()=>{marker.closePopup();const object=this.objects.get(entry.objectId);if(object)this.onSelect(object);});popup.append(button);
      }
      marker.bindPopup(popup,{minWidth:280,maxWidth:360,maxHeight:360});
      bounds.push([lat,lon]);
    }
  }
  focusObject(object){
    const marker=this.markers.get(object.id);
    this.selectedLayer.clearLayers();
    this.markerLayer.eachLayer((layer)=>layer.getElement?.()?.classList.remove("is-selected"));
    marker?.getElement()?.classList.add("is-selected");
    const route=this.currentRouteMap?.get(object.routeId),focusBounds=[];
    if(route){
      const routePoints=route.geometry.coordinates.map(([lon,lat])=>[lat,lon]);
      L.polyline(routePoints,{
        className:"estimated-track selected-track",color:"#ff9d52",weight:3,opacity:.82,dashArray:"7 8",interactive:false,
      }).addTo(this.selectedLayer);
      focusBounds.push(...routePoints);
    }
    if(this.viewMode!=="point"&&object.corridor?.coordinates?.length>1){
      const corridorPoints=object.corridor.coordinates.map(([lon,lat])=>[lat,lon]);
      L.polyline(corridorPoints,{className:"model-corridor-halo",color:"#ff9d52",weight:14,opacity:.14,lineCap:"round",interactive:false}).addTo(this.selectedLayer);
      L.polyline(corridorPoints,{className:"model-corridor",color:"#ffb171",weight:4,opacity:.9,dashArray:"2 7",lineCap:"round",interactive:false}).addTo(this.selectedLayer);
      focusBounds.push(...corridorPoints);
    }
    for(const waypoint of object.waypoints||[]){
      const [stationLon,stationLat]=waypoint.coordinates||[];
      if(!Number.isFinite(stationLat)||!Number.isFinite(stationLon))continue;
      const stationPoint=[stationLat,stationLon],phase=waypoint.phase||"route";
      L.circleMarker(stationPoint,{
        radius:phase==="inside-corridor"?6:4,color:phase==="inside-corridor"?"#fff0d8":"#8fdce3",
        weight:1.5,fillColor:phase==="inside-corridor"?"#ff9d52":"#16313b",fillOpacity:1,
        interactive:true,className:`focus-station focus-station-${phase}`,
      }).bindTooltip(`${waypoint.name||waypoint.label||"Станция"} · ${Math.round(waypoint.distanceKm||0)} км`,{direction:"top"}).addTo(this.selectedLayer);
      focusBounds.push(stationPoint);
    }
    const [lon,lat]=object.position.coordinates||[];
    if(this.viewMode==="all"&&Number.isFinite(lat)&&Number.isFinite(lon)&&Number.isFinite(object.position.errorKm)){
      L.circle([lat,lon],{
        radius:object.position.errorKm*1000,color:"#ffb171",weight:1.5,opacity:.7,fillColor:"#ff9d52",fillOpacity:.07,interactive:false,
      }).addTo(this.selectedLayer);
      focusBounds.push([lat,lon]);
    }
    if(focusBounds.length>1)this.map.fitBounds(focusBounds,{padding:[54,54],maxZoom:9});
    else if(marker)this.map.flyTo(marker.getLatLng(),Math.max(this.map.getZoom(),8),{duration:.6});
  }

  setViewMode(mode){this.viewMode=["all","corridor","point","density"].includes(mode)?mode:"all";}
  invalidateSize(){this.map.invalidateSize({pan:false});}

  fitUkraine(){this.map.fitBounds([[44.2,22.0],[52.6,40.3]],{padding:[32,32],maxZoom:7});}
  fitAll(){if(this.currentBounds?.length)this.map.fitBounds(this.currentBounds,{padding:[45,45],maxZoom:8});}

  showHistoryPoint(object,index){
    this.historyLayer.clearLayers();
    const items=(object.history||[]).filter(item=>item.coordinates).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    const target=items[index];if(!target)return false;
    const points=items.slice(0,index+1).map(item=>[item.coordinates[1],item.coordinates[0]]);
    if(points.length>1)L.polyline(points,{color:"#48d9e6",weight:3,opacity:.85,dashArray:"3 7",interactive:false}).addTo(this.historyLayer);
    const point=points.at(-1);
    L.circleMarker(point,{radius:8,color:"#fff",weight:2,fillColor:"#ff9d52",fillOpacity:1})
      .bindTooltip(`${new Date(target.timestamp).toLocaleString("ru-RU")} · ${target.status||"estimated"}`).addTo(this.historyLayer);
    this.map.panTo(point,{animate:true,duration:.35});return target;
  }

  showHistoryAt(object,minutes=0){
    this.historyLayer.clearLayers();const items=(object.history||[]).filter(item=>item.coordinates).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));if(!items.length)return false;
    const cutoff=Date.now()-Number(minutes)*60000;const eligible=minutes?items.filter(item=>Date.parse(item.timestamp)<=cutoff):items;const target=eligible.at(-1);if(!target||Math.abs(Date.parse(target.timestamp)-cutoff)>16*60000)return false;
    const trail=items.filter(item=>Date.parse(item.timestamp)<=Date.parse(target.timestamp));const points=trail.map(item=>[item.coordinates[1],item.coordinates[0]]);if(points.length>1)L.polyline(points,{color:"#48d9e6",weight:3,opacity:.85,dashArray:"3 7"}).addTo(this.historyLayer);
    const point=[target.coordinates[1],target.coordinates[0]];L.circleMarker(point,{radius:7,color:"#fff",fillColor:"#ff9d52",fillOpacity:1}).bindTooltip(`${minutes} мин назад · модель`).addTo(this.historyLayer);this.map.flyTo(point,Math.max(this.map.getZoom(),8),{duration:.5});return true;
  }
  toggleHistory(object){
    this.historyLayer.clearLayers();
    const items=(object.history||[]).filter((item)=>item.coordinates);
    const points=items.map((item)=>[item.coordinates[1],item.coordinates[0]]);
    if(points.length<2)return false;
    L.polyline(points,{color:"#48d9e6",weight:3,opacity:.9,dashArray:"3 7"}).addTo(this.historyLayer);
    points.forEach((point,index)=>L.circleMarker(point,{
      radius:index===points.length-1?5:3,color:"#d9fbff",fillColor:"#12313a",fillOpacity:1,
    }).bindTooltip(items[index].label||"Расчётный снимок").addTo(this.historyLayer));
    this.map.fitBounds(points,{padding:[60,60],maxZoom:9});return true;
  }

  clearHistory(){this.historyLayer.clearLayers();}
}
