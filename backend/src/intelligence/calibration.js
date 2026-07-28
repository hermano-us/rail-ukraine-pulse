const rows = (result) => result?.results || [];
const percentile = (values, value) => values.length ? values[Math.min(values.length-1,Math.max(0,Math.round((values.length-1)*value)))] : null;
const profileKey = (family,from,to) => `${family||"unknown"}:${from}>${to}`;

export function calculateCalibrationProfile(evaluations = []) {
  const valid=evaluations.filter((item)=>Number.isFinite(Number(item.actual_minutes))&&Number.isFinite(Number(item.predicted_minutes)));if(!valid.length)return null;
  const residuals=valid.map((item)=>Number(item.actual_minutes)-Number(item.predicted_minutes)).sort((a,b)=>a-b),errors=valid.map((item)=>Math.abs(Number(item.actual_minutes)-Number(item.predicted_minutes))),prospective=valid.filter((item)=>!String(item.evaluation_id||"").startsWith("replay:")).length;
  return {evaluationCount:valid.length,prospectiveCount:prospective,maeMinutes:Number((errors.reduce((sum,value)=>sum+value,0)/errors.length).toFixed(2)),p80Coverage:Number((valid.filter((item)=>Number(item.within_p80)===1).length/valid.length*100).toFixed(2)),residualP10:Number(percentile(residuals,.1).toFixed(2)),residualP50:Number(percentile(residuals,.5).toFixed(2)),residualP90:Number(percentile(residuals,.9).toFixed(2)),readiness:valid.length>=10&&prospective>=3?"operational":valid.length>=3?"warming":"insufficient-evidence",windowStartedAt:valid.map((item)=>item.evaluated_at).filter(Boolean).sort()[0]||null,windowEndedAt:valid.map((item)=>item.evaluated_at).filter(Boolean).sort().at(-1)||null};
}

async function batch(env,statements,size=60){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function refreshCalibrationProfiles(env, now = new Date().toISOString(), stationAliases = new Map()) {
  const evaluations=rows(await env.DB.prepare("SELECT evaluation_id,train_number,from_station_id,to_station_id,predicted_minutes,actual_minutes,within_p80,evaluated_at FROM model_evaluations WHERE evaluated_at>=datetime('now','-30 days') ORDER BY evaluated_at DESC LIMIT 5000").all()),groups=new Map();
  for(const item of evaluations){const canonical={...item,from_station_id:stationAliases.get(item.from_station_id)||item.from_station_id,to_station_id:stationAliases.get(item.to_station_id)||item.to_station_id},key=profileKey(canonical.train_number,canonical.from_station_id,canonical.to_station_id),group=groups.get(key)||[];group.push(canonical);groups.set(key,group);}
  const profiles=new Map(),statements=[];for(const [key,items] of groups){const profile=calculateCalibrationProfile(items);if(!profile)continue;const sample=items[0],row={...profile,trainFamily:sample.train_number||"unknown",fromStationId:sample.from_station_id,toStationId:sample.to_station_id};profiles.set(key,row);statements.push(env.DB.prepare(`INSERT INTO model_calibration_profiles(profile_id,train_family,from_station_id,to_station_id,evaluation_count,prospective_count,mae_minutes,p80_coverage,residual_p10_minutes,residual_p50_minutes,residual_p90_minutes,readiness,window_started_at,window_ended_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(profile_id) DO UPDATE SET evaluation_count=excluded.evaluation_count,prospective_count=excluded.prospective_count,mae_minutes=excluded.mae_minutes,p80_coverage=excluded.p80_coverage,residual_p10_minutes=excluded.residual_p10_minutes,residual_p50_minutes=excluded.residual_p50_minutes,residual_p90_minutes=excluded.residual_p90_minutes,readiness=excluded.readiness,window_started_at=excluded.window_started_at,window_ended_at=excluded.window_ended_at,updated_at=excluded.updated_at`).bind(key,row.trainFamily,row.fromStationId,row.toStationId,profile.evaluationCount,profile.prospectiveCount,profile.maeMinutes,profile.p80Coverage,profile.residualP10,profile.residualP50,profile.residualP90,profile.readiness,profile.windowStartedAt,profile.windowEndedAt,now));}
  await batch(env,statements);return {profiles,updated:statements.length,evaluations:evaluations.length};
}

export function applyCalibration(edge, profiles) {
  const profile=profiles.get(profileKey(edge.train_family,edge.from_station_id,edge.to_station_id));if(!profile||profile.evaluationCount<3)return edge;
  const rawP50=Number(edge.p50_minutes),rawP10=Number(edge.p10_minutes??rawP50),rawP90=Number(edge.p90_minutes??rawP50),p50=Math.max(1,rawP50+profile.residualP50),p10=Math.max(1,Math.min(p50,rawP10+profile.residualP10)),p90=Math.max(p50,rawP90+profile.residualP90);
  return {...edge,p10_minutes:Number(p10.toFixed(2)),p50_minutes:Number(p50.toFixed(2)),p90_minutes:Number(p90.toFixed(2)),calibration_profile:{readiness:profile.readiness,evaluations:profile.evaluationCount,prospective:profile.prospectiveCount,maeMinutes:profile.maeMinutes,p80Coverage:profile.p80Coverage}};
}
