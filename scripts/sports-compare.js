'use strict';
// Offline only. Project channel records immediately, so upstream fields never escape.
const fs=require('fs'),path=require('path');
const {createClient}=require('../src/sports/espn'),{parse}=require('../src/sports/parse'),{match}=require('../src/sports/match'),{scan}=require('../src/sports/epg');
function cached(){
 const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/channels.json'),'utf8'));
 const groups=new Map(raw.categories.map(c=>[String(c.id),c.name]));
 const channels=raw.channels.map(c=>({id:String(c.id),name:c.name,group:c.group||groups.get(String(c.cat))}));
 const range={};
 for(const file of ['epg.json','epg_public.json']){
  let epg;try{epg=JSON.parse(fs.readFileSync(path.join(__dirname,'../data',file),'utf8'));}catch{continue;}
  for(const c of raw.channels){if(range[c.id])continue;const key=file==='epg.json'?(epg.ch?.[c.epg]?c.epg:epg.map?.[c.id]):epg.map?.[c.id];if(key&&epg.ch?.[key])range[c.id]=epg.ch[key];}
 }
 return {list:{channels},epg:{range:()=>range}};
}
async function compare(date='20261104'){
 const now=Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T18:00:00-06:00`);
 const {list,epg}=cached();
 const client=createClient(()=>{throw Error('Offline fixtures only');},{fixtureDir:path.join(__dirname,'../test/fixtures/espn')});
 const games=await client.today(date),events=list.channels.map(c=>parse(c,c.group,now)).filter(Boolean);
 const result=match(games,events,scan(list,epg,now),list,[],now);
 return [...result.live,...result.later,...result.finished].sort((a,b)=>Date.parse(a.startUtc)-Date.parse(b.startUtc));
}
if(require.main===module)compare(process.argv[2]).then(rows=>{
 console.log('game | ESPN broadcasts | our matched channels (reason)');
 for(const g of rows)console.log(`${g.away} @ ${g.home} | ${g.broadcasts.join(', ')||'—'} | ${g.channels.map(c=>`${c.name} (${c.reason})`).join('; ')||'Not found'}`);
}).catch(()=>{console.error('Offline comparison failed; check cached data and fixture files.');process.exitCode=1;});
module.exports={compare,cached};
