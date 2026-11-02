'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../ui/player.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  class Target {
    constructor() { this.listeners = new Map(); this.attrs = {}; this.dataset = {}; this.textContent = ''; this.hidden = false; this.disabled = true; this.checked = false; }
    addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn)); }
    emit(type, value = {}) { return Promise.all((this.listeners.get(type) || []).map(fn => fn(value))); }
    setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    set src(value) { this.attrs.src = value; }
  }
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(x => [x[1], new Target()]));
  elements.auto.checked = true;
  const window = new Target(), document = new Target(), sent = [], timers = new Map(), intervals = new Map();
  let now = 1800000000000, timerId = 0, toolHandler=null;
  const parent = { postMessage(message) { sent.push(message); if(toolHandler&&message.method==='tools/call') Promise.resolve().then(()=>toolHandler(message.params.name,message.params.arguments)).then(result=>window.emit('message',{source:parent,origin:'https://chatgpt.com',data:{jsonrpc:'2.0',id:message.id,result}})); } };
  window.parent = parent; window.crypto = { randomUUID: () => 'widget-unique-request-' + (++timerId) };
  document.getElementById = id => elements[id]; document.documentElement = { dataset:{} }; document.hidden = false;
  document.body = new Target(); document.body.getBoundingClientRect = () => ({ width:375, height:460 });
  const context = { window, document, URL, console, Date:class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id=++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id=++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); }
  };
  const audio=elements['local-audio'];audio.paused=true;audio.currentTime=0;audio.duration=180;audio.readyState=0;audio.playCalls=0;
  Object.defineProperty(audio,'src',{get(){return this.attrs.src;},set(value){this.attrs.src=value;this.currentTime=0;this.readyState=0;this.paused=true;}});
  audio.play=()=>{audio.playCalls++;audio.paused=false;audio.emit('playing');return Promise.resolve();};audio.pause=()=>{if(!audio.paused){audio.paused=true;audio.emit('pause');}};
  vm.runInNewContext(options.audio?script.replace('const MEDIA_ORIGIN = null;',"const MEDIA_ORIGIN = 'https://music.example.test';"):script, context, { filename:'player.html' });
  const message = data => window.emit('message', { source:parent, origin:'https://chatgpt.com', data });
  const respond = async (request, result, error) => { await message({ jsonrpc:'2.0', id:request.id, ...(error ? { error } : { result }) }); await flush(); };
  const last = () => sent.filter(x => x.id && x.method === 'tools/call').at(-1);
  return { elements, window, document, sent, timers, intervals, message, respond, last, now:()=>now, serveTools(handler){toolHandler=handler;}, tick(ms) { now += ms; intervals.forEach(x => x.fn()); },
    snapshot(overrides = {}) { return { ok:true, kind:'one-earbud-player', sampledAt:now, fresh:true, state:'playing', current:{ songId:'123', title:'Test song', artist:'Test artist', coverUrl:'https://p1.music.126.net/test.jpg', durationMs:180000 }, prepared:null, positionMs:10000, lyricContext:{ previous:{text:'Previous'}, current:{text:'Current',trans:'Translation'}, next:{text:'Next'} }, queue:{ count:3, mode:'seq' }, ...overrides }; },
    async initialize() {
      assert.equal(sent[0].method, 'ui/initialize');
      assert.equal(sent[0].params.protocolVersion, '2026-01-26');
      await respond(sent[0], { hostContext:{ theme:'dark' } });
      assert.equal(last().params.name, 'music_player_state');
    },
    async close() { await window.emit('pagehide'); await flush(); }
  };
}

