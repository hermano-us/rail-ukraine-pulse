import { calculateCalibrationProfileV3 } from "./calibration.js";
import { classifyTrainCategory } from "./rail-intelligence-v6.js";

const rows = (result) => result?.results || [];
const timeBucket = (value) => {
  const hour = new Date(value || 0).getUTCHours();
  if (!Number.isFinite(hour)) return "unknown";
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening";
};
const horizonBucket = (value) => Number(value) <= 30 ? "short" : Number(value) <= 120 ? "medium" : "long";
const profileId = (type, key) => `v4:${type}:${key}`;

export function calibrationDimensionsV4(item = {}) {
  const source = String(item.source_id || "unknown");
  const train = String(item.train_number || "unknown");
  const segment = `${item.from_station_id}>${item.to_station_id}`;
  const time = timeBucket(item.evaluated_at);
  const horizon = horizonBucket(item.horizon_minutes ?? item.predicted_minutes);
  return [
    { type: "source-train-segment-time-horizon", key: `${source}:${train}:${segment}:${time}:${horizon}`, sourceId: source, trainFamily: train, timeBucket: time, horizonBucket: horizon },
    { type: "source-segment-horizon", key: `${source}:${segment}:${horizon}`, sourceId: source, trainFamily: null, timeBucket: null, horizonBucket: horizon },
    { type: "train-segment", key: `${train}:${segment}`, sourceId: null, trainFamily: train, timeBucket: null, horizonBucket: null },
    { type: "segment", key: segment, sourceId: null, trainFamily: null, timeBucket: null, horizonBucket: null },
  ].map((dimension) => ({ ...dimension, profileId: profileId(dimension.type, dimension.key), fromStationId: item.from_station_id, toStationId: item.to_station_id }));
}

export function calibrationDimensionsV5(item = {}) {
  const modelVersion=String(item.model_version||item.modelVersion||"rail-intelligence-v5");
  const base=calibrationDimensionsV4(item),source=String(item.source_id||"unknown"),segment=`${item.from_station_id}>${item.to_station_id}`,time=timeBucket(item.evaluated_at),category=classifyTrainCategory(item.train_category||item.train_number);
  base.splice(1,0,
    {type:"source-category-segment-time",key:`${source}:${category}:${segment}:${time}`,sourceId:source,trainFamily:category,timeBucket:time,horizonBucket:null,fromStationId:item.from_station_id,toStationId:item.to_station_id},
    {type:"category-segment-time",key:`${category}:${segment}:${time}`,sourceId:null,trainFamily:category,timeBucket:time,horizonBucket:null,fromStationId:item.from_station_id,toStationId:item.to_station_id},
  );
  return base.map((dimension)=>({...dimension,modelVersion,profileId:`v5:${modelVersion}:${dimension.type}:${dimension.key}`}));
}

async function batch(env, statements, size = 60) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
}

export async function refreshCalibrationProfilesV4(env, now = new Date().toISOString(), aliases = new Map()) {
  const evaluations = rows(await env.DB.prepare("SELECT evaluation_id,train_number,source_id,evaluation_kind,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,evaluated_at,horizon_minutes FROM model_evaluations WHERE evaluation_kind='prospective' AND evaluated_at>=datetime('now','-60 days') ORDER BY evaluated_at DESC LIMIT 20000").all());
  const groups = new Map();
  for (const item of evaluations) {
    const canonical = { ...item, from_station_id: aliases.get(item.from_station_id) || item.from_station_id, to_station_id: aliases.get(item.to_station_id) || item.to_station_id };
    for (const dimension of calibrationDimensionsV4(canonical)) {
      const group = groups.get(dimension.profileId) || { dimension, items: [] };
      group.items.push(canonical); groups.set(dimension.profileId, group);
    }
  }
  const profiles = new Map(), statements = [];
  for (const [id, { dimension, items }] of groups) {
    const profile = calculateCalibrationProfileV3(items); if (!profile) continue;
    const row = { ...profile, ...dimension }; profiles.set(id, row);
    statements.push(env.DB.prepare(`INSERT INTO model_calibration_profiles_v4(profile_id,dimension_type,dimension_key,source_id,train_family,from_station_id,to_station_id,time_bucket,horizon_bucket,evaluation_count,prospective_count,mae_minutes,p80_coverage,bias_minutes,residual_p10_minutes,residual_p50_minutes,residual_p90_minutes,uncertainty_multiplier,readiness,window_started_at,window_ended_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
      ON CONFLICT(profile_id) DO UPDATE SET evaluation_count=excluded.evaluation_count,prospective_count=excluded.prospective_count,mae_minutes=excluded.mae_minutes,p80_coverage=excluded.p80_coverage,bias_minutes=excluded.bias_minutes,residual_p10_minutes=excluded.residual_p10_minutes,residual_p50_minutes=excluded.residual_p50_minutes,residual_p90_minutes=excluded.residual_p90_minutes,uncertainty_multiplier=excluded.uncertainty_multiplier,readiness=excluded.readiness,window_started_at=excluded.window_started_at,window_ended_at=excluded.window_ended_at,updated_at=excluded.updated_at`)
      .bind(id, dimension.type, dimension.key, dimension.sourceId, dimension.trainFamily, dimension.fromStationId, dimension.toStationId, dimension.timeBucket, dimension.horizonBucket, profile.evaluationCount, profile.prospectiveCount, profile.maeMinutes, profile.p80Coverage, profile.biasMinutes, profile.residualP10, profile.residualP50, profile.residualP90, profile.uncertaintyMultiplier, profile.readiness, profile.windowStartedAt, profile.windowEndedAt, now));
  }
  await batch(env, statements);
  return { profiles, updated: statements.length, evaluations: evaluations.length };
}

