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
    constructor() { this.listeners = new Map(); this.children=[]; this.attrs = {}; this.dataset = {}; this.style={setProperty:(k,v)=>{this.style[k]=v;}}; this.textContent = ''; this.hidden = false; this.disabled = true; this.checked = false; }
    append(...nodes) {this.children.push(...nodes);}
    replaceChildren(...nodes) {this.children=[...nodes];}
    addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn)); }
    emit(type, value = {}) { return Promise.all((this.listeners.get(type) || []).map(fn => fn(value))); }
    setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    set src(value) { this.attrs.src = value; }
  }
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(x => [x[1], new Target()]));
  elements.notice.textContent = /<p id="notice"[^>]*>([^<]*)<\/p>/.exec(html)[1];
  elements.auto.checked = true;
  const window = new Target(), document = new Target(), sent = [], timers = new Map(), intervals = new Map();
  let now = 1800000000000, timerId = 0, toolHandler=null;
  const parent = { postMessage(message) { sent.push(message); if(toolHandler&&message.method==='tools/call') Promise.resolve().then(()=>toolHandler(message.params.name,message.params.arguments)).then(result=>window.emit('message',{source:parent,origin:'https://chatgpt.com',data:{jsonrpc:'2.0',id:message.id,result}})); } };
  window.parent = parent; window.crypto = { randomUUID: () => (options.idPrefix||'widget-unique-request-') + (++timerId) };
  const savedStates=[];window.openai={widgetState:options.widgetState,setWidgetState(value){this.widgetState=structuredClone(value);savedStates.push(this.widgetState);}};
  let intersect;
  document.getElementById = id => elements[id]; document.documentElement = { dataset:{} }; document.hidden = false;
  document.createElement=()=>new Target();
  document.body = new Target(); document.body.getBoundingClientRect = () => ({ width:375, height:460 });
  const context = { window, document, URL, console, IntersectionObserver:class{constructor(callback){intersect=callback;}observe(){}disconnect(){}}, Date:class extends Date { static now() { return now; } },
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
  return { elements, window, document, sent, timers, intervals, message, respond, last, savedStates, intersect(value){intersect([{isIntersecting:value}]);}, now:()=>now, serveTools(handler){toolHandler=handler;}, tick(ms) { now += ms; intervals.forEach(x => x.fn()); },
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

test('actual widget browses paged playlists, selects and plays a song in the existing ChatGPT lease, then searches and returns without changing ownership',async t=>{
  const os=require('node:os'),{createMusicAuthority}=require('../music/authority'),{createTaMusicTool}=require('../agent/tool-contract');
  const {createPlayerView}=require('../music/player-view'),{createWidgetPlayback}=require('../music/widget-playback'),{createPlayerLibrary}=require('../music/player-library');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-library-ui-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const song=id=>({songId:String(id),title:id==='99'?'<img onerror="bad()">':'Song '+id,artist:'Artist',coverUrl:'https://p1.music.126.net/test.jpg',durationMs:180000});
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{publicState:()=>({connected:true,profile:{userId:'987'}}),cookie:()=> 'TEST_ONLY_COOKIE',refreshCookie(){}},client:{
    songDetail:async(c,id)=>song(id),lyrics:async()=>({lines:[{index:0,timeMs:0,text:'Chosen lyric'}]}),playUrl:async()=>({url:'https://m701.music.126.net/test.mp3'}),
    userPlaylists:async()=>[{playlistId:'10',name:'Test list',mine:true,count:45},{playlistId:'11',name:'Liked',mine:true,liked:true,count:1}],playlistSongs:async()=>Array.from({length:45},(_,i)=>song(i+1)),search:async()=>[song('99')]
  }});
  authority.queue.append({by:'you',song:song('1')});
  const view=createPlayerView({authority,tool:createTaMusicTool({authority})}),adapter=createWidgetPlayback({authority,publicUrl:'https://music.example.test'}),library=createPlayerLibrary({authority});
  const f=fixture({audio:true}),settle=async()=>{for(let i=0;i<25;i++)await flush();};
  let failLibrary=false,releaseRead,holdRead=false;
  const handler=async(name,args)=>{
    if(name==='music_player_state')return {structuredContent:await view()};
    if(name==='music_player_library'){
      if(failLibrary){failLibrary=false;return {isError:true,structuredContent:{ok:false,message:'测试读取失败，请重试。'}};}
      const result={structuredContent:await library(args)};
      if(holdRead){holdRead=false;return new Promise(r=>releaseRead=()=>r(result));}return result;
    }
    return adapter.handle(args);
  };
  let observer;
  try {
    await f.initialize();f.serveTools(handler);await f.respond(f.last(),{structuredContent:await view()});
    await f.elements['show-playlists'].emit('click');await settle();assert.equal(f.elements['player-panel'].hidden,true);assert.equal(f.elements['library-panel'].hidden,false);assert.equal(f.elements['library-list'].children[0].children.at(-1).children[0].textContent,'我喜欢的音乐');assert.equal(authority.queue.get().items.length,1);
    await f.elements['library-list'].children[1].emit('click');await settle();assert.equal(f.elements['library-title'].textContent,'Test list');assert.equal(f.elements['library-list'].children.length,20);
    await f.elements['library-next'].emit('click');await settle();assert.equal(f.elements['library-page'].textContent,'21–40 / 45');
    await f.elements['library-back'].emit('click');await settle();assert.equal(f.elements['library-title'].textContent,'我的歌单');
    await f.elements['show-player'].emit('click');f.elements['playback-mode'].value='chatgpt';await f.elements['playback-mode'].emit('change');await settle();
    const audio=f.elements['local-audio'];audio.readyState=1;await audio.emit('loadedmetadata');await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);
    const before=authority.playbackOwner();failLibrary=true;await f.elements['show-playlists'].emit('click');await settle();assert.equal(f.elements['library-retry'].hidden,false);assert.match(f.elements['library-message'].textContent,/测试读取失败/);assert.equal(audio.paused,false);
    await f.elements['library-retry'].emit('click');await settle();await f.elements['library-list'].children[1].emit('click');await settle();
    const old=f.sent.filter(x=>x.params?.arguments?.op==='report').at(-1).params.arguments;
    await f.elements['library-list'].children[1].emit('click');await settle();assert.equal(f.elements['player-panel'].hidden,false);assert.equal(f.elements['library-panel'].hidden,true);audio.readyState=1;await audio.emit('loadedmetadata');await settle();
    assert.equal(audio.paused,false);assert.equal(authority.nowPlaying().songId,'2');assert.equal(f.elements.title.textContent,'Song 2');assert.equal(f.elements.position.textContent,'0:00');assert.equal(f.elements['current-line'].textContent,'Chosen lyric');assert.equal(f.elements['pause-icon'].hidden,false);assert.equal(f.elements['library-feedback'].textContent,'');
    assert.equal(authority.playbackOwner().epoch,before.epoch);assert.equal(authority.playbackOwner().ownerSourceId,before.ownerSourceId);assert.equal(authority.playbackOwner().handoff,null);
    assert.equal((await adapter.handle({...old,sequence:99999,playing:false,positionMs:0})).structuredContent.staleTrack,true);assert.equal(authority.nowPlaying().songId,'2');
    // A new UI observing the still-playing mount selects remotely; it must not create sound.
    observer=fixture({audio:true,idPrefix:'library-observer-',widgetState:f.savedStates.at(-1)});await observer.initialize();observer.serveTools(handler);await observer.respond(observer.last(),{structuredContent:await view()});await settle();
    await observer.elements['show-playlists'].emit('click');await settle();await observer.elements['library-list'].children[1].emit('click');await settle();await observer.elements['library-list'].children[2].emit('click');await settle();
    assert.equal(observer.elements['local-audio'].playCalls,0);assert.equal(audio.paused,false);f.tick(5000);await settle();audio.readyState=1;await audio.emit('loadedmetadata');await settle();assert.equal(authority.nowPlaying().songId,'3');assert.equal(audio.paused,false);assert.equal(authority.playbackOwner().handoff,null);
    await f.elements['show-search'].emit('click');f.elements['library-query'].value='test';await f.elements['library-search'].emit('submit',{preventDefault(){}});await settle();assert.equal(f.elements['library-list'].children[0].children.at(-1).children[0].textContent,'<img onerror="bad()">');
    await f.elements['library-list'].children[0].emit('click');await settle();audio.readyState=1;await audio.emit('loadedmetadata');await settle();assert.equal(authority.nowPlaying().songId,'99');assert.equal(audio.paused,false);
    holdRead=true;await f.elements['show-playlists'].emit('click');await settle();await f.elements['show-player'].emit('click');releaseRead();await settle();assert.equal(f.elements['library-panel'].hidden,true,'late list response must not reopen a page');assert.equal(audio.paused,false);
  }finally{if(observer)await observer.close();await f.close();}
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

test('V2 single pink seek stays synchronized; hidden/offscreen playback continues and host pauses restore safely',async t=>{
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
    assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/);
    assert.doesNotMatch(f.elements.notice.textContent,/首次播放请先在手机|卡片不会另开/);
    assert.equal(f.elements['pause-icon'].hidden,false);assert.equal(f.elements['play-icon'].hidden,true);
    // The actual owned audio must win over a delayed paused server snapshot.
    await f.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{...await view(),state:'paused'}}});
    assert.equal(f.elements.status.textContent,'ChatGPT正在播放');assert.equal(f.elements['pause-icon'].hidden,false);
    f.document.hidden=true;f.intersect(false);await f.document.emit('visibilitychange');
    audio.currentTime=12; // Audio keeps going while the chat is away; no playing event on return.
    f.elements['play-icon'].hidden=false;f.elements['pause-icon'].hidden=true; // Cached presentation, not audio state.
    f.document.hidden=false;const returning=f.document.emit('visibilitychange');
    assert.equal(audio.paused,false);assert.equal(f.elements['pause-icon'].hidden,false,'return must resample audio before an RPC reply');assert.equal(f.elements['play-icon'].hidden,true);assert.equal(f.elements.toggle.getAttribute('aria-label'),'暂停 ChatGPT 播放');
    assert.equal(f.elements.position.textContent,'0:12');await returning;f.intersect(true);await settle();
    for(const event of ['focus','pageshow','openai:set_globals']){f.elements['pause-icon'].hidden=true;f.elements.notice.textContent='首次播放请先在手机 PWA 点播放。卡片不会另开一份音频。';await f.window.emit(event);assert.equal(f.elements['pause-icon'].hidden,false);assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/);await settle();}
    // A remounted observer must control the still-running owner, not start handoff.
    const observer=fixture({audio:true,idPrefix:'observing-other-chat-'}),control=require('../music/player-controls').createPlayerControls({authority});
    try {
      await observer.initialize();observer.serveTools(async(name,args)=>name==='music_player_state'?{structuredContent:await view()}:name==='music_player_control'?{structuredContent:control(args)}:adapter.handle(args));
      await observer.respond(observer.last(),{structuredContent:await view()});await settle();
      assert.equal(observer.elements['local-audio'].paused,true);assert.equal(observer.elements['pause-icon'].hidden,false);
      const before=authority.playbackOwner();await observer.elements.toggle.emit('click');await settle();
      assert.equal(audio.paused,false,'pending control is not optimistic playback state');
      f.tick(5000);await settle();assert.equal(audio.paused,true,'original owner receives pause through existing controls');
      assert.equal(authority.playbackOwner().epoch,before.epoch);assert.equal(authority.playbackOwner().sourceId,before.sourceId);assert.equal(authority.playbackOwner().handoff,null);
      await observer.elements.refresh.emit('click');await settle();assert.equal(observer.elements['play-icon'].hidden,false);assert.equal(observer.elements['pause-icon'].hidden,true);
      await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);
    }finally{await observer.close();}
    assert.equal(f.elements.progress.hidden,true);assert.equal(f.elements.seek.hidden,false);assert.equal(f.elements.seek.disabled,false);
    assert.match(html,/#seek::-webkit-slider-thumb/);assert.match(html,/#seek::-moz-range-thumb/);
    f.elements.seek.value=500;await f.elements.seek.emit('input');audio.currentTime=12;await audio.emit('timeupdate');assert.equal(f.elements.seek.value,500,'sampling must not fight a dragging finger');assert.equal(f.elements.seek.style['--fill'],'50%');
    await f.elements.seek.emit('change');await settle();assert.equal(audio.currentTime,90);assert.ok(authority.nowPlaying().positionMs>=90000);
    for(let i=0;i<30;i++){audio.currentTime+=1;f.tick(1000);await settle();assert.equal(audio.paused,false);}
    f.intersect(false);f.document.hidden=true;await f.document.emit('visibilitychange');await settle();assert.equal(audio.paused,false);assert.equal(authority.nowPlaying().state,'playing');
    for(let i=0;i<30;i++){audio.currentTime+=1;f.tick(1000);await settle();assert.equal(audio.paused,false,'offscreen audio must still poll and report beyond the 20s guard');}
    assert.equal(authority.nowPlaying().state,'playing');
    audio.pause();await settle();assert.equal(authority.nowPlaying().state,'paused','a real host pause is reported honestly');
    const checkpoint=f.savedStates.at(-1).privateContent.playback;assert.equal(checkpoint.song.songId,'1');assert.equal(checkpoint.positionMs,150000);assert.equal(checkpoint.playbackIntent,true);assert.equal(checkpoint.actualPlaying,false);
    assert.doesNotMatch(JSON.stringify(checkpoint),/sessionId|trackId|widget-media|TEST_ONLY_COOKIE|url/);
    f.document.hidden=false;f.intersect(true);await f.document.emit('visibilitychange');await settle();assert.equal(audio.paused,false,'returning validates owner before a best-effort resume');assert.equal(audio.currentTime,150);
    await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,true);assert.equal(f.savedStates.at(-1).privateContent.playback.playbackIntent,false);
    f.document.hidden=true;await f.document.emit('visibilitychange');f.intersect(false);f.document.hidden=false;f.intersect(true);await f.document.emit('visibilitychange');await settle();assert.equal(audio.paused,true,'explicit user pause never auto-resumes');
    await f.window.emit('pagehide',{persisted:true});assert.ok(f.intervals.size>0);await f.window.emit('pageshow',{persisted:true});await settle();assert.equal(audio.currentTime,150);
    holdPoll=true;f.tick(5000);await settle();assert.equal(typeof releasePoll,'function');
    await f.elements.next.emit('click');await settle();const newerUrl=audio.src;releasePoll();await settle();assert.equal(audio.src,newerUrl,'late audio descriptor cannot replace the next track');
    audio.readyState=1;await audio.emit('loadedmetadata');await settle();
    assert.equal(authority.nowPlaying().songId,'2');assert.equal(audio.paused,true,'paused skips only prepare the next track');
    await f.elements.toggle.emit('click');await settle();assert.equal(audio.paused,false);
    await audio.emit('error');await settle();assert.equal(audio.paused,true);
    assert.match(f.elements.notice.textContent,/无法在 ChatGPT 加载音频/);
    const refocus=f.window.emit('focus');assert.match(f.elements.notice.textContent,/无法在 ChatGPT 加载音频/,'a synchronous repaint must preserve an actionable current error');await refocus;await settle();
    if(audio.paused){await f.elements.toggle.emit('click');await settle();}assert.equal(audio.paused,false);assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/,'successful playback replaces a stale play/error prompt');
    audio.currentTime=37;await audio.emit('seeked');await settle();
    f.intersect(false);f.document.hidden=true;audio.pause();await settle();
    const owner=authority.playbackOwner(),last=f.sent.filter(x=>x.params?.name==='music_widget_playback'&&x.params.arguments.op==='report').at(-1).params.arguments;
    authority.switchPlayback({target:'pwa',sourceId:'widget-another-source',requestId:'return-during-suspension',expectedEpoch:owner.epoch,expectedStreamId:owner.streamId});
    authority.acknowledgeHandoff({...last,sequence:last.sequence+100,handoffId:authority.playbackOwner().handoff.id,positionMs:37000});
    const plays=audio.playCalls;f.document.hidden=false;f.intersect(true);await f.document.emit('visibilitychange');await settle();
    assert.equal(audio.paused,true);assert.equal(audio.playCalls,plays,'an old widget must not resume after ownership was handed back to PWA');
    await f.close();await settle();assert.equal(audio.paused,true);assert.equal(authority.playbackOwner().ownerSourceId,null);assert.equal(authority.nowPlaying().state,'paused');assert.ok(authority.nowPlaying().positionMs>=37000);
    const reopened=fixture({audio:true,idPrefix:'reopened-widget-',widgetState:f.savedStates.at(-1)});
    try {
      await reopened.initialize();reopened.serveTools(async(name,args)=>name==='music_player_state'?{structuredContent:await view()}:adapter.handle(args));
      await reopened.respond(reopened.last(),{structuredContent:await view()});
      reopened.elements['playback-mode'].value='chatgpt';await reopened.elements['playback-mode'].emit('change');await settle();
      const restored=reopened.elements['local-audio'];restored.readyState=1;await restored.emit('loadedmetadata');await settle();
      assert.equal(reopened.elements.title.textContent,'Song 2');assert.equal(restored.currentTime,37);assert.equal(restored.playCalls,0,'remount prepares the latest song/position without using checkpoint as playback authority');
    }finally{await reopened.close();}
  } finally {await f.close();}
});