test('MCP Apps widget initializes over the host bridge, renders safe data, and clears stale claims', async () => {
  const f = fixture();
  try {
    await f.initialize();
    assert.equal(f.document.documentElement.dataset.theme, 'dark');
    const size = f.sent.find(x => x.method === 'ui/notifications/size-changed');
    assert.equal(size.params.width, 375); assert.equal(size.params.height, 460);
    await f.respond(f.last(), { structuredContent:f.snapshot({ current:{ songId:'123', title:'<img onerror="steal()">', artist:'Artist', coverUrl:'https://evil.example.test/cookie', durationMs:180000 } }) });
    assert.equal(f.elements.title.textContent, '<img onerror="steal()">'); // Literal text, never parsed HTML.
    assert.equal(f.elements.cover.getAttribute('src'), null);
    assert.equal(f.elements.status.textContent, '手机正在播放');
    assert.equal(f.elements['current-line'].textContent, 'Current');
    assert.equal(f.elements.toggle.disabled, false);
    assert.equal(f.elements.position.textContent, '0:10');
    await f.window.emit('message', { source:{}, data:{ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:{ structuredContent:f.snapshot({ current:{title:'Spoofed'} }) } } });
    assert.notEqual(f.elements.title.textContent, 'Spoofed');
    f.tick(15001);
    assert.equal(f.elements.toggle.disabled, true);
    assert.equal(f.elements.position.textContent, '—:—');
    assert.equal(f.elements['current-line'].textContent, '等手机回报新的播放状态');
    assert.equal(f.elements.status.textContent, '手机状态未更新');
  } finally { await f.close(); }
});

test('widget controls stay pending until phone reports; retries reuse the same requestId', async () => {
  const f = fixture();
  try {
    await f.initialize(); await f.respond(f.last(), { structuredContent:f.snapshot() });
    const click = f.elements.toggle.emit('click'); await flush();
    const request = f.last();
    assert.equal(request.params.name, 'music_player_control');
    assert.equal(request.params.arguments.action, 'pause');
    assert.equal(request.params.arguments.expectedSongId, '123');
    assert.equal(f.elements.status.textContent, '手机正在播放'); // Never optimistically claims paused.
    await f.respond(request, undefined, { code:-1, message:'host unavailable' });
    await f.respond(f.last(), { structuredContent:f.snapshot() }); await click;
    const retryClick = f.elements.toggle.emit('click'); await flush();
    assert.equal(f.last().params.arguments.requestId, request.params.arguments.requestId);
    await f.respond(f.last(), { structuredContent:{ ok:true, message:'等待手机同步', playback:{status:'pending'} } });
    assert.equal(f.elements.status.textContent, '手机正在播放');
    await f.respond(f.last(), { structuredContent:f.snapshot({ state:'paused' }) }); await retryClick;
    assert.equal(f.elements.status.textContent, '手机已暂停');
    assert.equal(f.elements.toggle.getAttribute('aria-label'), '继续手机播放');
  } finally { await f.close(); }
});

test('widget pauses background/long-running refreshes and refuses late older snapshots', async () => {
  const f = fixture();
  try {
    await f.initialize(); const view = f.snapshot();
    await f.respond(f.last(), { structuredContent:view });
    f.document.hidden = true; const count = f.sent.length; f.tick(6000);
    assert.equal(f.sent.length, count);
    f.document.hidden = false; f.tick(1000); await flush();
    assert.equal(f.last().params.name, 'music_player_state');
    await f.respond(f.last(), { structuredContent:f.snapshot({ state:'paused' }) });
    await f.message({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:{ structuredContent:view } });
    assert.equal(f.elements.status.textContent, '手机已暂停');
    f.tick(300001);
    assert.equal(f.elements.auto.checked, false);
    assert.match(f.elements.notice.textContent, /自动刷新已暂停/);
    await f.message({ jsonrpc:'2.0', id:999, method:'ui/resource-teardown' });
    assert.equal(f.sent.at(-1).id, 999);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.elements.toggle.disabled, true);
  } finally { await f.close(); }
});

test('widget gracefully falls back when the host does not support interactive MCP Apps', async () => {
  const f = fixture();
  try {
    const initTimeout = [...f.timers.values()].find(x => x.ms === 6000);
    initTimeout.fn(); await flush();
    assert.match(f.elements.notice.textContent, /尚未提供交互桥接/);
    assert.equal(f.elements.toggle.disabled, true);
  } finally { await f.close(); }
});

