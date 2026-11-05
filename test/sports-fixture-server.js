'use strict';
// Isolated HTTP harness: no provider, encoder, live output or automatic EPG work.
const path=require('path'),fs=require('fs');
const http=require('http'),createServer=http.createServer;
http.createServer=function(...args){const server=createServer(...args);server.on('listening',()=>console.log('sports-test-port:'+server.address().port));return server;};
const {cfg}=require('../src/config');
cfg.JWT_SECRET_FILE=path.join(process.env.SPORTS_TEST_ROOT,'jwt');
cfg.SECRETS_FILE=path.join(process.env.SPORTS_TEST_ROOT,'missing');
if(process.env.SPORTS_USE_DATA!=='1')cfg.DATA=process.env.SPORTS_TEST_ROOT;
const provider=require('../src/provider'),channels=require('../src/channels'),epg=require('../src/epg'),live=require('../src/live');
for(const key of ['refresh','getList','streamUrl'])provider[key]=()=>{throw Error('provider disabled');};
for(const key of ['select','touch','replace','retry','keepalive'])channels[key]=()=>{throw Error('stream action forbidden');};
channels.init=()=>{};channels.settings.sportsListRefresh=false;epg.init=()=>epg.load();live.init=()=>{};
if(process.env.SPORTS_LIVE_ESPN!=='1'){
 const fixture=JSON.parse(fs.readFileSync(path.join(process.env.SPORTS_TEST_ROOT,'scoreboard.json'),'utf8'));
 global.fetch=async url=>({ok:true,json:async()=>fixture.byLeague ? fixture.byLeague[new URL(url).pathname.split('/').at(-2)]||{events:[]} : fixture});
}
require('../src/server');