export async function refreshCalibrationProfilesV5(env, now = new Date().toISOString(), aliases = new Map()) {
  const evaluations=rows(await env.DB.prepare("SELECT evaluation_id,train_number,source_id,evaluation_kind,model_version,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,evaluated_at,horizon_minutes FROM model_evaluations WHERE evaluation_kind='prospective' AND evaluated_at>=datetime('now','-60 days') ORDER BY evaluated_at DESC LIMIT 20000").all());
  const groups=new Map();
  for(const item of evaluations){const canonical={...item,from_station_id:aliases.get(item.from_station_id)||item.from_station_id,to_station_id:aliases.get(item.to_station_id)||item.to_station_id};for(const dimension of calibrationDimensionsV5(canonical)){const group=groups.get(dimension.profileId)||{dimension,items:[]};group.items.push(canonical);groups.set(dimension.profileId,group);}}
  const profiles=new Map(),statements=[];
  for(const [id,{dimension,items}] of groups){const profile=calculateCalibrationProfileV3(items);if(!profile)continue;const row={...profile,...dimension};profiles.set(id,row);statements.push(env.DB.prepare(`INSERT INTO model_calibration_profiles_v5(profile_id,model_version,dimension_type,dimension_key,source_id,train_family,from_station_id,to_station_id,time_bucket,horizon_bucket,evaluation_count,prospective_count,mae_minutes,p80_coverage,bias_minutes,residual_p10_minutes,residual_p50_minutes,residual_p90_minutes,uncertainty_multiplier,readiness,window_started_at,window_ended_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
      ON CONFLICT(profile_id) DO UPDATE SET evaluation_count=excluded.evaluation_count,prospective_count=excluded.prospective_count,mae_minutes=excluded.mae_minutes,p80_coverage=excluded.p80_coverage,bias_minutes=excluded.bias_minutes,residual_p10_minutes=excluded.residual_p10_minutes,residual_p50_minutes=excluded.residual_p50_minutes,residual_p90_minutes=excluded.residual_p90_minutes,uncertainty_multiplier=excluded.uncertainty_multiplier,readiness=excluded.readiness,window_started_at=excluded.window_started_at,window_ended_at=excluded.window_ended_at,updated_at=excluded.updated_at`)
      .bind(id,dimension.modelVersion,dimension.type,dimension.key,dimension.sourceId,dimension.trainFamily,dimension.fromStationId,dimension.toStationId,dimension.timeBucket,dimension.horizonBucket,profile.evaluationCount,profile.prospectiveCount,profile.maeMinutes,profile.p80Coverage,profile.biasMinutes,profile.residualP10,profile.residualP50,profile.residualP90,profile.uncertaintyMultiplier,profile.readiness,profile.windowStartedAt,profile.windowEndedAt,now));}
  await batch(env,statements);return {profiles,updated:statements.length,evaluations:evaluations.length};
}