test('widget orders phone revisions rather than RPC receipt time and displays actual heartbeat age', async () => {
  const f=fixture();
  try {
    await f.initialize();
    const initial=f.snapshot({streamId:'server-A',revision:12,observedAt:1800000000000-21000});
    const notify=structuredContent=>f.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent}});
    await f.respond(f.last(),{structuredContent:initial});f.tick(1000);
    assert.equal(f.elements.updated.textContent,'手机状态更新于 22 秒前');
    await notify(f.snapshot({streamId:'server-A',revision:11,state:'paused',positionMs:0,current:{songId:'9',title:'Old song'},observedAt:1800000001000}));
    assert.equal(f.elements.title.textContent,'Test song');assert.equal(f.elements.status.textContent,'手机正在播放');
    await notify(f.snapshot({streamId:'server-A',revision:12,observedAt:initial.observedAt}));f.tick(1000);
    assert.equal(f.elements.updated.textContent,'手机状态更新于 23 秒前','RPC refresh does not reset heartbeat age');
    await notify(f.snapshot({streamId:'server-B',revision:1,observedAt:1800000002000,current:{songId:'2',title:'New server song'}}));
    await notify(f.snapshot({streamId:'server-A',revision:99,current:{songId:'9',title:'Retired server song'}}));
    assert.equal(f.elements.title.textContent,'New server song');
  } finally {await f.close();}
});

test('V2 actual widget script plays only after a click, seeks, pauses in background, advances and releases on close',async t=>{
  const os=require('node:os'),{createMusicAuthority}=require('../music/authority'),{createTaMusicTool}=require('../agent/tool-contract');
  const {createPlayerView}=require('../music/player-view'),{createWidgetPlayback}=require('../music/widget-playback');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-ui-v2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const song=id=>({songId:String(id),title:'Song '+id,artist:'Artist',durationMs:180000});
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{cookie:()=> 'TEST_ONLY_COOKIE',refreshCookie(){}},client:{songDetail:async(c,id)=>song(id),lyrics:async()=>({lines:[{index:0,timeMs:0,text:'Test lyric'}]}),playUrl:async()=>({url:'https://m701.music.126.net/test.mp3'})}});
  authority.queue.append({by:'you',songs:[song(1),song(2)]});
  const view=createPlayerView({authority,tool:createTaMusicTool({authority})}),adapter=createWidgetPlayback({authority,publicUrl:'https://music.example.test'});
  const f=fixture({audio:true}),settle=async()=>{for(let i=0;i<20;i++)await flush();};
  let holdPoll=false,releasePoll;
  try {
    await f.initialize();f.serveTools(async(name,args)=>{const result=name==='music_player_state'?{structuredContent:await view()}:await adapter.handle(args);if(args.op==='poll'&&holdPoll){holdPoll=false;return new Promise(resolve=>{releasePoll=()=>resolve(result);});}return result;});
    await f.respond(f.last(),{structuredContent:await view()});
    f.elements['playback-mode'].value='chatgpt';await f.elements['playback-mode'].emit('change');await settle();
    const audio=f.elements['local-audio'];assert.match(audio.src,/^https:\/\/music\.example\.test\/widget-media\//);assert.equal(audio.playCalls,0);
    audio.readyState=1;await audio.emit('loadedmetadata');await settle();assert.equal(audio.paused,true);
    await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);assert.equal(audio.playCalls,1);assert.equal(authority.nowPlaying().state,'playing');assert.equal(authority.nowPlaying().playbackMode,'chatgpt');
    assert.equal(f.elements.status.textContent,'ChatGPT正在播放');assert.equal(f.elements['current-line'].textContent,'Test lyric');
    f.elements.seek.value=500;await f.elements.seek.emit('change');await settle();assert.equal(audio.currentTime,90);assert.ok(authority.nowPlaying().positionMs>=90000);
    for(let i=0;i<30;i++){audio.currentTime+=1;f.tick(1000);await settle();assert.equal(audio.paused,false);}
    f.document.hidden=true;await f.document.emit('visibilitychange');await settle();assert.equal(audio.paused,true);assert.equal(authority.nowPlaying().state,'paused');
    f.document.hidden=false;await f.document.emit('visibilitychange');await settle();
    holdPoll=true;f.tick(5000);await settle();assert.equal(typeof releasePoll,'function');
    await f.elements.next.emit('click');await settle();const newerUrl=audio.src;releasePoll();await settle();assert.equal(audio.src,newerUrl,'late audio descriptor cannot replace the next track');
    audio.readyState=1;await audio.emit('loadedmetadata');await settle();
    assert.equal(authority.nowPlaying().songId,'2');assert.equal(audio.paused,true,'paused skips only prepare the next track');
    await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);
    audio.currentTime=37;await audio.emit('seeked');await settle();
    await f.close();await settle();assert.equal(audio.paused,true);assert.equal(authority.playbackOwner().ownerSourceId,null);assert.equal(authority.nowPlaying().state,'paused');assert.ok(authority.nowPlaying().positionMs>=37000);
  } finally {await f.close();}
});

