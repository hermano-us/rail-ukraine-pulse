import { POSITION_STATUSES } from "./positioning.js";
import { OPERATION_COLORS, OPERATION_LABELS } from "./formatters-ukraine.js";

const GLYPHS = { moving: "↗", station: "■", depot: "D", "source-unavailable": "?" };

export class MapView {
  constructor(elementId, onSelect) {
    this.onSelect = onSelect;
    this.map = L.map(elementId, { zoomControl: false, minZoom: 4, worldCopyJump: false }).setView([49.1, 31.1], 6);
    L.control.zoom({ position: "bottomleft" }).addTo(this.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(this.map);
    this.regionLayer = L.geoJSON(null, { interactive: false }).addTo(this.map);
    this.routeLayer = L.geoJSON(null, { style: { color: "#2f6475", weight: 2, opacity: 0.48 } }).addTo(this.map);
    this.estimateLayer = L.layerGroup().addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);
    this.historyLayer = L.layerGroup().addTo(this.map);
    this.markers = new Map();
  }

  setRegions(regions, selectedIds) {
    this.regions = regions;
    this.selectedRegionIds = selectedIds;
    this.regionLayer.clearLayers();
    this.regionLayer.addData(regions);
    this.regionLayer.eachLayer((layer) => {
      const id = layer.feature.properties.id;
      layer.setStyle(this.regionStyle(id));
    });
  }

  regionStyle(id) {
    const active = this.selectedRegionIds?.has(id);
    return { color: active ? "#4bc9d4" : "#42515a", weight: active ? 1.2 : 0.6, opacity: active ? 0.55 : 0.18, fillColor: active ? "#1c6370" : "#15232b", fillOpacity: active ? 0.08 : 0.025 };
  }

  updateRegionSelection(selectedIds) {
    this.selectedRegionIds = selectedIds;
    this.regionLayer.eachLayer((layer) => layer.setStyle(this.regionStyle(layer.feature.properties.id)));
  }

  setRoutes(routes) { this.routeLayer.clearLayers(); this.routeLayer.addData(routes); }

  render(objects, routeMap) {
    this.markerLayer.clearLayers(); this.estimateLayer.clearLayers(); this.markers.clear();
    const bounds = [];
    objects.forEach((object) => {
      const [lon, lat] = object.position.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const status = object.position.status;
      const operation = object.operationalStatus || "moving";
      const color = OPERATION_COLORS[operation] || POSITION_STATUSES[status].color;
      const estimateLabel = status === "estimated" ? "<em>Расчётное положение</em>" : `<em>${OPERATION_LABELS[operation]}</em>`;
      const icon = L.divIcon({ className: "transport-marker", html: `<div class="transport-icon ${status} operation-${operation}" style="--marker-color:${color}"><b>${GLYPHS[operation]}</b><span class="marker-label">${object.name}${estimateLabel}</span></div>`, iconSize: [30,30], iconAnchor: [15,15] });
      const zIndexOffset = operation === "depot" ? 2500 : status === "estimated" ? 2000 : 1000;
      const marker = L.marker([lat,lon], { icon, keyboard:true, title:object.name, zIndexOffset, riseOnHover:true, riseOffset:4000 }).addTo(this.markerLayer);
      marker.on("click", () => this.onSelect(object));
      marker.bindTooltip(`${object.name} · ${OPERATION_LABELS[operation]} · ${POSITION_STATUSES[status].label}`, { direction:"top", offset:[0,-14] });
      this.markers.set(object.id, marker); bounds.push([lat,lon]);
      if (status === "estimated") this.drawEstimatedRoute(routeMap.get(object.routeId));
    });
    this.currentBounds = bounds;
  }

  drawEstimatedRoute(route) {
    if (!route) return;
    L.polyline(route.geometry.coordinates.map(([lon,lat]) => [lat,lon]), { className:"estimated-track", color:"#ff9d52", weight:2, opacity:0.42 }).addTo(this.estimateLayer);
  }
  fitAll() { if (this.currentBounds?.length) this.map.fitBounds(this.currentBounds, { padding:[45,45], maxZoom:8 }); }
  focusObject(object) { const marker=this.markers.get(object.id); if (marker) this.map.flyTo(marker.getLatLng(), Math.max(this.map.getZoom(),8), {duration:.6}); }
  toggleHistory(object) {
    this.historyLayer.clearLayers();
    const points=(object.history||[]).filter((item)=>item.coordinates).map((item)=>[item.coordinates[1],item.coordinates[0]]);
    if(points.length<2)return false;
    L.polyline(points,{color:"#48d9e6",weight:3,opacity:.9,dashArray:"3 7"}).addTo(this.historyLayer);
    points.forEach((point,index)=>L.circleMarker(point,{radius:index===points.length-1?5:3,color:"#d9fbff",fillColor:"#12313a",fillOpacity:1}).addTo(this.historyLayer));
    this.map.fitBounds(points,{padding:[60,60],maxZoom:9}); return true;
  }
  clearHistory(){this.historyLayer.clearLayers();}
}
