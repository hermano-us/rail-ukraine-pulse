import { runIdFor, serviceDateFor } from "../../backend/src/domain/events.js";

const parseClock = (value, serviceDate) => {
  if (Number.isFinite(Date.parse(value || ""))) return new Date(value).toISOString();
  const match=String(value||"").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);if(!match)return null;
  return `${serviceDate}T${match[1].padStart(2,"0")}:${match[2]}:00+03:00`;
};

export function buildExpectedRuns(updates = [], boardRecords = [], generatedAt = new Date().toISOString()) {
  const result=new Map();
  const add=(update,extra={})=>{if(!update?.trainNumber)return;const serviceDate=serviceDateFor(update,generatedAt),runId=runIdFor(update,generatedAt),key=runId,current=result.get(key)||{expectedId:`expected:${runId}`,runId,serviceDate,trainNumber:String(update.trainNumber),origin:update.origin||null,destination:update.destination||null,route:update.route||null,scheduledDeparture:null,scheduledArrival:null,sourceIds:[],discoveryCount:0,metadata:{stations:[]}};current.sourceIds=[...new Set([...current.sourceIds,update.sourceId||"unknown"])];current.discoveryCount+=1;if(extra.station&&!current.metadata.stations.includes(extra.station))current.metadata.stations.push(extra.station);if(extra.boardType==="departure")current.scheduledDeparture=current.scheduledDeparture||parseClock(extra.scheduledTime,serviceDate);if(extra.boardType==="arrival")current.scheduledArrival=current.scheduledArrival||parseClock(extra.scheduledTime,serviceDate);result.set(key,current);};
  for(const update of updates)add(update);
  for(const record of boardRecords){const update=updates.find((item)=>String(item.trainNumber)===String(record.trainNumber)&&item.route===record.route);if(update)add(update,record);}
  return [...result.values()].sort((a,b)=>a.trainNumber.localeCompare(b.trainNumber,undefined,{numeric:true}));
}
