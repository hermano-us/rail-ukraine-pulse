const rows = (result) => result?.results || [];
const normalize = (value) => String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,"");
const trainKey = (value) => normalize(value).replace(/-/g,"");
const dateDistance = (left,right) => Math.abs(Date.parse(`${left}T00:00:00Z`)-Date.parse(`${right}T00:00:00Z`))/86_400_000;
const routeIdentity = (run) => `${normalize(run.origin)}>${normalize(run.destination)}|${normalize(run.route)}`;

export function scoreRunCandidate(event, candidate) {
  if(!event?.train_number||trainKey(event.train_number)!==trainKey(candidate.train_number))return null;
  const eventDate=event.service_date||String(event.occurred_at||"").slice(0,10),candidateDate=candidate.service_date||"",days=dateDistance(eventDate,candidateDate);if(!Number.isFinite(days)||days>1)return null;
  let score=.42+(days===0?.24:.08);const eventOrigin=normalize(event.origin),eventDestination=normalize(event.destination),candidateOrigin=normalize(candidate.origin),candidateDestination=normalize(candidate.destination);
  if(eventOrigin&&eventDestination&&eventOrigin===candidateOrigin&&eventDestination===candidateDestination)score+=.2;
  else if(eventOrigin&&eventDestination&&eventOrigin===candidateDestination&&eventDestination===candidateOrigin)score-=.18;
  else if(normalize(event.route)&&normalize(event.route)===normalize(candidate.route))score+=.14;
  const station=normalize(event.station),candidateRoute=normalize([candidate.origin,candidate.route,candidate.destination].filter(Boolean).join(" "));if(station&&candidateRoute.includes(station))score+=.08;
  const completeness=[candidate.route,candidate.origin,candidate.destination].filter(Boolean).length/3;score+=completeness*.04;
  return Math.max(0,Math.min(1,Number(score.toFixed(4))));
}

export function chooseCanonicalRun(event, candidates = []) {
  const groups=new Map();for(const candidate of candidates){const score=scoreRunCandidate(event,candidate);if(score==null)continue;const identity=routeIdentity(candidate)||candidate.run_id,group=groups.get(identity)||{score:0,candidates:[]};group.score=Math.max(group.score,score);group.candidates.push(candidate);groups.set(identity,group);}
  const ranked=[...groups.values()].sort((left,right)=>right.score-left.score);if(!ranked.length)return {status:"unmatched",confidence:0,canonicalRunId:null,candidates:[]};
  const best=ranked[0],margin=best.score-(ranked[1]?.score||0);best.candidates.sort((left,right)=>{const completenessRight=[right.route,right.origin,right.destination].filter(Boolean).length,completenessLeft=[left.route,left.origin,left.destination].filter(Boolean).length;return completenessRight-completenessLeft||Date.parse(left.first_observed_at||0)-Date.parse(right.first_observed_at||0)||String(left.run_id).localeCompare(String(right.run_id));});
  const status=best.score>=.68&&(ranked.length===1||margin>=.08)?"linked":"pending";return {status,confidence:best.score,canonicalRunId:status==="linked"?best.candidates[0].run_id:null,candidates:ranked.slice(0,4).map((group)=>({score:group.score,runIds:group.candidates.map((item)=>item.run_id)})),margin:Number(margin.toFixed(4))};
}

async function batch(env,statements,size=60){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function linkRecentObservations(env, now = new Date().toISOString()) {
  const [eventResult,runResult]=await Promise.all([
    env.DB.prepare(`SELECT e.event_id,e.run_id original_run_id,e.station,e.occurred_at,e.raw_update_json,o.train_number,o.service_date,o.route,o.origin,o.destination
      FROM events e LEFT JOIN runs o ON o.run_id=e.run_id LEFT JOIN observation_run_links l ON l.event_id=e.event_id
      WHERE e.event_type='station_report' AND e.occurred_at>=datetime('now','-7 days') AND (l.event_id IS NULL OR (l.status='pending' AND l.updated_at<datetime('now','-1 hour'))) ORDER BY e.occurred_at DESC LIMIT 500`).all(),
    env.DB.prepare("SELECT run_id,train_number,service_date,route,origin,destination,first_observed_at,last_observed_at FROM runs WHERE last_observed_at>=datetime('now','-8 days') ORDER BY last_observed_at DESC LIMIT 3000").all(),
  ]);
  const runs=rows(runResult),statements=[];let linked=0,pending=0;
  for(const event of rows(eventResult)){let raw={};try{raw=JSON.parse(event.raw_update_json||"{}");}catch{}const enriched={...event,train_number:event.train_number||raw.trainNumber||raw.train_number,service_date:event.service_date||raw.serviceDate,route:event.route||raw.route,origin:event.origin||raw.origin,destination:event.destination||raw.destination},matching=runs.filter((run)=>trainKey(run.train_number)===trainKey(enriched.train_number)),decision=chooseCanonicalRun(enriched,matching);if(decision.status==="linked")linked+=1;else pending+=1;
    statements.push(env.DB.prepare(`INSERT INTO observation_run_links(event_id,original_run_id,canonical_run_id,status,confidence,method,candidates_json,reason_json,linked_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,'train-date-direction-v1',?6,?7,?8,?8) ON CONFLICT(event_id) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,status=excluded.status,confidence=excluded.confidence,method=excluded.method,candidates_json=excluded.candidates_json,reason_json=excluded.reason_json,linked_at=CASE WHEN excluded.status='linked' THEN excluded.updated_at ELSE observation_run_links.linked_at END,updated_at=excluded.updated_at`).bind(event.event_id,event.original_run_id,decision.canonicalRunId,decision.status,decision.confidence,JSON.stringify(decision.candidates),JSON.stringify({margin:decision.margin,trainNumber:enriched.train_number||null,station:event.station}),now));}
  await batch(env,statements);return {processed:statements.length,linked,pending};
}
