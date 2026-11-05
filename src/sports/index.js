'use strict';
const fs=require('fs'),path=require('path');
const {parse,day}=require('./parse'),{scan}=require('./epg'),{match}=require('./match'),{createClient}=require('./espn');
const DEFAULTS=['Chicago Bears','Chicago Bulls','Chicago Blackhawks','Chicago Cubs','Chicago White Sox'];
function createSports({provider,epg,data,base='/tv',client=createClient()}){
 const file=path.join(data,'sports-teams.json');let users={};try{users=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 return {teams(user){return Object.hasOwn(users,user)?users[user]:[...DEFAULTS];},setTeams(user,teams){if(!Array.isArray(teams)||teams.length>100||teams.some(t=>typeof t!=='string'||!t.trim()||t.length>100))throw Error('invalid teams');const next={...users,[user]:[...new Set(teams.map(t=>t.trim()))]};fs.mkdirSync(data,{recursive:true});fs.writeFileSync(file,JSON.stringify(next));users=next;return users[user];},async today(user,now=Date.now()){const list=provider.load(),groups=new Map((list?.categories||[]).map(c=>[c.id,c.name]));const events=(list?.channels||[]).map(c=>parse(c,groups.get(c.cat),now)).filter(Boolean);return match(await client.today(day(now).replace(/[^0-9]/g,'')),events,scan(list,epg,now),list,this.teams(user),now,base);}};
}
module.exports={createSports,DEFAULTS};
