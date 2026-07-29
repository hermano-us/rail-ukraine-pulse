const rows = (result) => result?.results || [];
const normalize = (value) => String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,"");
const trainKey = (value) => normalize(value).replace(/-/g,"");
const dateDistance = (left,right) => Math.abs(Date.parse(`${left}T00:00:00Z`)-Date.parse(`${right}T00:00:00Z`))/86_400_000;
const routeIdentity = (run) => `${normalize(run.origin)}>${normalize(run.destination)}|${normalize(run.route)}`;
const clamp = (value) => Math.max(0,Math.min(1,value));
const parseJson = (value) => { try { return JSON.parse(value||"{}")||{}; } catch { return {}; } };
const feature = (id,label,weight,matched,detail=null) => ({id,label,weight:Number(weight.toFixed(4)),matched:Boolean(matched),detail});

export function scoreRunCandidateDetails(event, candidate) {
  if(!event?.train_number||trainKey(event.train_number)!==trainKey(candidate.train_number))return null;
  const eventDate=event.service_date||String(event.occurred_at||"").slice(0,10),candidateDate=candidate.service_date||"",days=dateDistance(eventDate,candidateDate);
  if(!Number.isFinite(days)||days>1)return null;
  const features=[feature("train_number","Совпадает номер поезда",.42,true,String(candidate.train_number))]; let score=.42;
  const sameDate=days===0,dateWeight=sameDate?.24:.08;score+=dateWeight;features.push(feature("service_date",sameDate?"Совпадает дата рейса":"Соседняя дата рейса",dateWeight,true,candidateDate));
  const eventOrigin=normalize(event.origin),eventDestination=normalize(event.destination),candidateOrigin=normalize(candidate.origin),candidateDestination=normalize(candidate.destination);
  if(eventOrigin&&eventDestination&&eventOrigin===candidateOrigin&&eventDestination===candidateDestination){score+=.2;features.push(feature("direction","Совпадает направление",.2,true,`${candidate.origin} → ${candidate.destination}`));}
  else if(eventOrigin&&eventDestination&&eventOrigin===candidateDestination&&eventDestination===candidateOrigin){score-=.18;features.push(feature("opposite_direction","Противоположное направление",-.18,false,`${candidate.origin} → ${candidate.destination}`));}
  else features.push(feature("direction","Направление определено не полностью",0,false));
  const eventRoute=normalize(event.route),candidateRouteValue=normalize(candidate.route);if(eventRoute&&eventRoute===candidateRouteValue){score+=.14;features.push(feature("route","Совпадает маршрут",.14,true,candidate.route));}
  const station=normalize(event.station),candidateRoute=normalize([candidate.origin,candidate.route,candidate.destination].filter(Boolean).join(" ")),metadata=parseJson(candidate.metadata_json);
  const stationCalls=Array.isArray(metadata.stationCalls)?metadata.stationCalls:[],listedStations=[...(Array.isArray(metadata.stations)?metadata.stations:[]),...stationCalls.map((call)=>call.station)].map(normalize);
  const registryStationMatch=Boolean(station&&listedStations.includes(station)),routeStationMatch=Boolean(station&&candidateRoute.includes(station)),stationMatch=registryStationMatch||routeStationMatch,stationWeight=registryStationMatch?.12:routeStationMatch?.07:-.04;score+=stationWeight;features.push(feature("station",registryStationMatch?"Станция подтверждена суточным реестром":routeStationMatch?"Станция присутствует в маршруте":"Станция не подтверждена маршрутом",stationWeight,stationMatch,event.station||null));
  const eventTime=Date.parse(event.occurred_at||0),matchingCalls=stationCalls.filter((call)=>normalize(call.station)===station&&Number.isFinite(Date.parse(call.scheduledAt||""))).map((call)=>({call,gapMinutes:Math.abs(eventTime-Date.parse(call.scheduledAt))/60000})).sort((a,b)=>a.gapMinutes-b.gapMinutes),nearestCall=matchingCalls[0];
  if(nearestCall&&nearestCall.gapMinutes<=240){const scheduleWeight=.12*(1-nearestCall.gapMinutes/240);score+=scheduleWeight;features.push(feature("station_schedule","Событие попадает в станционное окно",scheduleWeight,true,`${nearestCall.gapMinutes.toFixed(0)} мин`));}else if(stationCalls.length)features.push(feature("station_schedule","Нет близкого станционного окна",-.03,false));
  const eventLocomotive=normalize(event.locomotive),candidateLocomotive=normalize(candidate.locomotive);if(eventLocomotive&&candidateLocomotive){const match=eventLocomotive===candidateLocomotive;score+=match?.12:-.16;features.push(feature("locomotive",match?"Совпадает локомотив":"Локомотив конфликтует",match?.12:-.16,match,candidate.locomotive));}
  const occurred=Date.parse(event.occurred_at||0),lastSeen=Date.parse(candidate.last_observed_at||0),timeGapHours=Math.abs(occurred-lastSeen)/3_600_000;if(Number.isFinite(timeGapHours)&&timeGapHours<=12){const weight=.06*(1-timeGapHours/12);score+=weight;features.push(feature("time_window","Подходит временное окно",weight,true,`${timeGapHours.toFixed(1)} ч`));}
  const fusionGrade=event.evidence_grade||event.evidenceGrade,independentSources=Number(event.independent_sources)||0,fusionReliability=Number(event.fusion_reliability);
  if(fusionGrade==="corroborated"&&independentSources>=2){const weight=.08;score+=weight;features.push(feature("source_corroboration","\u0424\u0430\u043a\u0442 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d \u043d\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043c\u044b\u043c\u0438 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430\u043c\u0438",weight,true,`${independentSources} \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430`));}
  else if(fusionGrade==="conflict"){score-=.12;features.push(feature("source_conflict","\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438 \u043f\u0440\u043e\u0442\u0438\u0432\u043e\u0440\u0435\u0447\u0430\u0442 \u0434\u0440\u0443\u0433 \u0434\u0440\u0443\u0433\u0443",-.12,false,`${independentSources||1} \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430`));}
  if(Number.isFinite(fusionReliability)){const weight=(fusionReliability-.5)*.08;score+=weight;features.push(feature("fusion_reliability","\u041d\u0430\u0434\u0451\u0436\u043d\u043e\u0441\u0442\u044c \u043e\u0431\u044a\u0435\u0434\u0438\u043d\u0451\u043d\u043d\u043e\u0433\u043e \u0444\u0430\u043a\u0442\u0430",weight,fusionReliability>=.7,`${Math.round(fusionReliability*100)}%`));}
  const completeness=[candidate.route,candidate.origin,candidate.destination].filter(Boolean).length/3,completenessWeight=completeness*.04;score+=completenessWeight;features.push(feature("completeness","Полнота карточки рейса",completenessWeight,completeness>=2/3,`${Math.round(completeness*100)}%`));
  return {score:clamp(Number(score.toFixed(4))),features};
}