test('widget restoration displays a non-authoritative checkpoint without replaying audio or persisting capabilities',async()=>{
  const widgetState={privateContent:{playback:{version:1,song:{songId:'42',title:'Saved song',artist:'Artist',durationMs:180000},positionMs:63000,playbackIntent:true,actualPlaying:true,savedAt:1799999990000}}};
  const f=fixture({audio:true,widgetState});
  try {
    await f.initialize();await f.respond(f.last(),{structuredContent:f.snapshot({fresh:false,current:null,prepared:null,playback:{mode:'chatgpt',epoch:1,sourceId:'another-widget',streamId:'stream-A',handoff:null}})});
    assert.equal(f.elements.title.textContent,'Saved song');assert.equal(f.elements.position.textContent,'1:03');assert.match(f.elements.status.textContent,/非实况/);assert.equal(f.elements['local-audio'].playCalls,0);
    assert.equal(f.elements.seek.disabled,true);assert.equal(f.sent.filter(x=>x.params?.name==='music_widget_playback'&&x.params.arguments.op==='claim').length,0);
    assert.equal(f.elements['pause-icon'].hidden,true,'persisted actualPlaying=true is not proof of live playback');
  } finally {await f.close();}
});

test('returning/remounted ChatGPT UI shows pause for the still-playing owner and sends pause without acquiring audio',async()=>{
  const f=fixture({audio:true,widgetState:{privateContent:{playback:{version:1,song:{songId:'123',title:'Old snapshot'},positionMs:1000,playbackIntent:false,actualPlaying:false}}}});
  try {
    await f.initialize();
    const playback={mode:'chatgpt',epoch:3,streamId:'stream-live',sourceId:'widget-still-playing',ownerSourceId:'widget-still-playing',handoff:null,resume:null};
    let state='playing';
    f.serveTools(async(name)=>name==='music_player_state'?{structuredContent:f.snapshot({streamId:playback.streamId,revision:state==='playing'?30:31,playback,state})}:name==='music_player_control'?(state='paused',{structuredContent:{ok:true,message:'pending'}}):{structuredContent:{ok:true,playback}});
    await f.respond(f.last(),{structuredContent:f.snapshot({streamId:playback.streamId,revision:30,playback})});
    assert.equal(f.elements['local-audio'].paused,true,'restored observer has no local audio; another instance is still playing');
    assert.equal(f.elements.status.textContent,'ChatGPT正在播放');assert.equal(f.elements['current-line'].textContent,'Current');
    assert.equal(f.elements['play-icon'].hidden,true);assert.equal(f.elements['pause-icon'].hidden,false);assert.equal(f.elements.toggle.getAttribute('aria-label'),'暂停 ChatGPT 播放');
    f.document.hidden=true;await f.document.emit('visibilitychange');f.document.hidden=false;await f.document.emit('visibilitychange');await flush();
    assert.equal(f.elements['pause-icon'].hidden,false);
    await f.elements.toggle.emit('click');await flush();const command=f.sent.filter(x=>x.params?.name==='music_player_control').at(-1);
    assert.equal(command.params.name,'music_player_control');assert.equal(command.params.arguments.action,'pause');assert.equal(command.params.arguments.expectedSongId,'123');
    assert.equal(f.sent.filter(x=>x.params?.name==='music_widget_playback'&&['switch','claim'].includes(x.params.arguments.op)).length,0);
    assert.equal(f.elements.status.textContent,'ChatGPT已暂停');assert.equal(f.elements['pause-icon'].hidden,true);assert.equal(f.elements['play-icon'].hidden,false);
  }finally{await f.close();}
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
    assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/);assert.doesNotMatch(f.elements.notice.textContent,/已超时|先点播放/);
    assert.equal(authority.reportNowPlaying({...phone,sequence:999,...song,positionMs:0,playing:false}),false);assert.equal(authority.nowPlaying().state,'playing');
  } finally {await f.close();}
});

