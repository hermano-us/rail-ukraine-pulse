const rows=(result)=>result?.results||[];
const jsonBody=async(request)=>{try{return await request.json();}catch{return null;}};
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));

export async function handlePublicObservationRequest(request,env,json){
  if(request.method==="GET"){
    const result=await env.DB.prepare(`SELECT expected_id,train_number,origin,destination,route,status,scheduled_departure,scheduled_arrival FROM expected_train_runs WHERE service_date=date('now') AND status IN ('planned','active','unobserved') ORDER BY train_number LIMIT 1500`).all();
    return json({generatedAt:new Date().toISOString(),runs:rows(result),policy:{stationFactsOnly:true,coordinatesAccepted:false,moderationRequired:true}},200);
  }
  if(request.method!=="POST")return json({error:"method_not_allowed"},405);
  const body=await jsonBody(request);if(!body||body.website)return json({error:"invalid_submission"},400);
  const expectedId=String(body.expectedId||"").trim(),station=String(body.station||"").trim(),observedAt=String(body.observedAt||new Date().toISOString()),note=String(body.note||"").trim().slice(0,300);
  if(!expectedId||station.length<2||station.length>180||!Number.isFinite(Date.parse(observedAt)))return json({error:"invalid_submission"},400);
  const ageMinutes=(Date.now()-Date.parse(observedAt))/60000;if(ageMinutes>180||ageMinutes< -5)return json({error:"observation_time_out_of_range"},400);
  const expected=await env.DB.prepare("SELECT expected_id,run_id,train_number FROM expected_train_runs WHERE expected_id=?1 AND service_date>=date('now','-1 day') AND service_date<=date('now','+1 day')").bind(expectedId).first();if(!expected)return json({error:"expected_run_not_found"},404);
  const id=crypto.randomUUID(),now=new Date().toISOString();await env.DB.prepare(`INSERT INTO rail_observation_submissions(submission_id,expected_id,run_id,train_number,station_name,observed_at,submitted_at,submission_type,confidence,note,moderation_status,metadata_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'passenger',?8,?9,'pending','{"coordinatesAccepted":false}')`).bind(id,expected.expected_id,expected.run_id,expected.train_number,station,new Date(Date.parse(observedAt)).toISOString(),now,clamp(body.confidence,.25,.55)||.4,note||null).run();
  return json({ok:true,submissionId:id,status:"pending",message:"Observation queued for moderation"},202);
}

export async function reviewObservationSubmission(env,principal,{submissionId,decision}){
  if(!["approve","reject"].includes(decision))return {error:"invalid_decision",status:400};const submission=await env.DB.prepare("SELECT s.*,x.service_date,x.route,x.origin,x.destination FROM rail_observation_submissions s LEFT JOIN expected_train_runs x ON x.expected_id=s.expected_id WHERE s.submission_id=?1 AND s.moderation_status='pending'").bind(submissionId).first();if(!submission)return {error:"submission_not_found",status:404};const now=new Date().toISOString();
  if(decision==="reject"){await env.DB.prepare("UPDATE rail_observation_submissions SET moderation_status='rejected',reviewed_by=?1,reviewed_at=?2 WHERE submission_id=?3").bind(principal.id,now,submissionId).run();return {ok:true,decision};}
  const eventId=`passenger-witness:${submissionId}`;await env.DB.batch([env.DB.prepare(`INSERT OR IGNORE INTO runs(run_id,train_number,service_date,route,origin,destination,current_update_json,first_observed_at,last_observed_at) VALUES(?1,?2,?3,?4,?5,?6,'{}',?7,?7)`).bind(submission.run_id,submission.train_number,submission.service_date||submission.observed_at.slice(0,10),submission.route||null,submission.origin||null,submission.destination||null,submission.observed_at),env.DB.prepare(`INSERT OR IGNORE INTO events(event_id,run_id,event_type,event_value_json,station,occurred_at,observed_at,source_id,authority,reliability,position_evidence,raw_update_json) VALUES(?1,?2,'station_report','{}',?3,?4,?5,'passenger-witness','reference',?6,'moderated-station-witness',?7)`).bind(eventId,submission.run_id,submission.station_name,submission.observed_at,now,clamp(submission.confidence,.25,.6),JSON.stringify({submissionId,note:submission.note||null})),env.DB.prepare("UPDATE rail_observation_submissions SET moderation_status='approved',reviewed_by=?1,reviewed_at=?2,resulting_event_id=?3 WHERE submission_id=?4").bind(principal.id,now,eventId,submissionId)]);return {ok:true,decision,eventId};
}