export function scoreRunCandidate(event, candidate) { return scoreRunCandidateDetails(event,candidate)?.score??null; }

export function chooseCanonicalRun(event, candidates = []) {
  const evaluated=[];for(const candidate of candidates){const result=scoreRunCandidateDetails(event,candidate);if(result)evaluated.push({candidate,...result});}
  evaluated.sort((left,right)=>right.score-left.score||String(left.candidate.run_id).localeCompare(String(right.candidate.run_id)));
  if(!evaluated.length)return {status:"unmatched",confidence:0,canonicalRunId:null,candidates:[],margin:0,reviewReason:"no-candidates"};
  const bestByIdentity=new Map();for(const item of evaluated){const identity=routeIdentity(item.candidate)||item.candidate.run_id;if(!bestByIdentity.has(identity))bestByIdentity.set(identity,item);}
  const ranked=[...bestByIdentity.values()].sort((left,right)=>right.score-left.score),best=ranked[0],margin=best.score-(ranked[1]?.score||0);
  const weights=ranked.slice(0,5).map(item=>Math.exp((item.score-best.score)*6)),weightTotal=weights.reduce((sum,value)=>sum+value,0)||1;
  const candidatesOut=ranked.slice(0,5).map((item,index)=>({runId:item.candidate.run_id,trainNumber:item.candidate.train_number,serviceDate:item.candidate.service_date,origin:item.candidate.origin,destination:item.candidate.destination,route:item.candidate.route,score:item.score,probability:Number((weights[index]/weightTotal).toFixed(4)),features:item.features}));
  const corroborated=event.evidence_grade==="corroborated"&&Number(event.independent_sources)>=2;
  const autoThreshold=corroborated ? .62 : .68,marginThreshold=corroborated ? .05 : .08;
  const status=best.score>=autoThreshold&&(ranked.length===1||margin>=marginThreshold)?"linked":"pending";
  const reviewReason=status==="linked"?null:best.score<autoThreshold?"low-confidence":"candidate-conflict";
  return {status,confidence:best.score,canonicalRunId:status==="linked"?best.candidate.run_id:null,candidates:candidatesOut,margin:Number(margin.toFixed(4)),reviewReason,reasons:best.features};
}

