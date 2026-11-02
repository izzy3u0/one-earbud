'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createNowPlaying } = require('../music/now-playing');
const { createMusicAuthority } = require('../music/authority');
const { createApp } = require('../app');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { phone } = require('./helpers/phone-harness.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const song = id => ({ songId:String(id), title:'Test '+id, artist:'Artist', durationMs:600000, lyrics:[], coverUrl:'' });

test('ordered reports reject late playing/paused/old songs, duplicates, old owners and delayed clears', () => {
  const state=createNowPlaying(), a={sourceId:'phone-source-A',active:true}, b={sourceId:'phone-source-B',active:true};
  const lease=state.claim(a,1000);
  const report=(seq,extra={}) => state.report({...a,...lease,sequence:seq,...song('1'),playing:true,positionMs:30000,...extra},1000+seq);
  assert.equal(report(2),true); const revision=state.version().revision;
  assert.equal(report(1,{songId:'9',playing:false,positionMs:0}),false);
  assert.equal(report(2),false); assert.equal(state.version().revision,revision);
  assert.equal(state.current(1002).songId,'1');
  assert.equal(state.claim({sourceId:'phone-idle-page',active:false},1003),null);
  assert.equal(state.claim({sourceId:'phone-idle-page',active:false},999999),null,'passive page cannot take a background playing lease even after TTL');
  const next=state.claim(b,1010);
  assert.equal(state.report({...b,...next,sequence:1,...song('2'),playing:true},1011),true);
  assert.equal(report(900,{songId:'1'}),false);
  assert.equal(state.clear({...a,...lease,sequence:901},1012),false);
  assert.equal(state.clear(undefined,1012),false,'legacy tabs cannot clear a versioned owner');
  assert.equal(state.report({...song('9'),playing:false},1012),false,'legacy tabs cannot overwrite a versioned owner');
  assert.equal(state.current(1012).songId,'2');
  assert.equal(state.clear({...b,...next,sequence:2},1013),true);
  assert.equal(state.report({...b,...next,sequence:3,...song('2'),playing:true},1014),false,'close is a tombstone');
});

test('song switches during lyric and cover fetches return the latest state instead of a false disconnect', async t => {
  let resolveLyrics;
  const lyrics=new Promise(resolve=>{resolveLyrics=resolve;});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-switch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{cookie:()=> 'TEST_ONLY_COOKIE'},client:{lyrics:async(c,id)=>id==='1'?lyrics:{lines:[]}}});
  authority.reportNowPlaying({...song('1'),playing:true});
  const pending=authority.nowPlayingDetails();
  authority.reportNowPlaying({...song('2'),playing:true});resolveLyrics({lines:[{index:0,timeMs:0,text:'OLD lyric'}]});
  const latest=await pending;assert.equal(latest.songId,'2');assert.equal(latest.state,'playing');assert.equal(latest.lyricContext.current,null);
  const {createPlayerView}=require('../music/player-view');let current='1';
  const view=createPlayerView({authority:{queue:{get:()=>({items:[],mode:'seq'})},song:async()=>{current='2';return {coverUrl:'https://p1.music.126.net/old.jpg'};}},tool:{handler:async()=>({...song(current),listening:true,fresh:true,state:'playing',positionMs:10000,streamId:'test',revision:Number(current)})}});
  const card=await view();assert.equal(card.current.songId,'2');assert.equal(card.current.coverUrl,'');assert.equal(card.fresh,true);assert.equal(card.revision,2);
});

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-state-')); let now=Date.now();
  const authority=createMusicAuthority({now:()=>now,queueFile:path.join(dir,'queue.json'),store:{cookie:()=> 'TEST_ONLY_COOKIE',refreshCookie(){}},client:{songDetail:async(c,id)=>song(id),lyrics:async()=>({lines:[]}),playUrl:async(c,id)=>({url:'https://audio.example.test/'+id})}});
  const {app}=createApp({authority,token:'TEST_WEB',mcpToken:'TEST_MCP',publicUrl:''});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  const client=new Client({name:'state-consistency-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer TEST_MCP'}}}));
  const calls=[];
  async function api(route,opts={}) {
    calls.push({route,method:opts.method||'GET',body:opts.body&&structuredClone(opts.body)});
    const response=await fetch(base+route,{method:opts.method||'GET',headers:{Authorization:'Bearer TEST_WEB',...(opts.body?{'Content-Type':'application/json'}:{})},body:opts.body?JSON.stringify(opts.body):undefined});
    const body=await response.json(); if(!response.ok)throw new Error('test API status '+response.status); return body;
  }
  const phones=[];
  const addPhone=(restored,request=api)=>{const p=phone({api:request,now:()=>now,restored});phones.push(p);return p;};
  const read=async name=>(await client.callTool({name:'music_'+name,arguments:{}})).structuredContent;
  const settle=()=>wait(60);
  t.after(async()=>{phones.forEach(p=>p.hide());await wait(20);await client.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  return {authority,api,calls,addPhone,read,settle,tick(ms){now+=ms;},now:()=>now};
}

test('actual PWA events, restored second page, buffering, visibility and repeated lifecycle do not oscillate state', async t => {
  const f=await fixture(t), active=f.addPhone();
  await active.player.play(song('1'));await f.settle();
  active.audio().currentTime=120;active.audio().fire('seeked');await f.settle();
  const idle=f.addPhone({song:song('9'),queueItemId:null});idle.start();await f.settle();
  for(let i=0;i<12;i++){
    idle.visibility(true);idle.visibility(false);idle.timers(20000);
    active.audio().fire('waiting');active.visibility(true);active.visibility(false);active.audio().fire('playing');
    f.tick(1000);active.audio().currentTime+=1;active.audio().fire('timeupdate');active.timers(20000);await f.settle();
    const now=await f.read('now_playing'),card=await f.read('player_state');
    assert.equal(now.songId,'1');assert.equal(now.state,'playing');assert.equal(card.current.songId,now.songId);assert.equal(card.state,now.state);assert.equal(card.revision,now.revision);assert.ok(card.positionMs>=120000);
  }
  assert.equal([...active.intervals.values()].filter(x=>x.ms===20000).length,1,'event bursts do not multiply heartbeats');
  active.player.toggle();await f.settle();assert.equal((await f.read('player_state')).state,'paused');
  active.player.toggle();await f.settle();assert.equal((await f.read('now_playing')).state,'playing');
  for(let i=0;i<5;i++){active.hide();assert.equal(active.intervals.size,0);active.show();active.show();await f.settle();assert.equal([...active.intervals.values()].filter(x=>x.ms===20000).length,1);}
  active.player.close();await f.settle();assert.equal([...active.intervals.values()].filter(x=>x.ms===20000).length,0);assert.equal((await f.read('now_playing')).listening,false);
});

test('rapid song changes discard stale media events', async t => {
  const f=await fixture(t), p=f.addPhone();
  for(let i=1;i<=30;i++){
    await p.player.play(song(i));p.audio().currentTime=20+i;p.audio().fire('seeked');
    p.audio().fire('pause'); // queued old pause event, while current audio is still playing
    await f.settle();
    const a=await f.read('now_playing'),b=await f.read('player_state');
    assert.equal(a.songId,String(i));assert.equal(a.state,'playing');assert.equal(b.current.songId,a.songId);assert.ok(b.positionMs>=20000);
  }
});

test('late failed song loads and old queue completions cannot clear the newer audio or queue item', async t => {
  const f=await fixture(t);let rejectOld;
  const p=f.addPhone(null,(route,opts)=>route.endsWith('/song/1/url') ? new Promise((resolve,reject)=>{rejectOld=reject;}) : f.api(route,opts));
  await f.api('/api/music/queue/append',{method:'POST',body:{songs:[song('1'),song('2')]}});
  await p.player.refreshQueue();
  const [first,second]=p.player.getQueue().items;
  const old=p.player.playQueueItem(first.id);
  await p.player.playQueueItem(second.id);await f.settle();
  rejectOld(new Error('late old network failure'));await old;await f.settle();
  assert.equal(p.audio().src,'https://audio.example.test/2');assert.equal(p.audio().paused,false);
  assert.equal(p.player.getState().queueItemId,second.id);
  assert.equal((await f.read('now_playing')).songId,'2');
});

test('MCP sustained state consistency with concurrent sources and adversarial delayed writes', async t => {
  const f=await fixture(t);
  const a=await f.api('/api/music/now-playing/session',{method:'POST',body:{sourceId:'sustained-active-phone',active:true}});
  const session={sourceId:'sustained-active-phone',sessionId:a.sessionId};
  let sequence=0, previous=null, samples=0, rejected=0;
  // Virtual 30 minutes; actual HTTP + official MCP SDK for every observation.
  for(let tick=0;tick<900;tick++){
    const songId=String(1+Math.floor(tick/15)),playing=tick%15!==12;
    const body={...session,sequence:++sequence,...song(songId),positionMs:(tick%15)*2000,playing};
    await f.api('/api/music/now-playing',{method:'POST',body});
    if(previous){const late=await f.api('/api/music/now-playing',{method:'POST',body:previous});assert.equal(late.accepted,false);rejected++;}
    const observer=await f.api('/api/music/now-playing/session',{method:'POST',body:{sourceId:'sustained-passive-tab',active:false}});assert.equal(observer.accepted,false);
    const [state,card]=await Promise.all([f.read('now_playing'),f.read('player_state')]);
    assert.equal(state.songId,songId);assert.equal(state.state,playing?'playing':'paused');assert.equal(card.current.songId,songId);assert.equal(card.state,state.state);assert.equal(card.revision,state.revision);assert.ok(card.positionMs>=body.positionMs);samples++;
    previous=body;f.tick(2000);
  }
  t.diagnostic(JSON.stringify({virtualMinutes:30,samples,rejectedLateReports:rejected,oscillations:0}));
});

test('wall-clock sustained actual PWA and MCP observation', {skip:!process.env.ONE_EARBUD_STABILITY_MS}, async t => {
  const f=await fixture(t),p=f.addPhone(), started=Date.now();let samples=0,track=0;
  const duration=Number(process.env.ONE_EARBUD_STABILITY_MS);
  while(Date.now()-started<duration){
    const elapsed=Date.now()-started,next=1+Math.floor(elapsed/10000);f.tick(1000);
    if(next!==track){track=next;await p.player.play(song(track));}
    p.audio().currentTime=(elapsed%10000)/1000+30;p.audio().fire('seeked');p.audio().fire('waiting');p.audio().fire('playing');
    p.visibility(true);p.visibility(false);p.timers(20000);await f.settle();
    const [a,b]=await Promise.all([f.read('now_playing'),f.read('player_state')]);assert.equal(a.songId,String(track));assert.equal(b.current.songId,a.songId);assert.equal(a.state,'playing');assert.equal(b.state,'playing');assert.equal(a.revision,b.revision);samples++;
    await wait(1000);
  }
  t.diagnostic(JSON.stringify({wallSeconds:Math.round((Date.now()-started)/1000),samples,tracks:track,oscillations:0}));
});