test('footer hydration follows authoritative mode, clears old mode feedback, and never treats a saved intent as live audio',async()=>{
  const f=fixture({widgetState:{privateContent:{playback:{version:1,song:{songId:'123',title:'Saved ChatGPT song'},positionMs:10000,playbackIntent:true,actualPlaying:true}}}});
  let playback={mode:'pwa',epoch:1,streamId:'footer-stream',sourceId:'phone-live',ownerSourceId:'phone-live',handoff:null};
  let state='paused',revision=1;
  const snapshot=()=>f.snapshot({streamId:playback.streamId,revision,playback,state});
  const notify=()=>f.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:snapshot()}});
  try {
    assert.doesNotMatch(f.elements.notice.textContent,/PWA/,'unhydrated HTML must not assert a playback mode');
    await f.initialize();
    f.serveTools(async name=>name==='music_player_state'?{structuredContent:snapshot()}:name==='music_player_control'?{structuredContent:{ok:true,message:'等待手机同步'}}:{structuredContent:{ok:true,playback}});
    await f.respond(f.last(),{structuredContent:snapshot()});
    assert.match(f.elements.notice.textContent,/请先在手机 PWA 点播放/,'fresh PWA authority wins over a saved ChatGPT checkpoint');
    await f.elements.toggle.emit('click');await flush();assert.equal(f.elements.notice.textContent,'等待手机同步');
    playback={...playback,mode:'chatgpt',epoch:2,sourceId:'widget-live',ownerSourceId:'widget-live'};state='playing';revision++;await notify();
    assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/,'old PWA operation feedback cannot survive a mode change');
    assert.equal(f.elements['pause-icon'].hidden,false);assert.equal(f.elements['playback-mode'].value,'chatgpt');
    for(const event of ['focus','pageshow','openai:set_globals']){f.elements.notice.textContent='首次播放请先在手机 PWA 点播放。卡片不会另开一份音频。';await f.window.emit(event);assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/);await flush();}
    await f.elements.refresh.emit('click');await flush();assert.match(f.elements.notice.textContent,/声音来自 ChatGPT/,'manual refresh has no PWA-only reading prompt');
    state='paused';revision++;await notify();assert.match(f.elements.notice.textContent,/ChatGPT 已暂停/);
    const stale={...snapshot(),fresh:false,current:null,prepared:null,revision:++revision};
    await f.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:stale}});
    assert.match(f.elements.notice.textContent,/正在恢复 ChatGPT/);assert.doesNotMatch(f.elements.artist.textContent,/PWA/);assert.doesNotMatch(f.elements['current-line'].textContent,/手机/);
    assert.equal(f.elements['pause-icon'].hidden,true,'saved actualPlaying=true cannot force playing copy');
    playback={...playback,mode:'pwa',epoch:3,sourceId:'phone-live',ownerSourceId:'phone-live'};state='playing';revision++;await notify();
    assert.match(f.elements.notice.textContent,/声音来自手机 PWA/);assert.doesNotMatch(f.elements.notice.textContent,/声音来自 ChatGPT/);
  }finally{await f.close();}
});

