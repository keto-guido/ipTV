'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{spawn,execFileSync}=require('child_process');
const {parse,zoned}=require('../src/sports/parse'),{games,createClient}=require('../src/sports/espn'),{match}=require('../src/sports/match'),{scan}=require('../src/sports/epg'),{createSports,DEFAULTS}=require('../src/sports'),{createCheck}=require('../src/sports/schedule');
// Only id/name/group are copied from the local channel cache, never URL fields.
const sample={id:'232815',name:'US - NHL GAME 01 : UTAH MAMMOTH @ TORONTO MAPLE LEAFS NOV 3 – 7:00 PM ET / NOV 4 – 12:00 AM UK',group:'AM | USA | NHL'};
const empty={id:'232809',name:'US - NBA GAME 01 : ',group:'AM | USA | NBA'};
const now=Date.parse('2026-11-04T01:00:00Z');
function scoreboard(date='2026-11-04T00:00:00Z'){return {events:[{id:'1',date,competitions:[{status:{type:{state:'in',shortDetail:'2nd Period'}},competitors:[{homeAway:'home',score:'2',team:{displayName:'Toronto Maple Leafs',shortDisplayName:'Maple Leafs',location:'Toronto',name:'Maple Leafs',abbreviation:'TOR'}},{homeAway:'away',score:'1',team:{displayName:'Utah Mammoth',shortDisplayName:'Mammoth',location:'Utah',name:'Mammoth',abbreviation:'UTA'}}]}]}]};}
test('real channel names: empty slots, year rollover, dual dates, timezone DST',()=>{
 assert.equal(parse(empty,empty.group,now),null);const p=parse(sample,sample.group,now);assert.equal(p.home,'TORONTO MAPLE LEAFS');assert.equal(p.startUtc,'2026-11-04T00:00:00.000Z');
 assert.equal(zoned(2026,6,1,19,0,'America/New_York'),Date.parse('2026-07-01T23:00:00Z'));
 assert.equal(zoned(2026,10,3,19,0,'America/New_York'),Date.parse('2026-11-04T00:00:00Z'));
 for(const [zone,hour] of [['ET','00'],['CT','01'],['PT','03'],['UK','19']]){const p=parse({...sample,name:sample.name.replace(/NOV 3.*$/,'NOV 3 - 7:00 PM '+zone)},sample.group,now);assert.equal(new Date(p.startUtc).getUTCHours(),+hour);}
 for(const sep of ['vs','v','at','–','-'])assert.ok(parse({...sample,name:sample.name.replace(' @ ',' '+sep+' ')},sample.group,now));
 assert.equal(parse(sample,'EU | SPORTS',now),null);
 const tsn={id:'1119194',name:'CA - TSN+ 07 : NCAA FOOTBALL – BUFFALO @ MIAMI (OH) – NOV 3 – 8:00 PM ET / NOV 4 – 1:00 AM UK',group:'AM | CA | TSN+'};
 assert.equal(parse(tsn,tsn.group,now).away,'BUFFALO');
 assert.equal(new Date(parse({...sample,name:sample.name.replace(/NOV 3.*$/,'JAN 1 - 7:00 PM ET')},sample.group,Date.parse('2026-12-31')).startUtc).getUTCFullYear(),2027);
});
test('mocked ESPN matching, EPG, missing channels, regular variant and favorites',()=>{
 const g=games(scoreboard(),'NHL'),event=parse(sample,sample.group,now),c={id:sample.id,name:sample.name,cat:'1'},list={categories:[{id:'1',name:'AM | USA | SPORTS'}],channels:[c],all:[c],rep:new Map()};
 let out=match(g,[event],[],list,['Utah Mammoth'],now);assert.equal(out.live[0].channels[0].id,sample.id);assert.equal(out.live[0].favorite,true);assert.equal(out.live[0].score,'1-2');
 out=match(g,[],[],list,[],now);assert.equal(out.live[0].notFound,true);
 out=match(g,[],[{channelId:c.id,title:'Live: Utah at Toronto',startUtc:g[0].startUtc}],list,[],now);assert.equal(out.live[0].notFound,false);
 const hd={...c,id:'2',name:c.name+' HD'};list.all.push(hd);out=match(g,[event,{...event,channelId:'2'}],[],list,[],now);assert.deepEqual(out.live[0].channels.map(c=>c.id),[sample.id]);
 const ps=scan(list,{range:()=>({[c.id]:[[Date.parse(g[0].startUtc)/1000,now/1000+3600,'Live: Utah at Toronto']]})},now);assert.equal(ps.length,1);
});
test('ESPN concurrency, cache, coalescing, partial failure',async()=>{let active=0,max=0,calls=0;const client=createClient(async()=>{calls++;active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,2));active--;if(calls===2)throw Error('offline');return {ok:true,json:async()=>scoreboard()};});await Promise.all([client.today('20261103'),client.today('20261103')]);assert.ok(max<=2);assert.equal(calls,8);await client.today('20261103');assert.ok(calls<=9);});
test('favorites persist per user including empty list',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'sports-fav-'));try{const s=createSports({provider:{},epg:{},data:root});assert.deepEqual(s.teams('one'),DEFAULTS);s.setTeams('one',[]);assert.deepEqual(createSports({provider:{},epg:{},data:root}).teams('one'),[]);assert.deepEqual(s.teams('two'),DEFAULTS);assert.throws(()=>s.setTeams('one',['x'.repeat(101)]));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('expired ESPN data remains available when all feeds fail',async()=>{
 const originalNow=Date.now;let clock=originalNow(),offline=false;
 Date.now=()=>clock;
 try {const client=createClient(async()=>{if(offline)throw Error('offline');return {ok:true,json:async()=>scoreboard()};});const initial=await client.today('20261103');assert.equal(initial.length,8);clock+=600001;offline=true;assert.deepEqual(await client.today('20261103'),initial);}finally{Date.now=originalNow;}
});
test('favorites sort first and state chooses all three sections',()=>{
 const base=games(scoreboard(),'NHL')[0];const rows=[{...base,espnId:'first',state:'pre',home:'Other team',homeAliases:['other team']},{...base,espnId:'favorite',state:'pre'},{...base,espnId:'final',state:'post'},base];
 const out=match(rows,[],[],null,['Toronto Maple Leafs'],now);assert.equal(out.later[0].espnId,'favorite');assert.equal(out.finished.length,1);assert.equal(out.live.length,1);
});
test('refresh disabled by default, busy guards and single scheduled call',async()=>{let calls=0,running=false,enabled=false;const channels={settings:{get sportsListRefresh(){return enabled;}},list:()=>running?[{status:'running'}]:[]},provider={refreshing:false,refresh:async()=>{calls++;}},epg={reindex(){}};const check=createCheck({provider,channels,epg,now:()=>Date.parse('2026-11-04T12:00:00Z')});await check();assert.equal(calls,0);enabled=true;running=true;await check();assert.equal(calls,0);running=false;provider.refreshing=true;await check();assert.equal(calls,0);provider.refreshing=false;await Promise.all([check(),check()]);assert.equal(calls,1);});
test('HTTP auth, read-only today, favorites isolated and validated',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sports-http-'));let proc;
 try{fs.writeFileSync(path.join(root,'jwt'),crypto.randomBytes(32).toString('hex'));fs.writeFileSync(path.join(root,'scoreboard.json'),JSON.stringify(scoreboard(new Date().toISOString())));
 const token=execFileSync(process.execPath,[path.resolve('scripts/mint-token.js'),path.join(root,'jwt'),'tv'],{encoding:'utf8'});
 proc=spawn(process.execPath,[path.resolve('test/sports-fixture-server.js')],{env:{...process.env,SPORTS_TEST_ROOT:root,HOST:'127.0.0.1',PORT:'0',DEV_AUTH:'0',EPG_AUTO:'0'},stdio:['ignore','pipe','pipe']});
 // Obtain the ephemeral port without changing production defaults.
 let output='';const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);proc.stdout.on('data',d=>{output+=d;const m=output.match(/sports-test-port:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]+'/tv');}});proc.once('exit',()=>reject(Error('fixture exited')));});
 const req=(p,opt={})=>fetch(base+p,{...opt,headers:{Cookie:'msv_session='+token,'Content-Type':'application/json',...opt.headers}});
 assert.equal((await fetch(base+'/api/sports/today')).status,401);assert.equal((await fetch(base+'/api/sports/teams')).status,401);
 const r=await req('/api/sports/today');assert.equal(r.status,200);const data=await r.json();assert.equal(data.live.length,8);assert.ok(data.live.every(g=>g.notFound));
 assert.deepEqual(await (await req('/api/sports/teams')).json(),DEFAULTS);
 assert.equal((await req('/api/sports/teams',{method:'PUT',body:'[]'})).status,200);assert.deepEqual(await (await req('/api/sports/teams')).json(),[]);
 assert.equal((await req('/api/sports/teams',{method:'PUT',body:'{}'})).status,400);
 assert.equal((await req('/api/sports/teams',{method:'PUT',body:'[]',headers:{'sec-fetch-site':'cross-site'}})).status,403);
 }finally{if(proc){proc.kill();await new Promise(r=>proc.once('exit',r));}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

// Cache-derived channel fixtures contain only id/name/group.
const teamChannels=[
 {id:'79532',name:'US - NBA TEAMS - CHICAGO BULLS FHD',group:'AM | USA | NBA'},
 {id:'79547',name:'US - NBA TEAMS - NEW YORK KNICKS FHD',group:'AM | USA | NBA'},
 {id:'79550',name:'US - NBA TEAMS - PHILADELPHIA 76ERS  FHD',group:'AM | USA | NBA'},
 {id:'79536',name:'US - NBA TEAMS - DETROIT PISTONS FHD',group:'AM | USA | NBA'}
];
function nbaGames(){
 const team=(displayName,location,name,abbreviation)=>({displayName,location,name,abbreviation,shortDisplayName:name});
 return games({events:[['Chicago Bulls','Chicago','Bulls','CHI','New York Knicks','New York','Knicks','NY'],['Philadelphia 76ers','Philadelphia','76ers','PHI','Detroit Pistons','Detroit','Pistons','DET']].map((t,i)=>({id:String(i),date:'2026-11-05T00:30:00Z',competitions:[{status:{type:{state:'in',shortDetail:'Halftime'}},competitors:[{homeAway:'away',score:'41',team:team(...t.slice(0,4))},{homeAway:'home',score:'78',team:team(...t.slice(4))}]}]}))},'NBA');
}
test('both home and away NBA team channels match without EPG',()=>{
 const clock=Date.parse('2026-11-05T01:00:00Z'),list={channels:teamChannels};
 const out=match(nbaGames(),teamChannels.map(c=>parse(c,c.group,clock)),[],list,[],clock);
 assert.deepEqual(out.live.map(g=>g.channels.map(c=>c.id)),[['79532','79547'],['79550','79536']]);
 assert.equal(out.live[0].score,'41-78');assert.equal(out.live[0].status,'Halftime');
});
test('EPG scans plain USA/CA groups, team-only titles and current programmes across midnight',()=>{
 const clock=Date.parse('2026-11-05T01:00:00Z');
 const cs=[{id:'1045049',name:'US - CHICAGO SPORTS NETWORK HD',group:'AM | USA'}, {id:'71324',name:'US - TNT EAST HD ◉',group:'AM | CA'}];
 const list={categories:[{id:'us',name:'AM | USA'},{id:'ca',name:'AM | CA'}],channels:cs.map((c,i)=>({...c,cat:i?'ca':'us'}))};
 const tuples={'1045049':[[clock/1000-6*3600,clock/1000+3600,'Chicago Bulls vs New York Knicks','']], '71324':[[clock/1000-3600,clock/1000+3600,'76ers at Pistons','']]};
 const ps=scan(list,{range(ids,from,to){assert.deepEqual(ids,cs.map(c=>c.id));assert.ok(from<clock/1000&&to>clock/1000);return tuples;}},clock);
 const out=match(nbaGames(),[],ps,list,[],clock);assert.deepEqual(out.live.map(g=>g.channels.map(c=>c.id)),[['1045049'],['71324']]);
 // A programme that started yesterday but is still airing is included.
 assert.equal(scan(list,{range:()=>({'1045049':[[Date.parse('2026-11-04T04:30:00Z')/1000,clock/1000+1,'Bulls at Knicks','']]})},clock).length,1);
 // Descriptions mentioning teams are insufficient when the title is unrelated.
 assert.equal(match(nbaGames(),[],scan(list,{range:()=>({'1045049':[[clock/1000,clock/1000+1,'Sports news','Bulls at Knicks']]})},clock),list,[],clock).live[0].notFound,true);
});
test('stale event names cannot match today; group/name league derivation and normalized aliases',()=>{
 const clock=Date.parse('2026-11-05T01:00:00Z'),old=parse(sample,sample.group,clock),g=games(scoreboard('2026-11-05T00:00:00Z'),'NHL');
 assert.equal(match(g,[old],[],{channels:[sample]},[],clock).live[0].notFound,true);
 assert.equal(old.league,'NHL');assert.equal(parse(sample,'AM | USA | NCAA',clock).league,'NHL');
 const ncaa={...sample,name:sample.name.replace('NHL','NCAA')};assert.equal(parse(ncaa,'AM | USA | NCAA',clock).league,'NCAA');
 assert.equal(parse({...ncaa,name:ncaa.name.replace('UTAH','FOOTBALL UTAH')},ncaa.group,clock).league,'COLLEGE-FOOTBALL');
 assert.equal(parse({...ncaa,name:ncaa.name.replace('UTAH','BASKETBALL UTAH')},ncaa.group,clock).league,'MENS-COLLEGE-BASKETBALL');
 const fresh={...old,startUtc:g[0].startUtc,away:'#10 Útah Mammoth FHD',home:'Toronto Maple Leafs 4K'};
 assert.equal(match(g,[fresh],[],{channels:[sample]},[],clock).live[0].notFound,false);
 const boundary={...fresh,startUtc:new Date(Date.parse(g[0].startUtc)+4*3600000+1).toISOString()};
 assert.equal(match(g,[boundary],[],{channels:[sample]},[],clock).live[0].notFound,true);
});
