import test from "node:test";
import assert from "node:assert/strict";

test("public route client progressively covers all routes in bounded response batches",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options={})=>{
    if(String(url)==="data/runtime-config.json")return Response.json({apiBase:"https://api.example",railRoutesPath:"/api/v1/rail-routes",requestTimeoutMs:1000});
    const body=JSON.parse(options.body);calls.push(body.routes.length);return Response.json({versionId:"osm-v1",routes:body.routes.map((item)=>({key:item.key,status:"ready",versionId:"osm-v1",method:"osm-route-aware-v7",quality:.95,confidence:.9,totalKm:100,geometry:{type:"LineString",coordinates:[[30,50],[31,51]]}}))});
  };
  try{
    const {loadPublicRailRoutes}=await import(`../js/live-data-client.js?progressive=${Date.now()}`),updates=Array.from({length:70},(_,index)=>({trainNumber:String(700+index),origin:`Origin ${index}`,destination:`Destination ${index}`,operationalStatus:"moving"}));
    const first=await loadPublicRailRoutes(updates),second=await loadPublicRailRoutes(updates),third=await loadPublicRailRoutes(updates),fourth=await loadPublicRailRoutes(updates),forced=await loadPublicRailRoutes([updates[69]],{force:true});
    assert.deepEqual(calls,[20,20,20,10,1]);assert.equal(first.routes.length,20);assert.equal(second.routes.length,40);assert.equal(third.routes.length,60);assert.equal(fourth.routes.length,70);assert.equal(forced.routes[0].method,"osm-route-aware-v7");assert.equal(fourth.routes.every((route)=>route.method==="osm-route-aware-v7"),true);
  }finally{globalThis.fetch=originalFetch;}
});
