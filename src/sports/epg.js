'use strict';
const {day,zoned}=require('./parse');
// range() resolves stream ids to [start seconds, end seconds, title, description].
function scan(list,epg,now=Date.now()){
 if(!list||!epg?.range)return [];
 const groups=new Map((list.categories||[]).map(c=>[String(c.id),c.name]));
 const channels=list.channels.filter(c=>/^AM\s*\|\s*(USA|CA)\b/i.test(groups.get(String(c.cat))||c.group||''));
 const [y,m,d]=day(now).split('-').map(Number),from=zoned(y,m-1,d,0,0,'America/Chicago')/1000,to=zoned(y,m-1,d+1,0,0,'America/Chicago')/1000;
 const range=epg.range(channels.map(c=>String(c.id)),from,to);
 return channels.flatMap(c=>(range[c.id]||[]).filter(p=>p[0]<to&&p[1]>from&&(p[0]>=from||p[0]<=now/1000&&p[1]>now/1000)).map(p=>({channelId:String(c.id),title:p[2]||'',description:p[3]||'',startUtc:new Date(p[0]*1000).toISOString(),endUtc:new Date(p[1]*1000).toISOString()})));
}
module.exports={scan};
