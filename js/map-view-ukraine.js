import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS } from "./formatters-ukraine.js";

const GLYPHS={moving:"↗",station:"■",depot:"D","source-unavailable":"?"};

export class MapView{
  constructor(elementId,onSelect){
    this.onSelect=onSelect;
    this.map=L.map(elementId,{zoomControl:false,minZoom:4,worldCopyJump:false}).setView([49.1,31.1],6);
    L.control.zoom({position:"bottomleft"}).addTo(this.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.regionLayer=L.geoJSON(null,{interactive:false}).addTo(this.map);
    this.routeLayer=L.geoJSON(null,{interactive:false,style:{color:"#2f6475",weight:1.4,opacity:0.16}}).addTo(this.map);
    this.uncertaintyLayer=L.layerGroup().addTo(this.map);
    this.selectedLayer=L.layerGroup().addTo(this.map);
    this.markerLayer=L.layerGroup().addTo(this.map);
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

  setRoutes(routes){this.routeLayer.clearLayers();this.routeLayer.addData(routes);}

  render(objects,routeMap){
    this.currentRouteMap=routeMap;this.markerLayer.clearLayers();this.uncertaintyLayer.clearLayers();this.selectedLayer.clearLayers();
    this.markers.clear();this.objects=new Map(objects.map((object)=>[object.id,object]));
    const bounds=[];
    objects.forEach((object)=>{
      const [lon,lat]=object.position.coordinates||[];
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
      const status=object.position.status,operation=object.operationalStatus||"moving";
      const color=OPERATION_COLORS[operation]||POSITION_STATUSES[status].color;
      const estimateLabel=status==="estimated"?"<em>Расчётное · не GPS</em>":`<em>${OPERATION_LABELS[operation]}</em>`;
      const delay=object.liveUpdate?.delayLabel||"—";
      const icon=L.divIcon({
        className:"transport-marker",
        html:`<div class="transport-icon ${status} operation-${operation}" style="--marker-color:${color}"><b>${GLYPHS[operation]}</b><span class="marker-label">${object.name}<small>${delay}</small>${estimateLabel}</span></div>`,
        iconSize:[30,30],iconAnchor:[15,15],
      });
      const marker=L.marker([lat,lon],{
        icon,keyboard:true,alt:`${object.name}: ${object.route}`,title:`${object.name}: ${object.route}`,zIndexOffset:status==="estimated"?2000:2500,riseOnHover:true,riseOffset:4000,
      }).addTo(this.markerLayer);
      marker.on("click",()=>this.onSelect(object));
      marker.bindTooltip(`${object.name} · ${object.route} · ${delay}`,{direction:"top",offset:[0,-14]});
      this.markers.set(object.id,marker);bounds.push([lat,lon]);
      if(status==="estimated"&&Number.isFinite(object.position.errorKm)){
        L.circle([lat,lon],{
          radius:object.position.errorKm*1000,color:"#ff9d52",weight:1,opacity:.22,fillColor:"#ff9d52",fillOpacity:.025,
          interactive:false,className:"uncertainty-zone",
        }).addTo(this.uncertaintyLayer);
      }
    });
    this.currentBounds=bounds;
  }

  focusObject(object){
    const marker=this.markers.get(object.id);
    if(!marker)return;
    this.selectedLayer.clearLayers();
    this.markerLayer.eachLayer((layer)=>layer.getElement?.()?.classList.remove("is-selected"));
    marker.getElement()?.classList.add("is-selected");
    const route=this.currentRouteMap?.get(object.routeId);
    if(route){
      L.polyline(route.geometry.coordinates.map(([lon,lat])=>[lat,lon]),{
        className:"estimated-track selected-track",color:"#ff9d52",weight:3,opacity:.82,dashArray:"7 8",interactive:false,
      }).addTo(this.selectedLayer);
    }
    if(object.corridor?.coordinates?.length>1){
      const corridorPoints=object.corridor.coordinates.map(([lon,lat])=>[lat,lon]);
      L.polyline(corridorPoints,{className:"model-corridor-halo",color:"#ff9d52",weight:14,opacity:.14,lineCap:"round",interactive:false}).addTo(this.selectedLayer);
      L.polyline(corridorPoints,{className:"model-corridor",color:"#ffb171",weight:4,opacity:.9,dashArray:"2 7",lineCap:"round",interactive:false}).addTo(this.selectedLayer);
    }
    const [lon,lat]=object.position.coordinates||[];
    if(Number.isFinite(lat)&&Number.isFinite(lon)&&Number.isFinite(object.position.errorKm)){
      L.circle([lat,lon],{
        radius:object.position.errorKm*1000,color:"#ffb171",weight:1.5,opacity:.7,fillColor:"#ff9d52",fillOpacity:.07,interactive:false,
      }).addTo(this.selectedLayer);
    }
    this.map.flyTo(marker.getLatLng(),Math.max(this.map.getZoom(),8),{duration:.6});
  }

  fitAll(){if(this.currentBounds?.length)this.map.fitBounds(this.currentBounds,{padding:[45,45],maxZoom:8});}

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

  clearHistory(){this.historyLayer.clearLayers();this.selectedLayer.clearLayers();}
}
