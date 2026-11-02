'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {createNowPlaying,HANDOFF_TIMEOUT_MS}=require('../music/now-playing');
const {createMusicAuthority}=require('../music/authority');
const {createApp}=require('../app');
const {createWidgetPlayback,mediaUrl}=require('../music/widget-playback');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {phone}=require('./helpers/phone-harness.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const song=id=>({songId:String(id),title:'Song '+id,artist:'Artist',durationMs:180000,coverUrl:''});
function switchRequest(state,target,sourceId,id){const p=state.playback();return {target,sourceId,requestId:id,expectedEpoch:p.epoch,expectedStreamId:p.streamId};}

test('two-phase playback ownership fences old reports, claims, clears and switch retries in both directions',()=>{
  const state=createNowPlaying(),p={sourceId:'phone-original-A'},w={sourceId:'widget-source-A'};
  const lease=state.claim({...p,active:true},1000);
  state.report({...p,...lease,sequence:1,...song(1),playing:true,positionMs:42000},1000);
  const first=switchRequest(state,'chatgpt',w.sourceId,'switch-request-A');
  assert.equal(state.switchPlayback(first,2000).ok,true);assert.equal(state.playback().mode,'pwa');
  assert.equal(state.claim({...w,active:true,playbackMode:'chatgpt',modeEpoch:0},2000),null,'new endpoint cannot play before acknowledgement');
  assert.equal(state.acknowledgeHandoff({...w,sessionId:'wrong',sequence:2,handoffId:state.playback().handoff.id},2001),false);
  assert.equal(state.acknowledgeHandoff({...p,...lease,sequence:2,handoffId:state.playback().handoff.id,positionMs:43500},2002),true);
  assert.equal(state.playback().resume.playing,true);assert.equal(state.playback().resume.positionMs,43500);
  assert.equal(state.report({...p,...lease,sequence:999,...song(9),playing:true},2003),false);
  assert.equal(state.clear({...p,...lease,sequence:1000},2003),false);
  assert.equal(state.claim({...p,active:true,modeEpoch:0},2003),null);
  const widget=state.claim({...w,active:true,playbackMode:'chatgpt',modeEpoch:1},2004);
  assert.ok(widget);assert.equal(state.report({...w,...widget,sequence:1,...song(1),positionMs:44000,playing:true},2005),true);
  const back=switchRequest(state,'pwa',w.sourceId,'switch-request-back');state.switchPlayback(back,3000);
  assert.equal(state.acknowledgeHandoff({...w,...widget,sequence:2,handoffId:state.playback().handoff.id,positionMs:62000},3001),true);
  assert.equal(state.playback().mode,'pwa');assert.equal(state.playback().epoch,2);
  assert.equal(state.claim({...p,active:true,modeEpoch:0},3002),null,'old active claims cannot steal a new epoch');
  const renewed=state.claim({...p,active:true,modeEpoch:2},3002);assert.ok(renewed);
  assert.equal(state.report({...w,...widget,sequence:999,...song(9),playing:true},3003),false);
  state.switchPlayback(first,3004);assert.equal(state.playback().mode,'pwa','late duplicate switch does not switch back');
  assert.equal(state.switchPlayback({...first,target:'pwa'},3005).error,'REQUEST_ID_CONFLICT');
});

test('pending handoffs can be cancelled before the deadline; closed-card recovery preserves position',()=>{
  const s=createNowPlaying(),p={sourceId:'phone-original-A'},lease=s.claim({...p,active:true},1000);
  s.report({...p,...lease,sequence:1,...song(1),playing:true,positionMs:40000},1000);
  s.switchPlayback(switchRequest(s,'chatgpt','widget-source-A','switch-first-req'),100000);
  assert.equal(s.playback().mode,'pwa');assert.ok(s.playback().handoff,'stale heartbeat does not prove audio stopped');
  s.switchPlayback(switchRequest(s,'pwa','widget-source-A','cancel-first-req'),100001);assert.equal(s.playback().handoff,null);
  s.release({...p,...lease,sequence:2,positionMs:41000},100002);
  s.switchPlayback(switchRequest(s,'chatgpt','widget-source-A','switch-second-req'),100003);
  const w=s.claim({sourceId:'widget-source-A',active:true,playbackMode:'chatgpt',modeEpoch:1},100004);
  s.report({sourceId:'widget-source-A',...w,sequence:1,...song(1),playing:true,positionMs:65000},100005);
  s.release({sourceId:'widget-source-A',...w,sequence:2,positionMs:68000},100006);
  s.switchPlayback(switchRequest(s,'chatgpt','widget-source-B','reopen-card-req'),100007);
  assert.equal(s.playback().sourceId,'widget-source-B');assert.equal(s.playback().resume.positionMs,68000);assert.equal(s.playback().resume.playing,false);
});

test('final stopped snapshot wins when a song changes during the handoff; repeated alternating owners never accept old epochs',()=>{
  const s=createNowPlaying();let mode='pwa',source='phone-sequence-A',lease=s.claim({sourceId:source,active:true},1000),sequence=0;
  for(let i=0;i<100;i++){
    const at=1000+i*1000;
    s.report({...lease,sourceId:source,sequence:++sequence,...song(i+1),playing:i%3!==0,positionMs:50000},at);
    const target=mode==='pwa'?'chatgpt':'pwa',nextSource=target==='pwa'?'phone-sequence-A':'widget-sequence-A';
    s.switchPlayback(switchRequest(s,target,'widget-sequence-A','alternating-switch-'+i),at+1);
    const old={...lease,sourceId:source,sequence:sequence+999,...song(999),playing:true,positionMs:0};
    assert.equal(s.acknowledgeHandoff({...lease,sourceId:source,sequence:++sequence,handoffId:s.playback().handoff.id,...song(i+2),playing:true,positionMs:51000},at+2),true);
    assert.equal(s.playback().resume.songId,String(i+2));assert.equal(s.current(at+2).songId,String(i+2));
    assert.equal(s.report(old,at+3),false);assert.equal(s.claim({...old,active:true,modeEpoch:i},at+3),null);
    lease=s.claim({sourceId:nextSource,active:true,playbackMode:target,modeEpoch:i+1},at+4);assert.ok(lease);
    mode=target;source=nextSource;sequence=0;
  }
});

async function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-v2-'));let now=Date.now();
  const authority=createMusicAuthority({now:()=>now,queueFile:path.join(dir,'queue.json'),store:{cookie:()=> 'TEST_PRIVATE_COOKIE',refreshCookie(){}},client:{songDetail:async(c,id)=>song(id),lyrics:async()=>({lines:[{index:0,timeMs:0,text:'Test lyric'}]}),playUrl:async(c,id)=>({url:'https://m701.music.126.net/test/'+id+'.mp3'})}});
  const {app}=createApp({authority,token:'TEST_WEB_TOKEN',mcpToken:'TEST_MCP_TOKEN',publicUrl:'https://music.example.test',dataDir:dir});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
  const client=new Client({name:'v2-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer TEST_MCP_TOKEN'}}}));
  const calls=[];const api=async(route,opts={})=>{calls.push({route,body:opts.body&&structuredClone(opts.body)});const r=await fetch(base+route,{method:opts.method||'GET',headers:{Authorization:'Bearer TEST_WEB_TOKEN','Content-Type':'application/json'},body:opts.body?JSON.stringify(opts.body):undefined});assert.equal(r.status,200);return r.json();};
  const p=phone({api:options.phoneApi?(route,opts)=>options.phoneApi(route,opts,api):api,now:()=>now});
  const widget=args=>client.callTool({name:'music_widget_playback',arguments:{sourceId:'widget-sdk-source',...args}});
  const read=async name=>(await client.callTool({name:'music_'+name,arguments:{}})).structuredContent;
  t.after(async()=>{p.hide();await wait(30);await client.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  return {authority,api,calls,p,widget,read,client,base,tick(ms){now+=ms;}};
}

test('suspended iPhone PWA cannot ACK: bounded takeover preserves an unqueued song past freshness and fences every late old write',async t=>{
  const f=await fixture(t);await f.p.player.preview(song(1));
  f.p.audio().currentTime=42;f.p.audio().fire('seeked');await wait(60);
  const old=f.calls.filter(x=>x.route==='/api/music/now-playing'&&x.body?.sessionId).at(-1).body;
  f.p.hide();assert.equal(f.p.intervals.size,0);assert.equal(f.p.audio().paused,false,'background PWA playback is preserved in V1');
  f.tick(59000);
  const owner=f.authority.playbackOwner();
  const switched=await f.widget({op:'switch',target:'chatgpt',requestId:'suspended-phone-switch',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  const pending=switched.structuredContent.playback.handoff,saved=pending.snapshot;
  assert.equal(pending.deadlineAt-pending.requestedAt,HANDOFF_TIMEOUT_MS);assert.equal(saved.songId,'1');assert.ok(saved.positionMs>=101000);
  f.tick(2000);const during=await f.read('player_state');
  assert.equal(during.fresh,false,'preserved preparation is not a fresh phone heartbeat');assert.equal(during.current,null);assert.equal(during.prepared.songId,'1');assert.equal(during.positionMs,saved.positionMs);assert.equal(during.queue.count,0);
  f.tick(HANDOFF_TIMEOUT_MS-2000);
  // No process timer or phone request is needed: the next MCP read settles it.
  const ready=await f.read('open_player'),selected=ready.playback;
  assert.equal(selected.mode,'chatgpt');assert.equal(selected.epoch,1);assert.equal(selected.handoff,null);assert.equal(selected.ownerSourceId,null);
  assert.equal(selected.resume.reason,'timeout');assert.equal(selected.resume.requestedPlaying,true);assert.equal(selected.resume.playing,false);assert.equal(ready.positionMs,saved.positionMs);
  const claim=await f.widget({op:'claim',requestId:'suspended-phone-claim',expectedEpoch:selected.epoch,expectedStreamId:selected.streamId});
  assert.equal(claim._meta.audio.song.songId,'1');assert.equal(claim._meta.audio.positionMs,saved.positionMs);assert.equal(claim._meta.audio.playing,false,'timeout must never autoplay over potentially suspended audio');
  const before=f.authority.nowPlayingVersion().revision;
  assert.equal((await f.api('/api/music/now-playing',{method:'POST',body:{...old,sequence:99999}})).accepted,false);
  assert.equal((await f.api('/api/music/playback-handoff',{method:'POST',body:{...old,sequence:999999,handoffId:pending.id,positionMs:0}})).accepted,false);
  assert.equal((await f.api('/api/music/now-playing/session',{method:'POST',body:{sourceId:old.sourceId,active:true,modeEpoch:0}})).accepted,false);
  assert.equal(f.authority.nowPlayingVersion().revision,before);
  f.p.show();await f.p.player.syncPlayback();await wait(60);assert.equal(f.p.audio().paused,true,'resumed old PWA stops when it learns ownership changed');
  const audio=claim._meta.audio;
  assert.equal((await f.widget({op:'report',...claim._meta.lease,sequence:1,trackId:audio.trackId,songId:'1',positionMs:audio.positionMs+1000,playing:true})).structuredContent.accepted,true);
  const [state,card]=await Promise.all([f.read('now_playing'),f.read('player_state')]);assert.equal(state.state,'playing');assert.equal(state.playbackMode,'chatgpt');assert.equal(card.current.songId,state.songId);assert.equal(card.revision,state.revision);
});

test('deadline is enforced by a late report/ACK/claim even without polling; pending newest track wins',()=>{
  for(const action of ['report','ack','claim','clear','release']){
    const s=createNowPlaying(),p={sourceId:'phone-deadline-A'},lease=s.claim({...p,active:true},1000);
    s.report({...p,...lease,sequence:1,...song(1),positionMs:42000,playing:true},1000);
    s.switchPlayback(switchRequest(s,'chatgpt','widget-deadline-A','deadline-switch-'+action),2000);
    const handoffId=s.playback().handoff.id;
    s.report({...p,...lease,sequence:2,...song(2),positionMs:5000,playing:true},3000);
    const body={...p,...lease,sequence:999,...song(9),positionMs:0,playing:false,handoffId,active:true,modeEpoch:0};
    const result=action==='ack'?s.acknowledgeHandoff(body,14000):s[action](body,14000);
    assert.ok(!result);assert.equal(s.playback().mode,'chatgpt');assert.equal(s.playback().resume.songId,'2');assert.equal(s.playback().resume.positionMs,5000);assert.equal(s.current(14000).state,'paused');
    s.playback(99999);assert.equal(s.playback().epoch,1,'timeout is exactly once');
  }
});

test('PWA ACK bypasses a hung heartbeat; late rejection cannot pause the renewed PWA lease',async t=>{
  let held=false,release;
  const f=await fixture(t,{phoneApi(route,opts,api){if(held&&route==='/api/music/now-playing'&&opts?.method==='POST'){held=false;return new Promise(resolve=>{release=()=>api(route,opts).then(resolve);});}return api(route,opts);}});
  await f.p.player.playSingle(song(1));f.p.audio().currentTime=42;f.p.audio().fire('seeked');await wait(60);
  held=true;f.p.timers(20000);await wait(20);assert.equal(typeof release,'function');
  const owner=f.authority.playbackOwner();await f.widget({op:'switch',target:'chatgpt',requestId:'hung-heartbeat-switch',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  const sync=f.p.player.syncPlayback();assert.equal(await Promise.race([sync.then(()=>true),wait(500).then(()=>false)]),true,'physical pause ACK must not wait for old fetch');
  assert.equal(f.p.audio().paused,true);assert.equal(f.authority.playbackOwner().resume.playing,true);
  const selected=f.authority.playbackOwner(),ready=await f.widget({op:'claim',requestId:'hung-heartbeat-claim',expectedEpoch:selected.epoch,expectedStreamId:selected.streamId});
  await f.widget({op:'report',...ready._meta.lease,sequence:1,trackId:ready._meta.audio.trackId,songId:'1',positionMs:43000,playing:true});
  await f.widget({op:'switch',target:'pwa',requestId:'hung-heartbeat-return',expectedEpoch:selected.epoch,expectedStreamId:selected.streamId,...ready._meta.lease,sequence:2,positionMs:43000});
  await f.p.player.syncPlayback();await wait(40);assert.equal(f.p.audio().paused,false);
  release();await wait(60);assert.equal(f.p.audio().paused,false,'late old-session rejection must not stop current session');
});

test('failed PWA ACK releases busy flag and retries the original physical-stop snapshot',async t=>{
  let fail=true;
  const f=await fixture(t,{phoneApi(route,opts,api){if(route==='/api/music/playback-handoff'&&fail){fail=false;return Promise.reject(new Error('simulated offline'));}return api(route,opts);}});
  await f.p.player.playSingle(song(1));f.p.audio().currentTime=42;f.p.audio().fire('seeked');await wait(60);
  const owner=f.authority.playbackOwner();await f.widget({op:'switch',target:'chatgpt',requestId:'failed-ACK-switch',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  await f.p.player.syncPlayback();assert.equal(f.p.audio().paused,true);assert.ok(f.authority.playbackOwner().handoff);
  await f.p.player.syncPlayback();assert.equal(f.authority.playbackOwner().handoff,null);assert.equal(f.authority.playbackOwner().resume.positionMs,42000);assert.equal(f.authority.playbackOwner().resume.playing,true,'retry retains pre-pause intent');
});

test('wall-clock repeated suspended-phone handoffs stay bounded and restore PWA without old-state takeover',{skip:!process.env.ONE_EARBUD_HANDOFF_STABILITY_MS},async t=>{
  const f=await fixture(t),started=Date.now(),duration=Number(process.env.ONE_EARBUD_HANDOFF_STABILITY_MS);let cycles=0,samples=0;
  await f.p.player.playSingle(song(1));await wait(60);
  while(Date.now()-started<duration){
    f.p.audio().currentTime=42;f.p.audio().fire('seeked');await wait(40);
    const old=f.calls.filter(x=>x.route==='/api/music/now-playing'&&x.body?.sessionId).at(-1).body;
    f.p.hide();const owner=f.authority.playbackOwner();
    await f.widget({op:'switch',target:'chatgpt',requestId:'wall-suspended-switch-'+cycles,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
    const switching=Date.now();let card;
    do {
      await wait(1000);f.tick(1000);card=await f.read('player_state');samples++;
      assert.equal((card.current||card.prepared).songId,'1');assert.ok(card.positionMs>=42000);
      if(card.playback.handoff)assert.equal(card.playback.epoch,owner.epoch);
      assert.ok(Date.now()-switching<20000,'handoff must not hang');
    }while(card.playback.handoff);
    assert.ok(Date.now()-switching>=HANDOFF_TIMEOUT_MS-500);assert.equal(card.playback.resume.reason,'timeout');
    assert.equal(card.playback.epoch,owner.epoch+1);assert.equal(card.playback.resume.playing,false);
    const ready=await f.widget({op:'claim',requestId:'wall-suspended-claim-'+cycles,expectedEpoch:card.playback.epoch,expectedStreamId:owner.streamId});
    await f.widget({op:'report',...ready._meta.lease,sequence:1,trackId:ready._meta.audio.trackId,songId:'1',positionMs:45000,playing:true});
    assert.equal((await f.api('/api/music/now-playing',{method:'POST',body:{...old,sequence:99999}})).accepted,false);
    f.p.show();await f.p.player.syncPlayback();assert.equal(f.p.audio().paused,true);
    const state=await f.read('now_playing');assert.equal(state.playbackMode,'chatgpt');assert.equal(state.state,'playing');
    await f.widget({op:'switch',target:'pwa',requestId:'wall-suspended-return-'+cycles,expectedEpoch:card.playback.epoch,expectedStreamId:owner.streamId,...ready._meta.lease,sequence:2,positionMs:45000});
    await f.p.player.syncPlayback();await wait(40);assert.equal(f.p.audio().paused,false);assert.equal(f.p.audio().currentTime,45);
    const back=await f.read('now_playing');assert.equal(back.playbackMode,'pwa');assert.equal(back.state,'playing');cycles++;
  }
  t.diagnostic(JSON.stringify({wallSeconds:Math.round((Date.now()-started)/1000),cycles,samples,stuckHandoffs:0,stateTakeovers:0}));
});

test('real SDK and actual PWA script hand over and back without overlap, position reset or old heartbeat takeover',async t=>{
  const f=await fixture(t);
  await f.api('/api/music/queue/append',{method:'POST',body:{songs:[song(1),song(2)]}});await f.p.player.refreshQueue();
  await f.p.player.playQueueItem(f.p.player.getQueue().items[0].id);f.p.audio().currentTime=42;f.p.audio().fire('seeked');await wait(80);
  const old=f.calls.filter(x=>x.route==='/api/music/now-playing'&&x.body?.sessionId).at(-1).body;
  f.authority.requestPlayback(f.authority.queue.get().currentId); // held V1 play_now was already played; must not reset the handoff to 0.
  const owner=f.authority.playbackOwner();await f.widget({op:'switch',target:'chatgpt',requestId:'SDK-switch-to-widget',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  assert.equal(f.p.audio().paused,false,'old endpoint stays active until it receives handoff');
  await f.p.player.syncPlayback();assert.equal(f.p.audio().paused,true);assert.equal(f.authority.playbackOwner().mode,'chatgpt');
  const selected=f.authority.playbackOwner();
  const prepared=await f.widget({op:'claim',requestId:'SDK-claim-widget-first',expectedEpoch:selected.epoch,expectedStreamId:selected.streamId}),lease=prepared._meta.lease,audio=prepared._meta.audio;
  assert.ok(audio);assert.equal(audio.positionMs,42000);assert.equal(audio.playing,true);assert.match(audio.url,/^https:\/\/music\.example\.test\/widget-media\//);
  assert.doesNotMatch(JSON.stringify(prepared),/TEST_PRIVATE_COOKIE|TEST_WEB_TOKEN|TEST_MCP_TOKEN|"cookie"/);
  const report=(sequence,extra={})=>f.widget({op:'report',...lease,sequence,trackId:audio.trackId,songId:'1',positionMs:43000,playing:true,...extra});
  assert.equal((await report(1)).structuredContent.accepted,true);assert.equal((await f.read('now_playing')).playbackMode,'chatgpt');
  assert.equal((await f.api('/api/music/now-playing',{method:'POST',body:{...old,sequence:999999}})).accepted,false);
  f.p.timers(20000);f.p.player.toggle();assert.equal(f.p.audio().paused,true);
  f.tick(1000);
  const remote=await f.client.callTool({name:'music_play_now',arguments:{songId:'3',requestId:'SDK-remote-play-now'}});assert.equal(remote.structuredContent.playback.status,'pending');
  assert.equal((await f.api('/api/music/playback-sync')).command,null,'even old PWA clients must not receive ChatGPT mode play commands');
  const commanded=await f.widget({op:'poll',...lease});assert.equal(commanded._meta.audio.song.songId,'3');
  await f.widget({op:'report',...lease,sequence:2,trackId:commanded._meta.audio.trackId,songId:'3',positionMs:10000,playing:true});
  const advanced=await f.widget({op:'track',...lease,trackId:commanded._meta.audio.trackId,direction:'next',playing:true,requestId:'SDK-next-track-request'});
  assert.equal(advanced._meta.audio.song.songId,'2');assert.equal((await report(2)).structuredContent.accepted,false,'old track report cannot overwrite new track');
  const current=advanced._meta.audio;
  await f.widget({op:'report',...lease,sequence:3,trackId:current.trackId,songId:'2',positionMs:62000,playing:true});
  const back=f.authority.playbackOwner();
  await f.widget({op:'switch',target:'pwa',requestId:'SDK-switch-back-phone',expectedEpoch:back.epoch,expectedStreamId:back.streamId,...lease,sequence:4,positionMs:62000});
  assert.equal(f.p.audio().paused,true,'PWA must wait for its own sync before starting');
  await f.p.player.syncPlayback();await wait(80);
  assert.equal(f.p.audio().paused,false);assert.equal(f.p.player.getState().song.songId,'2');assert.equal(f.p.audio().currentTime,62);
  const state=await f.read('now_playing'),card=await f.read('player_state');assert.equal(state.playbackMode,'pwa');assert.equal(state.state,'playing');assert.equal(state.songId,'2');assert.equal(card.revision,state.revision);assert.ok(state.positionMs>=62000);
  assert.equal((await report(9999)).structuredContent.accepted,false);
});

test('unplayable media still returns the owning lease so the user can safely fall back to PWA',async t=>{
  const f=await fixture(t),original=f.authority.playUrl;f.authority.playUrl=async()=>({url:'https://evil.example.test/not-allowed'});
  f.authority.queue.append({by:'you',song:song(1)});let owner=f.authority.playbackOwner();
  await f.widget({op:'switch',target:'chatgpt',requestId:'failure-switch-widget',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});owner=f.authority.playbackOwner();
  const result=await f.widget({op:'claim',requestId:'failure-claim-widget',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  assert.equal(result.structuredContent.ok,true);assert.match(result.structuredContent.audioError,/PWA/);assert.ok(result._meta.lease);assert.equal(result._meta.audio,undefined);
  await f.widget({op:'switch',target:'pwa',requestId:'failure-switch-back',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,...result._meta.lease,sequence:1});
  assert.equal(f.authority.playbackOwner().mode,'pwa');assert.equal(f.authority.playbackOwner().handoff,null);f.authority.playUrl=original;
});

test('real MCP resumes the same logical card without handoff; live originals stay audible and retired mounts cannot reclaim',async t=>{
  const f=await fixture(t),sourceId='widget-stable-card',instanceId='mount-original-A';
  f.authority.queue.append({by:'you',songs:[song(1),song(2)]});let owner=f.authority.playbackOwner();
  const call=args=>f.widget({sourceId,...args});
  await call({op:'switch',target:'chatgpt',instanceId,requestId:'stable-first-switch',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});owner=f.authority.playbackOwner();
  const initial=await call({op:'claim',instanceId,requestId:'stable-first-claim',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  await call({op:'report',instanceId,...initial._meta.lease,sequence:1,trackId:initial._meta.audio.trackId,songId:'1',positionMs:42000,playing:true,playbackIntent:true});
  const version=f.authority.nowPlayingVersion();
  for(let i=0;i<12;i++){
    const restored=await call({op:'resume',instanceId:'mount-restored-'+i,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,playing:true});
    assert.equal(restored.structuredContent.attachment,'observer');assert.equal(restored._meta?.lease,undefined);assert.equal(restored._meta?.audio,undefined);
    assert.equal(restored.structuredContent.playback.handoff,null);assert.equal(restored.structuredContent.playback.epoch,owner.epoch);assert.equal(f.authority.nowPlayingVersion().revision,version.revision);
    assert.equal((await f.read('now_playing')).state,'playing');
  }
  const next=await call({op:'track',instanceId,...initial._meta.lease,trackId:initial._meta.audio.trackId,direction:'next',playing:true,requestId:'stable-next-track'});
  await call({op:'report',instanceId,...initial._meta.lease,sequence:2,trackId:next._meta.audio.trackId,songId:'2',positionMs:72000,playing:true,playbackIntent:true});
  await call({op:'release',instanceId,...initial._meta.lease,sequence:3,positionMs:72000,playbackIntent:true});
  const replacements=await Promise.all(['mount-new-owner-A','mount-new-owner-B'].map(instanceId=>call({op:'resume',instanceId,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,playing:true})));
  assert.equal(replacements.filter(x=>x._meta?.lease).length,1,'concurrent mounts never create two audio owners');
  const ready=replacements.find(x=>x._meta?.lease),newInstance='mount-new-owner-A';
  assert.equal(ready._meta.audio.song.songId,'2');assert.equal(ready._meta.audio.positionMs,72000);assert.equal(ready._meta.audio.playing,true);assert.equal(ready.structuredContent.playback.epoch,owner.epoch);assert.equal(ready.structuredContent.playback.handoff,null);
  assert.equal((await call({op:'report',instanceId:newInstance,...ready._meta.lease,sequence:1,trackId:ready._meta.audio.trackId,songId:'2',positionMs:73000,playing:true,playbackIntent:true})).structuredContent.accepted,true);
  const before=f.authority.nowPlayingVersion().revision;
  for(const op of ['report','release','resume','switch']){
    const rejected=await call({op,instanceId,...initial._meta.lease,sequence:999999,trackId:initial._meta.audio.trackId,songId:'1',positionMs:0,playing:false,target:'pwa',requestId:'retired-switch-request',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
    assert.equal(rejected.structuredContent.attachmentLost,true);assert.equal(f.authority.nowPlayingVersion().revision,before);
  }
  assert.equal((await call({op:'resume',sourceId:'widget-different-card',instanceId:'mount-unrelated-A',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,playing:true}))._meta?.lease,undefined);
  await call({op:'report',instanceId:newInstance,...ready._meta.lease,sequence:2,trackId:ready._meta.audio.trackId,songId:'2',positionMs:74000,playing:false,playbackIntent:false});
  await call({op:'release',instanceId:newInstance,...ready._meta.lease,sequence:3,positionMs:74000,playbackIntent:false});
  const paused=await call({op:'resume',instanceId:'mount-user-paused-A',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,playing:true});
  assert.equal(paused._meta.audio.playing,false,'an old UI checkpoint cannot undo an explicit pause');
});

test('wall-clock remounted views observe and resume one ChatGPT session without handoffs',{skip:!process.env.ONE_EARBUD_RESUME_STABILITY_MS},async t=>{
  const f=await fixture(t),started=Date.now(),duration=Number(process.env.ONE_EARBUD_RESUME_STABILITY_MS),sourceId='widget-wall-stable';let instanceId='mount-wall-original',sequence=0,samples=0,restores=0;
  f.authority.queue.append({by:'you',song:song(1)});let owner=f.authority.playbackOwner();
  const call=args=>f.widget({sourceId,...args});await call({op:'switch',target:'chatgpt',instanceId,requestId:'wall-stable-switch',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});owner=f.authority.playbackOwner();
  let active=await call({op:'claim',instanceId,requestId:'wall-stable-claim',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  while(Date.now()-started<duration){
    f.tick(1000);const positionMs=42000+samples*1000;
    await call({op:'report',instanceId,...active._meta.lease,sequence:++sequence,trackId:active._meta.audio.trackId,songId:'1',positionMs,playing:true,playbackIntent:true});
    const mount='mount-wall-restored-'+samples,resume={op:'resume',instanceId:mount,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,playing:true};
    const observed=await call(resume);assert.equal(observed.structuredContent.attachment,'observer');assert.equal(observed._meta?.audio,undefined);
    if(samples%10===9){
      const old={instanceId,...active._meta.lease,trackId:active._meta.audio.trackId};
      await call({op:'release',...old,sequence:++sequence,positionMs,playbackIntent:true});active=await call(resume);instanceId=mount;sequence=0;restores++;
      assert.ok(active._meta?.audio);assert.equal(active._meta.audio.positionMs,positionMs);
      assert.equal((await call({op:'report',...old,sequence:999999,songId:'1',positionMs:0,playing:false})).structuredContent.accepted,false);
      await call({op:'report',instanceId,...active._meta.lease,sequence:++sequence,trackId:active._meta.audio.trackId,songId:'1',positionMs,playing:true,playbackIntent:true});
    }
    const [state,card]=await Promise.all([f.read('now_playing'),f.read('player_state')]);assert.equal(state.playbackMode,'chatgpt');assert.equal(state.state,'playing');assert.equal(state.positionMs,positionMs);assert.equal(card.revision,state.revision);assert.equal(card.playback.handoff,null);assert.equal(card.playback.epoch,owner.epoch);
    samples++;await wait(1000);
  }
  t.diagnostic(JSON.stringify({wallSeconds:Math.round((Date.now()-started)/1000),samples,restores,handoffs:0,epochChanges:0}));
});

test('wall-clock V2 alternating playback ownership and continuous MCP state observation',{skip:!process.env.ONE_EARBUD_V2_STABILITY_MS},async t=>{
  const f=await fixture(t),started=Date.now(),duration=Number(process.env.ONE_EARBUD_V2_STABILITY_MS);let samples=0,transfers=0,lease=null,track=null,sequence=0;
  await f.api('/api/music/queue/append',{method:'POST',body:{songs:[song(1),song(2)]}});await f.p.player.refreshQueue();await f.p.player.playQueueItem(f.p.player.getQueue().items[0].id);await wait(60);
  while(Date.now()-started<duration){
    f.tick(1000);let owner=f.authority.playbackOwner();
    if(samples%10===0){
      const target=owner.mode==='pwa'?'chatgpt':'pwa';
      await f.widget({op:'switch',target,requestId:'sustained-switch-'+samples,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId,...(lease?{...lease,sequence:++sequence,positionMs:50000+samples*100}:{})});
      if(target==='chatgpt'){
        await f.p.player.syncPlayback();assert.equal(f.p.audio().paused,true);owner=f.authority.playbackOwner();
        const r=await f.widget({op:'claim',requestId:'sustained-claim-'+samples,expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});lease=r._meta.lease;track=r._meta.audio;sequence=0;
      }else{lease=null;await f.p.player.syncPlayback();}
      transfers++;
    }
    owner=f.authority.playbackOwner();
    if(owner.mode==='chatgpt')await f.widget({op:'report',...lease,sequence:++sequence,trackId:track.trackId,songId:track.song.songId,positionMs:50000+samples*100,playing:true});
    else{f.p.audio().currentTime=50+samples*.1;f.p.audio().fire('seeked');f.p.timers(20000);await wait(60);}
    const [state,card]=await Promise.all([f.read('now_playing'),f.read('player_state')]);
    assert.equal(state.playbackMode,owner.mode);assert.equal(state.state,'playing');assert.equal(card.current.songId,state.songId);assert.equal(card.revision,state.revision);assert.ok(state.positionMs>=50000);
    samples++;await wait(1000);
  }
  t.diagnostic(JSON.stringify({wallSeconds:Math.round((Date.now()-started)/1000),samples,transfers,oscillations:0}));
});

test('media capabilities enforce origin, Range, expiry and active owner without forwarding cookies or credentials',async t=>{
  const f=await fixture(t);let seen,clock=1000;
  function upstream(url,options,callback){seen={url:url.href,options};const request=new EventEmitter();request.destroy=()=>{};request.end=()=>{const r=Readable.from([Buffer.from('TEST')]);r.statusCode=206;r.headers={'content-type':'audio/mpeg','content-length':'4','content-range':'bytes 0-3/4','set-cookie':'MUSIC_U=DO_NOT_FORWARD'};callback(r);};return request;}
  const adapter=createWidgetPlayback({authority:f.authority,now:()=>clock,upstream});
  const express=require('express'),app=express();app.get('/widget-media/:ticket',adapter.serve);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
  f.authority.queue.append({by:'you',song:song(1)});const owner=f.authority.playbackOwner();
  await adapter.handle({op:'switch',target:'chatgpt',sourceId:'widget-relay-source',requestId:'relay-switch-request',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
  const selected=f.authority.playbackOwner();
  const claim={op:'claim',sourceId:'widget-relay-source',requestId:'relay-claim-request',expectedEpoch:selected.epoch,expectedStreamId:selected.streamId};
  const ready=await adapter.handle(claim);
  const response=await fetch(base+ready._meta.audio.url,{headers:{Range:'bytes=0-3',Cookie:'NEVER_FORWARD',Authorization:'Bearer NEVER_FORWARD'}});
  assert.equal(response.status,206);assert.equal(await response.text(),'TEST');assert.equal(response.headers.get('set-cookie'),null);assert.deepEqual(seen.options.headers,{Range:'bytes=0-3'});
  assert.equal((await fetch(base+ready._meta.audio.url,{headers:{Range:'bytes=0-3,7-9'}})).status,416);
  clock+=600001;assert.equal((await fetch(base+ready._meta.audio.url)).status,403);
  const renewed=await adapter.handle({op:'poll',sourceId:'widget-relay-source',...ready._meta.lease});assert.notEqual(renewed._meta.audio.url,ready._meta.audio.url);
  await adapter.handle({op:'release',sourceId:'widget-relay-source',...ready._meta.lease,sequence:1,positionMs:0});
  assert.equal((await adapter.handle(claim))._meta?.lease,undefined,'late claim retries cannot resurrect a released card');
  assert.equal((await adapter.handle({op:'poll',...ready._meta.lease}))._meta?.lease,undefined,'late polls never recreate sessions');
  assert.equal((await fetch(base+renewed._meta.audio.url)).status,403);assert.equal((await fetch(base+'/widget-media/invalid')).status,403);
  for(const value of ['https://evil.example/a','https://music.126.net.evil.test/a','https://user:password@m701.music.126.net/a','file:///etc/passwd','https://127.0.0.1/a'])assert.equal(mediaUrl(value),null);
});
