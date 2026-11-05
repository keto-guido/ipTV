'use strict';
const zones={ET:'America/New_York',CT:'America/Chicago',PT:'America/Los_Angeles',UK:'Europe/London'};
const day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
function zoned(y,m,d,h,min,zone){const target=Date.UTC(y,m,d,h,min);let t=target;for(let i=0;i<4;i++){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date(t)).map(x=>[x.type,x.value]));const delta=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);if(!delta)return t;t+=delta;}return NaN;}
const eventGroup=s=>/^AM\s*\|\s*(USA|CA)\s*\|/i.test(s||'')&&/\b(NFL|NBA|NHL|MLB|NCAA|MLS|WNBA|ESPN PLUS|PPV|LIVE EVENT|TSN\+)/i.test(s);
function parse(c,group=c.group,now=Date.now()){
 if(!/^AM\s*\|\s*(USA|CA)\b/i.test(group||''))return null;
 let league=((c.name||'').match(/\b(WNBA|NFL|NBA|NHL|MLB|NCAA|MLS)\b/i)||String(group||'').match(/\b(WNBA|NFL|NBA|NHL|MLB|NCAA|MLS)\b/i))?.[1]?.toUpperCase()||null;
 if(league==='MLS')league='USA.1';
 if(league==='NCAA')league=/basketball|hoops/i.test(c.name)?'MENS-COLLEGE-BASKETBALL':/football/i.test(c.name)?'COLLEGE-FOOTBALL':'NCAA';
 const team=/\b(?:WNBA|NFL|NBA|NHL|MLB|NCAA|MLS)\s+TEAMS\s*[-:]\s*(.+)/i.exec(c.name||'');
 if(team&&league)return {league,team:team[1],channelId:String(c.id)};
 if(!eventGroup(group)&&!league)return null;
 const date=/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})(?:,?\s+(20\d{2}))?\s*[^\w]*\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*(ET|CT|PT|UK)\b/i.exec(c.name||'');if(!date)return null;
 const body=c.name.slice(0,date.index).replace(/^.*?\d+\s*:\s*/,'').replace(/\s*[–—|?\-]+\s*$/,'').replace(/^.*?\s[–—]\s(?=.*(?: @ | vs | at ))/i,'').trim(),teams=body.split(/\s+(?:@|vs\.?|v\.?|at|–|—|-)\s+/i);if(teams.length!==2||teams.some(t=>!t.trim()))return null;
 const [,mon,d,year,h,min,ap,z]=date;if(+h<1||+h>12||+min>59||+d<1||+d>31)return null;
 const month='JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').indexOf(mon.toUpperCase().slice(0,3)),y=new Date(now).getUTCFullYear();
 const times=(year?[+year]:[y-1,y,y+1]).map(yr=>zoned(yr,month,+d,+h%12+(ap.toUpperCase()==='PM'?12:0),+min,zones[z.toUpperCase()])).filter(Number.isFinite).sort((a,b)=>Math.abs(a-now)-Math.abs(b-now));if(!times.length)return null;
 return {league,away:teams[0].trim(),home:teams[1].trim(),startUtc:new Date(times[0]).toISOString(),channelId:String(c.id)};
}
module.exports={parse,eventGroup,day,zoned};
