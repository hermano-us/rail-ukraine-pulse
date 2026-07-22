let configPromise;
export async function getConfig(){
  if(!configPromise) configPromise=fetch("../data/runtime-config.json",{cache:"no-store"}).then(r=>r.ok?r.json():{}).catch(()=>({}));
  return configPromise;
}
export async function fuelFetch(path,{signal}={}){
  const config=await getConfig(); const base=String(config.apiBase||"").replace(/\/$/,"");
  const response=await fetch(`${base}${path}`,{signal,headers:{Accept:"application/json"}});
  if(!response.ok) throw new Error(`API HTTP ${response.status}`); return response.json();
}