test('actual card retains handoff song and progress past heartbeat expiry, then prepares paused audio after timeout without another switch',async t=>{
  const os=require('node:os'),{createMusicAuthority}=require('../music/authority'),{createTaMusicTool}=require('../agent/tool-contract');
  const {createPlayerView}=require('../music/player-view'),{createWidgetPlayback}=require('../music/widget-playback');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-ui-handoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture({audio:true}),song={songId:'1',title:'Retained phone song',artist:'Artist',durationMs:180000};
  const authority=createMusicAuthority({now:f.now,queueFile:path.join(dir,'queue.json'),store:{cookie:()=>'',refreshCookie(){}},client:{songDetail:async()=>song,lyrics:async()=>({lines:[]}),playUrl:async()=>({url:'https://m701.music.126.net/test.mp3'})}});
  const phone={sourceId:'phone-suspended-A',...authority.claimNowPlaying({sourceId:'phone-suspended-A',active:true})};
  authority.reportNowPlaying({...phone,...song,sequence:1,positionMs:42000,playing:true});f.tick(59000);
  const view=createPlayerView({authority,tool:createTaMusicTool({authority})}),adapter=createWidgetPlayback({authority,publicUrl:'https://music.example.test'});
  const settle=async()=>{for(let i=0;i<20;i++)await flush();};
  try {
    await f.initialize();f.serveTools(async(name,args)=>name==='music_player_state'?{structuredContent:await view()}:adapter.handle(args));
    await f.respond(f.last(),{structuredContent:await view()});
    f.elements['playback-mode'].value='chatgpt';await f.elements['playback-mode'].emit('change');await settle();
    assert.ok(authority.playbackOwner().handoff);assert.equal(f.elements.title.textContent,song.title);assert.equal(f.elements.position.textContent,'1:41');assert.match(f.elements['mode-status'].textContent,/12 秒/);
    f.tick(2000);await f.elements.refresh.emit('click');await settle();
    assert.equal(f.elements.title.textContent,song.title);assert.equal(f.elements.position.textContent,'1:41');assert.equal(f.elements.toggle.disabled,true);assert.match(f.elements.status.textContent,/已保留歌曲和进度/);
    f.tick(10000);await f.elements.refresh.emit('click');await settle();
    assert.equal(authority.playbackOwner().handoff,null);assert.equal(authority.playbackOwner().mode,'chatgpt');
    const audio=f.elements['local-audio'];assert.match(audio.src,/\/widget-media\//);audio.readyState=1;await audio.emit('loadedmetadata');await settle();
    assert.equal(audio.currentTime,101);assert.equal(audio.playCalls,0);assert.equal(f.elements.toggle.disabled,false);assert.match(f.elements.notice.textContent,/已超时收回播放权/);
    await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);assert.equal(authority.nowPlaying().state,'playing');assert.equal(f.elements.title.textContent,song.title);
    assert.equal(authority.reportNowPlaying({...phone,sequence:999,...song,positionMs:0,playing:false}),false);assert.equal(authority.nowPlaying().state,'playing');
  } finally {await f.close();}
});
