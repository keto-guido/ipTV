'use strict';
const {normalize}=require('./espn'),{day,parse}=require('./parse');
const {norm,rank}=require('../provider');
const {broadcastChannels,eligible,network,channelNetwork,broadcastIndex}=require('./networks');
const contains=(text,aliases)=>aliases.some(a=>a&&(' '+normalize(text)+' ').includes(' '+a+' '));
function match(games,events,programmes,list,favorites=[],now=Date.now(),base='/tv'){
 const texts=new Map();
 const contains=(text,aliases)=>{if(!texts.has(text))texts.set(text,' '+normalize(text)+' ');const value=texts.get(text);return aliases.some(a=>a&&value.includes(' '+a+' '));};
 const used=new Set(),out={updatedAt:new Date(now).toISOString(),live:[],later:[],finished:[]},all=new Map((list?.all||list?.channels||[]).map(c=>[String(c.id),c]));
 const groups=new Map((list?.categories||[]).map(c=>[String(c.id),c.name]));
 const identities=new Map([...all.values()].map(c=>[String(c.id),channelNetwork(c)]));
 const tvIndex=broadcastIndex([...all.values()],groups);
 for(const original of games){if(day(original.startUtc)!==day(now))continue;
 // Shared city aliases cannot distinguish two teams in the same city.
 const shared=original.homeAliases.filter(a=>original.awayAliases.includes(a));
 const g={...original,homeAliases:original.homeAliases.filter(a=>!shared.includes(a)),awayAliases:original.awayAliases.filter(a=>!shared.includes(a))};
 const near=c=>Math.abs(Date.parse(c.startUtc)-Date.parse(g.startUtc))<=4*3600000;
 const leagueOK=e=>!e.league||e.league===g.league.toUpperCase()||e.league==='NCAA'&&g.league.includes('COLLEGE');
 const teamOK=e=>g.homeAliases.includes(normalize(e.team))||g.awayAliases.includes(normalize(e.team));
 const pairOK=e=>(contains(e.home,g.homeAliases)&&contains(e.away,g.awayAliases))||(contains(e.away,g.homeAliases)&&contains(e.home,g.awayAliases));
 const gameStart=Date.parse(g.startUtc),gameEnd=Date.parse(g.endUtc)||gameStart+4*3600000;
 const listed=new Set((g.broadcasts||[]).map(network).filter(Boolean));
 const national=new Set(['espn','espn2','espnu','espnews','acc','sec','btn','cbssn','tnt','tbs','trutv','fs1','fs2','nba','nhl','mlb','nfl','usa']);
 // Cached guide aliases can incorrectly copy ESPN listings onto ACC/SEC or Canadian feeds.
 // Known national networks require ESPN confirmation; regional/local guides still qualify.
 const guideAllowed=p=>{const c=all.get(String(p.channelId)),id=c&&identities.get(String(c.id));return !id||listed.has(id)||!(national.has(id)&&(g.broadcasts?.length||id==='tnt'||id==='trutv'))&&!(g.broadcasts?.length&&/^CA\s*-/.test(c.name));};
 const guides=programmes.filter(p=>guideAllowed(p)&&Date.parse(p.startUtc)<gameEnd&&Date.parse(p.endUtc)>gameStart&&[p.title,p.description].some(text=>contains(text,g.homeAliases)&&contains(text,g.awayAliases)));
 const candidates=[
 ...broadcastChannels(g.broadcasts||[],[...all.values()],groups,tvIndex).map(c=>({channelId:String(c.id),reason:'TV'})),
 ...events.filter(e=>leagueOK(e)&&!e.team&&near(e)&&pairOK(e)).map(e=>({...e,reason:'Event'})),
 ...guides.map(p=>({...p,reason:'Guide'})),
 ...events.filter(e=>leagueOK(e)&&e.team&&teamOK(e)).map(e=>({...e,reason:'Team'}))];
 const merged=new Map(),priority={TV:0,Event:0,Guide:1,Team:2};
 for(const candidate of candidates){
 const source=all.get(String(candidate.channelId));if(!source||!eligible(source,groups))continue;
 // A team channel always requires its own participating team, even if a guide claims otherwise.
 const parsed=events.find(e=>String(e.channelId)===String(source.id)&&e.team)||parse(source,source.group||groups.get(String(source.cat)),now);
 const teamEvent=parsed?.team?parsed:null;
 if(teamEvent&&(!leagueOK(teamEvent)||!teamOK(teamEvent)))continue;
 const c=all.get(String(list?.rep?.get(String(source.id))))||source;
 if(!eligible(c,groups))continue;
 const reason=teamEvent?'Team':candidate.reason,key=identities.get(String(c.id))||norm(c.name);
 const programme=guides.find(p=>String(p.channelId)===String(source.id))?.title||candidate.title;
 const next={...c,reason,programme};const old=merged.get(key);
 if(!old||priority[reason]<priority[old.reason]||priority[reason]===priority[old.reason]&&(rank(c.name)<rank(old.name)||rank(c.name)===rank(old.name)&&c.name.length<old.name.length))merged.set(key,next);
 used.add(String(source.id));
 }
 const channels=[...merged.values()].sort((a,b)=>priority[a.reason]-priority[b.reason]).slice(0,4).map(c=>({id:c.id,name:c.name,reason:c.reason,...(c.programme?{programme:c.programme}:{}),logo:c.icon?base+'/api/logo/'+encodeURIComponent(c.id):null}));
 const favorite=favorites.some(f=>normalize(f)===normalize(g.home)||normalize(f)===normalize(g.away)||g.homeAliases.includes(normalize(f))||g.awayAliases.includes(normalize(f))),{homeAliases,awayAliases,state,...game}=g;
 out[state==='in'?'live':state==='post'?'finished':'later'].push({...game,startLocal:new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'}).format(new Date(g.startUtc)),channels,notFound:!channels.length,favorite});
 }
 for(const key of ['live','later','finished'])out[key].sort((a,b)=>Number(b.favorite)-Number(a.favorite)||Date.parse(a.startUtc)-Date.parse(b.startUtc));
 out.unmatchedChannels=events.filter(e=>e.startUtc&&day(e.startUtc)===day(now)&&!used.has(e.channelId)).map(e=>({id:e.channelId,name:all.get(e.channelId)?.name||'',league:e.league,startUtc:e.startUtc}));return out;
}
module.exports={match};
