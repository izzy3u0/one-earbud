'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp } = require('../app');
const { createMusicAuthority } = require('../music/authority');

test('ChatGPT MCP -> real HTTP authority -> phone player: queue sync, active switch, idle preparation, dedupe', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-earbud-phone-'));
  const song = id => ({ songId: id, title: 'Test ' + id, artist: 'Test Artist', durationMs: 100000, lyrics: [] });
  const authority = createMusicAuthority({ queueFile: path.join(dir, 'queue.json'), store: { cookie: () => 'TEST_ONLY_COOKIE', refreshCookie() {} }, client: {
    songDetail: async (cookie, id) => song(id), lyrics: async () => ({ lines: [] }), search: async () => [],
    playUrl: async (cookie, id) => ({ url: 'https://audio.example.test/' + id })
  } });
  const { app } = createApp({ authority, token: 'test-phone-token', mcpToken: 'test-mcp-token', publicUrl: '' });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new Client({ name: 'phone-e2e-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-mcp-token' } } }));
  const send = async (action, id) => (await client.callTool({ name: 'music_' + action, arguments: { songId: id, requestId: 'phone-test-' + action + '-' + id, note: 'for the phone' } })).structuredContent;
  let audio;
  class FakeAudio extends EventTarget {
    constructor() { super(); this.attrs = {}; this.currentTime = 0; this.duration = 100; this.paused = true; this.style = {}; this.playCalls = 0; }
    setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    set src(v) { this.attrs.src = v; this.currentTime = 0; } get src() { return this.attrs.src; }
    load() {}
    async play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  }
  const oldInterval = global.setInterval, oldTimeout = global.setTimeout;
  const timers = [];
  global.setInterval = (...args) => { const timer = oldInterval(...args); timer.unref(); timers.push(timer); return timer; };
  global.setTimeout = (...args) => { const timer = oldTimeout(...args); timer.unref(); timers.push(timer); return timer; };
  global.localStorage = { data: new Map([['one-earbud.token', 'test-phone-token']]), getItem(k) { return this.data.get(k) ?? null; }, setItem(k, v) { this.data.set(k, v); }, removeItem(k) { this.data.delete(k); } };
  global.document = { readyState: 'complete', hidden: false, body: { appendChild() {} }, createElement() { return audio = new FakeAudio(); }, addEventListener() {} };
  global.window = { addEventListener() {}, ONE_EARBUD_API_BASE: base + '/api/music' };
  fs.writeFileSync(path.join(dir, 'api.mjs'), fs.readFileSync(path.join(__dirname, '../../web/lib/api.js'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'player.mjs'), fs.readFileSync(path.join(__dirname, '../../web/music/player.js'), 'utf8').replace("'../lib/api.js'", "'./api.mjs'"));
  let player;
  t.after(async () => {
    if (player) player.close();
    timers.forEach(clearTimeout); global.setInterval = oldInterval; global.setTimeout = oldTimeout;
    await client.close(); await new Promise(resolve => server.close(resolve));
    delete global.window; delete global.document; delete global.localStorage;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  player = await import(pathToFileURL(path.join(dir, 'player.mjs')).href);
  await send('play_now', '1'); await player.syncPlayback();
  assert.equal(player.getState().song.songId, '1'); assert.equal(audio.playCalls, 0); assert.equal(player.getState().playing, false);
  assert.equal(audio.src, 'https://audio.example.test/1');
  player.toggle(); // Actual user gesture after the source is prepared.
  assert.equal(player.getState().playing, true);
  await send('play_next', '2'); await send('queue_add', '3'); await player.syncPlayback();
  assert.deepEqual(player.getQueue().items.map(x => x.songId), ['1', '2', '3']);
  assert.equal(player.getState().song.songId, '1');
  const play = await send('play_now', '4'); assert.equal(play.playback.status, 'pending');
  await player.syncPlayback();
  assert.equal(player.getState().song.songId, '4'); assert.equal(player.getState().playing, true);
  assert.equal(audio.src, 'https://audio.example.test/4'); assert.equal(player.taItem().note, 'for the phone');
  const calls = audio.playCalls;
  await player.syncPlayback(); await player.playFromTa(play.delivery.card.playNow.itemId);
  assert.equal(audio.playCalls, calls); // Polling and a legacy chat card must not double-trigger.
  await player.next(); assert.equal(player.getState().song.songId, '2'); // Original queued successor remains.
  player.toggle(); assert.equal(player.getState().playing, false);
  const pausedCalls = audio.playCalls;
  await send('play_now', '6'); await player.syncPlayback();
  assert.equal(player.getState().song.songId, '6'); assert.equal(audio.playCalls, pausedCalls);
  player.close();
  await send('play_now', '7'); await player.syncPlayback();
  assert.equal(player.getState().song.songId, '7'); assert.equal(audio.playCalls, pausedCalls);
  const latest = await send('play_now', '8');
  // The user can supersede a command before the phone receives it.
  authority.queue.setCurrent({ by: 'you', id: authority.queue.get().items[0].id });
  await player.syncPlayback(); await player.playFromTa(latest.delivery.card.playNow.itemId);
  assert.equal(player.getState().song.songId, '7');
});
