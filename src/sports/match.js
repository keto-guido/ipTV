'use strict';
const {normalize}=require('./espn'),{day}=require('./parse');
const {norm,rank}=require('../provider');
const contains=(text,aliases)=>aliases.some(a=>a&&(' '+normalize(text)+' ').includes(' '+a+' '));
function match(games,events,programmes,list,favorites=[],now=Date.now(),base='/tv'){
 const used=new Set(),out={updatedAt:new Date(now).toISOString(),live:[],later:[],finished:[]},all=new Map((list?.all||list?.channels||[]).map(c=>[String(c.id),c]));
 for(const original of games){if(day(original.startUtc)!==day(now))continue;
 // Shared city aliases cannot distinguish two teams in the same city.
 const shared=original.homeAliases.filter(a=>original.awayAliases.includes(a));
 const g={...original,homeAliases:original.homeAliases.filter(a=>!shared.includes(a)),awayAliases:original.awayAliases.filter(a=>!shared.includes(a))};
 const near=c=>Math.abs(Date.parse(c.startUtc)-Date.parse(g.startUtc))<=4*3600000;
 const candidates=[...events.filter(e=>(!e.league||e.league===g.league.toUpperCase()||e.league==='NCAA'&&g.league.includes('COLLEGE'))&&(e.team?(g.homeAliases.includes(normalize(e.team))||g.awayAliases.includes(normalize(e.team))):near(e)&&((contains(e.home,g.homeAliases)&&contains(e.away,g.awayAliases))||(contains(e.away,g.homeAliases)&&contains(e.home,g.awayAliases))))),...programmes.filter(p=>contains(p.title,g.homeAliases)&&contains(p.title,g.awayAliases))];
 const ids=candidates.map(c=>{used.add(c.channelId);return list?.rep?.get(c.channelId)||c.channelId;});
 const merged=new Map();
 for(const c of [...new Set(ids)].map(id=>all.get(id)).filter(Boolean)) { const key=norm(c.name),old=merged.get(key);if(!old||rank(c.name)<rank(old.name)||rank(c.name)===rank(old.name)&&c.name.length<old.name.length)merged.set(key,c); }
 const channels=[...merged.values()].map(c=>({id:c.id,name:c.name,logo:c.icon?base+'/api/logo/'+encodeURIComponent(c.id):null}));
 const favorite=favorites.some(f=>normalize(f)===normalize(g.home)||normalize(f)===normalize(g.away)||g.homeAliases.includes(normalize(f))||g.awayAliases.includes(normalize(f))),{homeAliases,awayAliases,state,...game}=g;
 out[state==='in'?'live':state==='post'?'finished':'later'].push({...game,startLocal:new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'}).format(new Date(g.startUtc)),channels,notFound:!channels.length,favorite});
 }
 for(const key of ['live','later','finished'])out[key].sort((a,b)=>Number(b.favorite)-Number(a.favorite)||Date.parse(a.startUtc)-Date.parse(b.startUtc));
 out.unmatchedChannels=events.filter(e=>e.startUtc&&day(e.startUtc)===day(now)&&!used.has(e.channelId)).map(e=>({id:e.channelId,name:all.get(e.channelId)?.name||'',league:e.league,startUtc:e.startUtc}));return out;
}
module.exports={match};