async function batch(env,statements,size=60){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function linkRecentObservations(env, now = new Date().toISOString(), stationAliases = new Map()) {
  const [eventResult,runResult,expectedResult]=await Promise.all([
    env.DB.prepare(`SELECT e.event_id,e.run_id original_run_id,e.station,e.occurred_at,e.raw_update_json,o.train_number,o.service_date,o.route,o.origin,o.destination,fg.independent_sources,fg.effective_reliability fusion_reliability,fg.explanation_json fusion_explanation_json
      FROM events e LEFT JOIN runs o ON o.run_id=e.run_id LEFT JOIN observation_run_links l ON l.event_id=e.event_id LEFT JOIN observation_fusion_members fm ON fm.event_id=e.event_id LEFT JOIN observation_fusion_groups fg ON fg.fusion_id=fm.fusion_id
      WHERE e.event_type='station_report' AND e.occurred_at>=datetime('now','-7 days') AND (fm.event_id IS NULL OR fm.is_primary=1) AND (l.event_id IS NULL OR (l.status='pending' AND l.updated_at<datetime('now','-1 hour'))) ORDER BY e.occurred_at DESC LIMIT 500`).all(),
    env.DB.prepare("SELECT run_id,train_number,service_date,route,origin,destination,current_update_json,NULL metadata_json,first_observed_at,last_observed_at FROM runs WHERE last_observed_at>=datetime('now','-8 days') ORDER BY last_observed_at DESC LIMIT 3000").all(),
    env.DB.prepare("SELECT run_id,train_number,service_date,route,origin,destination,NULL current_update_json,metadata_json,first_seen_at first_observed_at,COALESCE(last_observation_at,updated_at) last_observed_at FROM expected_train_runs WHERE service_date>=date('now','-1 day') AND service_date<=date('now','+1 day') ORDER BY updated_at DESC LIMIT 5000").all(),
  ]);
  const runMap=new Map();for(const run of [...rows(runResult),...rows(expectedResult)])if(!runMap.has(run.run_id))runMap.set(run.run_id,run);
  const runs=[...runMap.values()].map(run=>{const raw=parseJson(run.current_update_json);return {...run,locomotive:raw.locomotive||raw.locomotiveNumber||null};}),statements=[];let linked=0,pending=0;
  for(const event of rows(eventResult)){
    const raw=parseJson(event.raw_update_json),fusion=parseJson(event.fusion_explanation_json),stationKey=normalize(event.station),enriched={...event,evidence_grade:fusion.evidenceGrade||null,train_number:event.train_number||raw.trainNumber||raw.train_number,service_date:event.service_date||raw.serviceDate,route:event.route||raw.route,origin:event.origin||raw.origin,destination:event.destination||raw.destination,locomotive:raw.locomotive||raw.locomotiveNumber||null,station_id:stationAliases.get(stationKey)||null};
    const matching=runs.filter((run)=>trainKey(run.train_number)===trainKey(enriched.train_number)),decision=chooseCanonicalRun(enriched,matching);if(decision.status==="linked")linked+=1;else pending+=1;
    statements.push(env.DB.prepare(`INSERT INTO observation_run_links(event_id,original_run_id,canonical_run_id,status,confidence,method,candidates_json,reason_json,linked_at,updated_at,review_reason,decision_source)
      VALUES(?1,?2,?3,?4,?5,'entity-resolution-v3',?6,?7,?8,?8,?9,'model') ON CONFLICT(event_id) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,status=excluded.status,confidence=excluded.confidence,method=excluded.method,candidates_json=excluded.candidates_json,reason_json=excluded.reason_json,review_reason=excluded.review_reason,decision_source='model',linked_at=CASE WHEN excluded.status='linked' THEN excluded.updated_at ELSE observation_run_links.linked_at END,updated_at=excluded.updated_at`)
      .bind(event.event_id,event.original_run_id,decision.canonicalRunId,decision.status,decision.confidence,JSON.stringify(decision.candidates),JSON.stringify({margin:decision.margin,trainNumber:enriched.train_number||null,station:event.station,stationId:enriched.station_id,reasons:decision.reasons}),now,decision.reviewReason));
    statements.push(env.DB.prepare("DELETE FROM observation_link_candidates WHERE event_id=?1").bind(event.event_id));
    for(const [index,candidate] of decision.candidates.entries())statements.push(env.DB.prepare(`INSERT INTO observation_link_candidates(event_id,run_id,rank,score,probability,feature_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)`)
      .bind(event.event_id,candidate.runId,index+1,candidate.score,candidate.probability,JSON.stringify(candidate.features),now));
    const workflowId=`observation-review:${event.event_id}`;
    if(decision.status==="pending")statements.push(env.DB.prepare(`INSERT INTO ops_workflows(workflow_id,movement_id,workflow_type,state,priority,title,description,created_by,created_at,updated_at) VALUES(?1,?2,'observation_link_review','open',?3,?4,?5,'entity-resolution-v3',?6,?6) ON CONFLICT(workflow_id) DO UPDATE SET state=CASE WHEN ops_workflows.state='resolved' THEN ops_workflows.state ELSE 'open' END,priority=excluded.priority,description=excluded.description,updated_at=excluded.updated_at`).bind(workflowId,event.original_run_id||event.event_id,decision.reviewReason==="candidate-conflict"?"high":"normal",`\u0423\u0442\u043e\u0447\u043d\u0438\u0442\u044c \u043f\u0440\u0438\u0432\u044f\u0437\u043a\u0443 \u043d\u0430\u0431\u043b\u044e\u0434\u0435\u043d\u0438\u044f ${enriched.train_number||event.event_id}`,`${decision.candidates.length} \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432; \u043b\u0443\u0447\u0448\u0438\u0439 ${Math.round(decision.confidence*100)}%, \u0440\u0430\u0437\u0440\u044b\u0432 ${Math.round(decision.margin*100)} \u043f.\u043f.`,now));
    else statements.push(env.DB.prepare("UPDATE ops_workflows SET state='resolved',resolved_at=?1,resolution='linked automatically by entity-resolution-v3',updated_at=?1 WHERE workflow_id=?2 AND state!='resolved'").bind(now,workflowId));
  }
  await batch(env,statements);return {processed:rows(eventResult).length,linked,pending};
}