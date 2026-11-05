'use strict';
const {normalize}=require('./espn'),{rank}=require('../provider');
// Exact identities prevent ESPN from matching its unrelated sub-networks.
const aliases={
 espn:['ESPN','ESPN 1'],espn2:['ESPN2','ESPN 2'],espnu:['ESPNU','ESPN U','ESPNU COLLEGE SPORTS'],espnews:['ESPNews','ESPN NEWS'],
 abc:['ABC'],cbs:['CBS'],nbc:['NBC'],fox:['FOX'],fs1:['FS1','FOX SPORTS 1'],fs2:['FS2','FOX SPORTS 2'],
 tnt:['TNT','TNT EAST','TNT WEST'],tbs:['TBS','TBS EAST','TBS WEST'],trutv:['truTV','TRU TV','TRUTV EAST','TRUTV WEST','TRU TV EAST','TRU TV WEST'],
 nba:['NBA TV','NBATV'],nhl:['NHL NETWORK','NHLN'],mlb:['MLB NETWORK','MLBN'],nfl:['NFL NETWORK','NFLN'],
 btn:['BTN','BIG TEN NETWORK'],sec:['SEC NETWORK','SECN','ESPN SEC NETWORK'],acc:['ACC NETWORK','ACCN','ESPN ACC NETWORK'],
 cbssn:['CBSSN','CBS SPORTS NETWORK'],usa:['USA','USA NETWORK','USA NETWORK EAST','USA NETWORK WEST'],
 peacock:['Peacock'],prime:['Prime Video','Amazon Prime Video','Prime Video (Local)'],espnplus:['ESPN+','ESPN PLUS'],
 secplus:['SECN+','SEC NETWORK+'],accnx:['ACCNX','ACC NETWORK EXTRA'],
 marquee:['Marquee','MARQUEE SPORTS NETWORK'],chsn:['CHSN','CHICAGO SPORTS NETWORK'],
 msg:['MSG'],msgb:['MSGB','MSG BUFFALO'],msg2:['MSG2','MSG 2'],msgplus:['MSG+','MSG PLUS'],
 yes:['YES','YES NETWORK','DAZN (YES)'],nesn:['NESN','NESN BOSTON'],sny:['SNY','SPORTSNET NEW YORK'],
 mnmt:['MNMT','MONUMENTAL','MONUMENTAL SPORTS NETWORK'],
 spectrum:['Spectrum Sports Net','SPECTRUM SPORTSNET','SPECTRUM SPORTSNET LAKERS'],
 spectrumla:['SPECTRUM SPORTSNET LA','SPECTRUM SPORTSNET LA DODGERS'],
 spacecity:['SPACE CITY','SPACE CITY HOME NETWORK','SCHN','AT&T SPORTSNET SOUTHWEST','SPORTSNET SOUTHWEST'],
 root:['ROOT','ROOT SPORTS','ROOT SPORTS NORTHWEST'],altitude:['ALTITUDE','ALTITUDE SPORTS'],
 kjzz:['KJZZ','KJZZ-TV'],gcsen:['GCSEN','GULF COAST','GULF COAST SPORTS','GULF COAST SPORTS AND ENTERTAINMENT NETWORK'],
 tva:['TVA SPORTS','TVAS'],tva2:['TVA SPORTS 2','TVAS2']
};
for(const region of ['detroit','florida','sun','southeast','south','southwest','west','socal','midwest','north','ohio','great lakes','indiana','wisconsin','oklahoma','new orleans','san diego','arizona','kansas city'])
 aliases['fanduel '+region]=['fanduel sports network '+region,'fanduel sn '+region,'bally sports '+region,'bally '+region,'fsn '+region];
for(const region of ['bay area','boston','california','chicago','philadelphia','washington'])aliases['nbcs '+region]=['nbc sports '+region,'nbcs '+region,'nbcs'+region.replace(/ /g,''),'nbcsn '+region];
for(let i=1;i<=5;i++)aliases['tsn'+i]=['tsn'+i,'tsn '+i];
for(const region of ['east','west','ontario','pacific','one','360'])aliases['sn '+region]=['sportsnet '+region,'sn '+region,'sn'+region,'snet '+region];
for(const [id,names] of Object.entries({
 'sn east':['SNE','SNET E'],'sn west':['SNW','SNET W'],'sn ontario':['SNO','SNET O'],'sn pacific':['SNP','SNET P'],'sn one':['SN1'],'sn 360':['SN360'],
 'nbcs bay area':['NBCSBA'],'nbcs boston':['NBCSB','NBCS-BOS'],'nbcs california':['NBCSCA'],'nbcs chicago':['NBCSCH'],'nbcs philadelphia':['NBCSP'],'nbcs washington':['NBCSWA'],
 'fanduel detroit':['FDSN DET','FDSDET'],'fanduel florida':['FDSN FL','FDSFL'],'fanduel sun':['FDSSUN'],'fanduel north':['FDSN NORTH','FDSN NO','FDSNOR'],'fanduel south':['FDSSO'],'fanduel southeast':['FDSSE'],'fanduel ohio':['FDSOH'],'fanduel great lakes':['FDSGL'],'fanduel midwest':['FDSMW'],'fanduel indiana':['FDSIN'],'fanduel wisconsin':['FDSWI'],'fanduel oklahoma':['FDSOK'],'fanduel west':['FDSW'],'fanduel socal':['FDSSC']
}))aliases[id].push(...names);

const key=s=>normalize(String(s).replace(/\+/g,' plus '));
const lookup=new Map(Object.entries(aliases).flatMap(([id,names])=>names.map(n=>[key(n),id])));
function network(s){return lookup.get(key(s));}
function eligible(c,groups){return /^(?:US|CA)\s*-\s*/i.test(c.name||'')&&/^AM\s*\|\s*(?:USA|CA)\b/i.test(c.group||groups.get(String(c.cat))||'');}
function channelNetwork(c){
 if(String(c.id)==='1045049')return 'chsn';
 const name=String(c.name).replace(/^(?:US|CA)\s*-\s*/i,'').replace(/\b(?:FHD|UHD|HD|SD|[48]K|HEVC|H\.?265)\b/gi,'').replace(/[◉²³¹]/g,'').trim();
 const exact=network(name);if(exact)return exact;
 const affiliate=/^(ABC|CBS|NBC|FOX)\s+\d+\b/i.exec(name);return affiliate?affiliate[1].toLowerCase():undefined;
}
function broadcastIndex(channels,groups){
 const index=new Map();
 for(const c of channels){if(!eligible(c,groups))continue;const id=channelNetwork(c);if(!id)continue;const old=index.get(id);
 if(!old||rank(c.name)<rank(old.name)||rank(c.name)===rank(old.name)&&(c.name.length<old.name.length||c.name.length===old.name.length&&String(c.id).localeCompare(String(old.id))<0))index.set(id,c);
 }
 return index;
}
function broadcastChannels(names,channels,groups,index=broadcastIndex(channels,groups)){
 return [...new Set(names.map(network).filter(Boolean))].flatMap(id=>index.has(id)?[index.get(id)]:[]);
}
module.exports={network,channelNetwork,broadcastChannels,broadcastIndex,eligible,aliases};
