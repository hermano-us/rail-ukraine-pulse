const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const parseJson=(value)=>{try{return JSON.parse(value||"{}")||{};}catch{return {};}};

function freshnessFactor(occurredAt,now){
  const ageMinutes=Math.max(0,(Date.parse(now)-Date.parse(occurredAt))/60000);
  return {ageMinutes:Number(ageMinutes.toFixed(1)),factor:Math.pow(.5,ageMinutes/360)};
}

export function buildRestrictedFreightLayer(evidence=[],now=new Date().toISOString()){
  const corridorGroups=new Map(),trackGroups=new Map(),stationFacts=[];
  for(const item of evidence){
    if(["rejected","expired"].includes(item.review_status)||item.sensitivity_level==="highly_restricted")continue;
    const occurredAt=item.occurred_at;
    if(!Number.isFinite(Date.parse(occurredAt)))continue;
    const freshness=freshnessFactor(occurredAt,now);
    if(freshness.ageMinutes>1440)continue;
    const classification=parseJson(item.classification_json),confidence=clamp(item.confidence)*freshness.factor;
    const base={evidenceId:item.evidence_id,sourceId:item.source_id,sourceUrl:item.source_url||null,occurredAt,confidence:Number(confidence.toFixed(3)),ageMinutes:freshness.ageMinutes,reviewStatus:item.review_status,freightType:classification.freightType||"unclassified_rail",locomotive:classification.locomotive||null,trainNumber:classification.trainNumber||null,direction:classification.direction||null,station:classification.station||null,stationEvidence:classification.stationEvidence||null,entityKey:classification.entityKey||null,entityConfidence:clamp(classification.entityConfidence),excerpt:item.evidence_excerpt};
    const corridorCode=String(item.corridor_code||"").trim();
    if(corridorCode&&corridorCode!=="unresolved"){
      const group=corridorGroups.get(corridorCode)||{corridorCode,evidence:[],sources:new Set(),latestAt:occurredAt};
      group.evidence.push(base);group.sources.add(item.source_id);
      if(Date.parse(occurredAt)>Date.parse(group.latestAt))group.latestAt=occurredAt;
      corridorGroups.set(corridorCode,group);
    }
    if(base.entityKey&&base.entityConfidence>=.8){const track=trackGroups.get(base.entityKey)||{trackId:base.entityKey,evidence:[],sources:new Set(),corridors:new Set()};track.evidence.push(base);track.sources.add(item.source_id);if(corridorCode&&corridorCode!=="unresolved")track.corridors.add(corridorCode);trackGroups.set(base.entityKey,track);}
    if(classification.station)stationFacts.push({...base,station:String(classification.station).slice(0,120),factStatus:item.review_status==="corroborated"?"confirmed":"reported"});
  }
  const corridors=[...corridorGroups.values()].map((group)=>{
    const ordered=group.evidence.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
    const combined=1-ordered.reduce((remaining,item)=>remaining*(1-clamp(item.confidence)*.75),1);
    const sourceCount=group.sources.size,confirmed=ordered.some(item=>item.reviewStatus==="corroborated")||sourceCount>=2;
    const confidence=clamp(combined+(confirmed ? .08 : 0),.05,.92);
    return {corridorCode:group.corridorCode,latestAt:group.latestAt,observationCount:ordered.length,independentSources:sourceCount,confidence:Number(confidence.toFixed(3)),uncertaintyKm:Math.round(18+(1-confidence)*105),status:confirmed?"corroborated":"estimated",direction:ordered.find(item=>item.direction)?.direction||null,freightTypes:[...new Set(ordered.map(item=>item.freightType))],evidence:ordered.slice(0,8)};
  }).sort((a,b)=>Date.parse(b.latestAt)-Date.parse(a.latestAt));
  const tracks=[...trackGroups.values()].map(track=>{const evidence=track.evidence.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)),sources=track.sources.size,latest=evidence.at(-1);return {trackId:track.trackId,locomotive:latest.locomotive,trainNumber:latest.trainNumber,corridorCodes:[...track.corridors],firstObservedAt:evidence[0].occurredAt,lastObservedAt:latest.occurredAt,observationCount:evidence.length,independentSources:sources,status:sources>=2||evidence.some(item=>item.reviewStatus==="corroborated")?"corroborated":"estimated",direction:[...evidence].reverse().find(item=>item.direction)?.direction||null,stationSequence:evidence.filter(item=>item.station).map(item=>({station:item.station,occurredAt:item.occurredAt,evidence:item.stationEvidence||"reported"})),confidence:Number(clamp(1-evidence.reduce((remaining,item)=>remaining*(1-item.confidence*.7),1),.05,.94).toFixed(3)),evidence:evidence.slice(-12)};}).sort((a,b)=>Date.parse(b.lastObservedAt)-Date.parse(a.lastObservedAt));
  stationFacts.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
  return {corridors,tracks,stationFacts:stationFacts.slice(0,150),policy:{visibility:"restricted",exactFreightPositions:false,stationPointsRequireExplicitEvidence:true,entityLinking:"stable-identifier-only",maxAgeHours:24}};
}
