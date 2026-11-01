'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../ui/player.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
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
  let now = 1800000000000, timerId = 0;
  const parent = { postMessage(message) { sent.push(message); } };
  window.parent = parent; window.crypto = { randomUUID: () => 'widget-unique-request-' + (++timerId) };
  document.getElementById = id => elements[id]; document.documentElement = { dataset:{} }; document.hidden = false;
  document.body = new Target(); document.body.getBoundingClientRect = () => ({ width:375, height:460 });
  const context = { window, document, URL, console, Date:class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id=++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id=++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); }
  };
  vm.runInNewContext(script, context, { filename:'player.html' });
  const message = data => window.emit('message', { source:parent, origin:'https://chatgpt.com', data });
  const respond = async (request, result, error) => { await message({ jsonrpc:'2.0', id:request.id, ...(error ? { error } : { result }) }); await flush(); };
  const last = () => sent.filter(x => x.id && x.method === 'tools/call').at(-1);
  return { elements, window, document, sent, timers, intervals, message, respond, last, tick(ms) { now += ms; intervals.forEach(x => x.fn()); },
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