export function applyCalibrationV4(edge, profiles, context = {}) {
  const dimensions = calibrationDimensionsV4({ source_id: context.sourceId, train_number: context.trainFamily || edge.train_family, from_station_id: edge.from_station_id, to_station_id: edge.to_station_id, evaluated_at: context.predictedAt || new Date().toISOString(), horizon_minutes: edge.p50_minutes });
  const candidates = dimensions.map((item) => profiles.get(item.profileId)).filter((item) => item && item.prospectiveCount >= 3).sort((left, right) => right.prospectiveCount - left.prospectiveCount || right.evaluationCount - left.evaluationCount);
  const profile = candidates[0]; if (!profile) return edge;
  const rawP50 = Number(edge.p50_minutes), rawP10 = Number(edge.p10_minutes ?? rawP50), rawP90 = Number(edge.p90_minutes ?? rawP50);
  const p50 = Math.max(1, rawP50 + profile.residualP50);
  const halfRange = Math.max(p50 - Math.max(1, rawP10 + profile.residualP10), Math.max(p50, rawP90 + profile.residualP90) - p50) * profile.uncertaintyMultiplier;
  return { ...edge, p10_minutes: Number(Math.max(1, p50 - halfRange).toFixed(2)), p50_minutes: Number(p50.toFixed(2)), p90_minutes: Number((p50 + halfRange).toFixed(2)), calibration_profile: { version: "v4", dimension: profile.type, key: profile.key, readiness: profile.readiness, evaluations: profile.evaluationCount, prospective: profile.prospectiveCount, maeMinutes: profile.maeMinutes, p80Coverage: profile.p80Coverage, biasMinutes: profile.biasMinutes, uncertaintyMultiplier: profile.uncertaintyMultiplier } };
}


export function applyCalibrationV5(edge, profiles, context = {}) {
  const dimensions = calibrationDimensionsV5({ model_version:context.modelVersion||"rail-intelligence-v5", source_id: context.sourceId, train_number: context.trainFamily || edge.train_family, from_station_id: edge.from_station_id, to_station_id: edge.to_station_id, evaluated_at: context.predictedAt || new Date().toISOString(), horizon_minutes: edge.p50_minutes });
  const candidates = dimensions.map((dimension, specificity) => ({ dimension, specificity, profile: profiles.get(dimension.profileId) || profiles.get(`v4:${dimension.type}:${dimension.key}`) }))
    .filter((item) => item.profile && Number(item.profile.prospectiveCount) >= 3);
  if (!candidates.length) return edge;
  const weighted = candidates.map((item) => {
    const samples = Math.max(0, Number(item.profile.prospectiveCount) || 0);
    const readiness = item.profile.readiness === "operational" ? 1 : item.profile.readiness === "warming" ? .78 : .5;
    const specificity = Math.max(.45, 1 - item.specificity * .16);
    return { ...item, weight: Math.sqrt(samples) * readiness * specificity };
  });
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const blend = (field, fallback = 0) => weightTotal ? weighted.reduce((sum, item) => sum + (Number(item.profile[field]) || fallback) * item.weight, 0) / weightTotal : fallback;
  const prospective = weighted.reduce((sum, item) => sum + Number(item.profile.prospectiveCount || 0), 0);
  const shrinkage = Math.min(.92, prospective / (prospective + 10));
  const rawP50 = Number(edge.p50_minutes), rawP10 = Number(edge.p10_minutes ?? rawP50), rawP90 = Number(edge.p90_minutes ?? rawP50);
  const residualP10 = blend("residualP10"), residualP50 = blend("residualP50"), residualP90 = blend("residualP90");
  const p50 = Math.max(1, rawP50 + residualP50 * shrinkage);
  const empiricalHalfRange = Math.max(p50 - Math.max(1, rawP10 + residualP10 * shrinkage), Math.max(p50, rawP90 + residualP90 * shrinkage) - p50);
  const baselineHalfRange = Math.max(1, p50 - rawP10, rawP90 - p50);
  const coverage = blend("p80Coverage", 80);
  const coverageInflation = coverage < 75 ? Math.min(2, 75 / Math.max(35, coverage)) : 1;
  const uncertaintyMultiplier = Math.max(1, blend("uncertaintyMultiplier", 1)) * coverageInflation;
  const halfRange = Math.max(baselineHalfRange, empiricalHalfRange) * uncertaintyMultiplier;
  const primary = weighted.sort((left, right) => right.weight - left.weight)[0];
  return { ...edge, p10_minutes: Number(Math.max(1, p50 - halfRange).toFixed(2)), p50_minutes: Number(p50.toFixed(2)), p90_minutes: Number((p50 + halfRange).toFixed(2)), calibration_profile: { version: "v5", dimension: primary.dimension.type, key: primary.dimension.key, readiness: primary.profile.readiness, evaluations: weighted.reduce((sum, item) => sum + Number(item.profile.evaluationCount || 0), 0), prospective, maeMinutes: Number(blend("maeMinutes").toFixed(2)), p80Coverage: Number(coverage.toFixed(2)), biasMinutes: Number((residualP50 * shrinkage).toFixed(2)), uncertaintyMultiplier: Number(uncertaintyMultiplier.toFixed(3)), shrinkage: Number(shrinkage.toFixed(3)), blendedProfiles: weighted.length } };
}