test('real widget remount automatically restores its stable card, never switches, and resumes released audio at the latest position',async t=>{
  const os=require('node:os'),{createMusicAuthority}=require('../music/authority'),{createTaMusicTool}=require('../agent/tool-contract');
  const {createPlayerView}=require('../music/player-view'),{createWidgetPlayback}=require('../music/widget-playback');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-remount-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture({audio:true,idPrefix:'original-mount-'}),settle=async()=>{for(let i=0;i<20;i++)await flush();};
  const song={songId:'1',title:'Continuous song',artist:'Artist',durationMs:180000};
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{cookie:()=>'',refreshCookie(){}},client:{songDetail:async()=>song,lyrics:async()=>({lines:[{index:0,timeMs:0,text:'Continuous lyric'}]}),playUrl:async()=>({url:'https://m701.music.126.net/test.mp3'})}});
  authority.queue.append({by:'you',song});const view=createPlayerView({authority,tool:createTaMusicTool({authority})}),adapter=createWidgetPlayback({authority,publicUrl:'https://music.example.test'});
  const handle=async(name,args)=>name==='music_player_state'?{structuredContent:await view()}:adapter.handle(args);
  let restored,duplicate;
  try {
    await f.initialize();f.serveTools(handle);await f.respond(f.last(),{structuredContent:await view()});
    f.elements['playback-mode'].value='chatgpt';await f.elements['playback-mode'].emit('change');await settle();
    const original=f.elements['local-audio'];original.readyState=1;await original.emit('loadedmetadata');await f.elements.toggle.emit('click');await settle();original.currentTime=42;await original.emit('seeked');await settle();
    const saved=f.savedStates.at(-1),sourceId=saved.privateContent.playbackClient.sourceId,owner=authority.playbackOwner();assert.equal(owner.sourceId,sourceId);
    assert.doesNotMatch(JSON.stringify(saved),/sessionId|widget-media|TEST_ONLY_COOKIE|MCP_AUTH_TOKEN|ONE_EARBUD_TOKEN/);
    f.document.hidden=true;f.intersect(false);await f.document.emit('visibilitychange');
    restored=fixture({audio:true,idPrefix:'restored-mount-',widgetState:saved});await restored.initialize();restored.serveTools(handle);await restored.respond(restored.last(),{structuredContent:await view()});await settle();
    assert.equal(restored.savedStates.at(-1).privateContent.playbackClient.sourceId,sourceId);
    assert.equal(original.paused,false);assert.equal(restored.elements['local-audio'].playCalls,0);assert.equal(restored.elements.status.textContent,'ChatGPT正在播放');assert.equal(restored.elements['mode-status'].textContent,'此卡片播放');assert.equal(restored.elements['pause-icon'].hidden,false);assert.equal(restored.elements['current-line'].textContent,'Continuous lyric');
    assert.match(restored.elements.notice.textContent,/声音来自 ChatGPT/,'remount derives the footer from the same live state as the pause icon');
    assert.doesNotMatch(restored.elements.notice.textContent,/首次播放请先在手机|卡片不会另开/);
    for(let i=0;i<10;i++){original.currentTime=43+i;await original.emit('seeked');await settle();restored.tick(5000);await settle();assert.equal(authority.playbackOwner().epoch,owner.epoch);assert.equal(authority.playbackOwner().handoff,null);assert.equal(original.paused,false);}
    restored.elements['playback-mode'].value='chatgpt';await restored.elements['playback-mode'].emit('change');await settle();
    assert.equal(restored.sent.filter(x=>x.params?.name==='music_widget_playback'&&['switch','claim'].includes(x.params.arguments.op)).length,0,'restoration and repeated select do not request a handoff');
    const old=f.sent.filter(x=>x.params?.name==='music_widget_playback'&&x.params.arguments.op==='report').at(-1).params.arguments;
    await f.close();await settle();assert.equal(original.paused,true);
    restored.tick(5000);await settle();const audio=restored.elements['local-audio'];assert.match(audio.src,/widget-media/);audio.readyState=1;await audio.emit('loadedmetadata');await settle();
    assert.equal(audio.currentTime,52);assert.equal(audio.paused,false);assert.equal(audio.playCalls,1);assert.equal(authority.playbackOwner().epoch,owner.epoch);assert.equal(authority.playbackOwner().handoff,null);
    assert.equal((await adapter.handle({...old,sequence:999999,playing:false,positionMs:0})).structuredContent.accepted,false);assert.equal(authority.nowPlaying().state,'playing');
    duplicate=fixture({audio:true,idPrefix:'duplicate-mount-',widgetState:restored.savedStates.at(-1)});await duplicate.initialize();duplicate.serveTools(handle);await duplicate.respond(duplicate.last(),{structuredContent:await view()});await settle();
    assert.equal(audio.paused,false);assert.equal(duplicate.elements['local-audio'].playCalls,0);assert.equal(authority.playbackOwner().handoff,null);
  }finally{if(duplicate)await duplicate.close();if(restored)await restored.close();await f.close();}
});
