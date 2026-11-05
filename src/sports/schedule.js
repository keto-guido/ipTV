'use strict';
function createCheck({provider,channels,epg,now=Date.now}){let busy=false,last='',retryAt=0;return async()=>{
 if(!channels.settings.sportsListRefresh||busy||now()<retryAt)return;
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now())).map(p=>[p.type,p.value])),slot=`${p.year}-${p.month}-${p.day}-${p.hour}`;
 if(!['06','12','17'].includes(p.hour)||p.minute!=='00'||last===slot||provider.refreshing||channels.list().some(c=>['starting','running','backoff'].includes(c.status)))return;
 busy=true;last=slot;try{await provider.refresh();epg.reindex();}catch{retryAt=now()+3600000;}finally{busy=false;}
 };}
module.exports={createCheck};
