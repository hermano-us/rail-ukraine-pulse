const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const parseJson=(value)=>{try{return JSON.parse(value||"{}")||{};}catch{return {};}};

function freshnessFactor(occurredAt,now){
  const ageMinutes=Math.max(0,(Date.parse(now)-Date.parse(occurredAt))/60000);
  return {ageMinutes:Number(ageMinutes.toFixed(1)),factor:Math.pow(.5,ageMinutes/360)};
}

export function buildRestrictedFreightLayer(evidence=[],now=new Date().toISOString()){
  const corridorGroups=new Map(),stationFacts=[];
  for(const item of evidence){
    if(["rejected","expired"].includes(item.review_status)||item.sensitivity_level==="highly_restricted")continue;
    const occurredAt=item.occurred_at;
    if(!Number.isFinite(Date.parse(occurredAt)))continue;
    const freshness=freshnessFactor(occurredAt,now);
    if(freshness.ageMinutes>1440)continue;
    const classification=parseJson(item.classification_json),confidence=clamp(item.confidence)*freshness.factor;
    const base={evidenceId:item.evidence_id,sourceId:item.source_id,sourceUrl:item.source_url||null,occurredAt,confidence:Number(confidence.toFixed(3)),ageMinutes:freshness.ageMinutes,reviewStatus:item.review_status,freightType:classification.freightType||"unclassified_rail",locomotive:classification.locomotive||null,direction:classification.direction||null,excerpt:item.evidence_excerpt};
    const corridorCode=String(item.corridor_code||"").trim();
    if(corridorCode&&corridorCode!=="unresolved"){
      const group=corridorGroups.get(corridorCode)||{corridorCode,evidence:[],sources:new Set(),latestAt:occurredAt};
      group.evidence.push(base);group.sources.add(item.source_id);
      if(Date.parse(occurredAt)>Date.parse(group.latestAt))group.latestAt=occurredAt;
      corridorGroups.set(corridorCode,group);
    }
    if(classification.station)stationFacts.push({...base,station:String(classification.station).slice(0,120),factStatus:item.review_status==="corroborated"?"confirmed":"reported"});
  }
  const corridors=[...corridorGroups.values()].map((group)=>{
    const ordered=group.evidence.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
    const combined=1-ordered.reduce((remaining,item)=>remaining*(1-clamp(item.confidence)*.75),1);
    const sourceCount=group.sources.size,confirmed=ordered.some(item=>item.reviewStatus==="corroborated")||sourceCount>=2;
    const confidence=clamp(combined+(confirmed ? .08 : 0),.05,.92);
    return {corridorCode:group.corridorCode,latestAt:group.latestAt,observationCount:ordered.length,independentSources:sourceCount,confidence:Number(confidence.toFixed(3)),uncertaintyKm:Math.round(18+(1-confidence)*105),status:confirmed?"corroborated":"estimated",direction:ordered.find(item=>item.direction)?.direction||null,freightTypes:[...new Set(ordered.map(item=>item.freightType))],evidence:ordered.slice(0,8)};
  }).sort((a,b)=>Date.parse(b.latestAt)-Date.parse(a.latestAt));
  stationFacts.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
  return {corridors,stationFacts:stationFacts.slice(0,150),policy:{visibility:"restricted",exactFreightPositions:false,stationPointsRequireExplicitEvidence:true,maxAgeHours:24}};
}
