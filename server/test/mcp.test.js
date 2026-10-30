'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp } = require('../app');
const { createMusicAuthority } = require('../music/authority');
const { createMusicAuthStore } = require('../music/store');

const WEB = 'test-web-token-placeholder';
const MCP = 'test-mcp-token-placeholder';
const COOKIE = 'MUSIC_U=TEST_ONLY_NEVER_REAL_COOKIE';
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-earbud-mcp-'));
  const store = createMusicAuthStore({ file: path.join(dir, 'netease-auth.json') });
  store.save(COOKIE, { nickname: 'Test' }, false);
  let now = Date.now();
  const lines = [0, 1, 2].map(index => ({ index, timeMs: index * 10000, text: 'Test line ' + index, trans: '测试 ' + index }));
  const song = id => ({ songId: id, title: 'Test ' + id, artist: 'Test Artist', album: 'Test Album', durationMs: 180000, coverUrl: '' });
  const authority = createMusicAuthority({ store, queueFile: path.join(dir, 'queue.json'), now: () => now,
    client: {
      search: async (cookie, query) => { assert.equal(cookie, COOKIE); if (query === 'error') { const e = new Error(COOKIE + ' netease-auth.json ' + MCP); e.code = 'MUSIC_UPSTREAM_ERROR'; throw e; } return [{ ...song('123'), cookie }]; },
      songDetail: async (cookie, id) => ({ ...song(id), cookie }),
      lyrics: async () => ({ lines }),
      playUrl: async (cookie, id) => ({ url: 'https://audio.example.test/' + id, cookie })
    }
  });
  const { app } = createApp({ authority, token: WEB, mcpToken: MCP, publicUrl: '', dataDir: dir, ...options });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { authority, url, dir, tick(ms) { now += ms; }, song, lines };
}
async function connect(t, url) {
  const client = new Client({ name: 'one-earbud-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + MCP } } });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}
const call = async (client, name, args = {}) => (await client.callTool({ name: 'music_' + name, arguments: args })).structuredContent;

test('MCP SDK initialize, tools/list, search, lyrics, share and safe errors', async t => {
  const { url } = await fixture(t);
  const client = await connect(t, url);
  assert.equal(client.getServerVersion().name, 'one-earbud');
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(x => x.name).sort(), ['now_playing','lyrics','search','queue','share','play_next','queue_add','play_now'].map(x => 'music_' + x).sort());
  assert.equal((await call(client, 'search', { query: 'Test' })).songs[0].songId, '123');
  assert.equal((await call(client, 'lyrics', { songId: '123' })).lines[1].trans, '测试 1');
  const share = await call(client, 'share', { songId: '123', note: 'Test', lineIndexes: [1] });
  assert.equal(share.rendered, false); assert.equal(share.delivery.card.lines[0].index, 1); assert.equal(share.song.songId, '123');
  const error = await client.callTool({ name: 'music_search', arguments: { query: 'error' } });
  assert.equal(error.isError, true);
  for (const value of [listed, share, error, await call(client, 'search', { query: 'Test' })]) {
    assert.doesNotMatch(JSON.stringify(value), /TEST_ONLY_NEVER_REAL_COOKIE|netease-auth\.json|test-mcp-token-placeholder|"cookie"/);
  }
  const invalid = await client.callTool({ name: 'music_queue_add', arguments: { songId: '123', requestId: 'short' } });
  assert.equal(invalid.isError, true);
});

test('MCP authentication is required on every method; web and MCP tokens are isolated', async t => {
  const { url } = await fixture(t);
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const token of ['', WEB, 'invalid']) {
      const r = await fetch(url + '/mcp', { method, headers: token ? { Authorization: 'Bearer ' + token } : {} });
      assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /^Bearer/);
    }
  }
  assert.equal((await fetch(url + '/mcp?token=' + MCP)).status, 401);
  assert.equal((await fetch(url + '/api/music/queue', { headers: { Authorization: 'Bearer ' + MCP } })).status, 401);
  assert.equal((await fetch(url + '/api/music/playback-sync')).status, 401);
  assert.equal((await fetch(url + '/mcp', { headers: { Authorization: 'Bearer ' + MCP } })).status, 405);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + MCP, Origin: 'https://evil.example.test' } })).status, 403);
  await connect(t, url);
});

test('now_playing reuses heartbeat freshness, pause cutoff, progress and lyric context', async t => {
  const { authority, url, tick } = await fixture(t);
  const client = await connect(t, url);
  assert.equal((await call(client, 'now_playing')).listening, false);
  const report = playing => authority.reportNowPlaying({ songId: '123', title: 'Test', artist: 'Test Artist', positionMs: 10500, durationMs: 180000, playing });
  report(true);
  const current = await call(client, 'now_playing');
  assert.equal(current.fresh, true); assert.equal(current.positionMs, 10500);
  assert.equal(current.lyricContext.current.index, 1); assert.equal(current.lyricContext.previous.index, 0); assert.equal(current.lyricContext.next.index, 2);
  tick(61000); assert.equal((await call(client, 'now_playing')).listening, false);
  report(false); assert.equal((await call(client, 'now_playing')).state, 'paused');
  for (let i = 0; i < 21; i++) { tick(30000); report(false); }
  assert.equal((await call(client, 'now_playing')).listening, false);
  report(true); authority.clearNowPlaying(); assert.equal((await call(client, 'now_playing')).listening, false);
});

test('all writes coalesce concurrent requestId retries across independent MCP connections', async t => {
  const { authority, url, song, tick } = await fixture(t);
  authority.queue.append({ by: 'you', song: song('1') });
  const a = await connect(t, url), b = await connect(t, url);
  for (const action of ['play_next', 'queue_add', 'play_now', 'share']) {
    const args = { songId: '123', note: 'Test note', requestId: 'test-idempotency-' + action };
    const before = authority.queue.get().items.length;
    const results = await Promise.all([call(a, action, args), call(b, action, args)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await call(b, action, args), results[0]);
    assert.equal(authority.queue.get().items.length, before + (action === 'share' ? 0 : 1));
  }
  const headers = { Authorization: 'Bearer ' + WEB };
  await call(a, 'play_now', { songId: '456', note: 'n'.repeat(300), requestId: 'test-long-play-note' });
  assert.equal(authority.queue.get().items.find(x => x.songId === '456').note.length, 300);
  const sync = await (await fetch(url + '/api/music/playback-sync', { headers })).json();
  assert.equal(sync.command.itemId, sync.queue.currentId);
  assert.equal(sync.queue.items.find(x => x.id === sync.command.itemId).songId, '456');
  assert.doesNotMatch(JSON.stringify(sync), /TEST_ONLY_NEVER_REAL_COOKIE|"cookie"/);
  tick(180001);
  assert.equal((await (await fetch(url + '/api/music/playback-sync', { headers })).json()).command, null);
  assert.equal((await call(a, 'queue')).count, 5);
});

test('single service serves the player/PWA, login and health; secrets/data are not static files', async t => {
  const { url } = await fixture(t);
  for (const route of ['/', '/login.html', '/manifest.webmanifest', '/sw.js', '/healthz']) assert.equal((await fetch(url + route)).status, 200);
  for (const route of ['/data/netease-auth.json', '/data/oauth-state.json', '/.env', '/server/app.js']) assert.equal((await fetch(url + route)).status, 404);
  assert.throws(() => createApp({ token: WEB, mcpToken: WEB }), /distinct/);
  const { url: disabled } = await fixture(t, { mcpToken: '' });
  assert.equal((await fetch(disabled + '/mcp')).status, 503);
});

test('ChatGPT OAuth discovery, owner consent, PKCE, resource binding, refresh and revocation', async t => {
  const publicUrl = 'https://music.example.test';
  const { url, dir, authority } = await fixture(t, { publicUrl });
  const resource = publicUrl + '/mcp';
  const challenge = await fetch(url + '/mcp');
  assert.match(challenge.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const meta = await (await fetch(url + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, resource);
  const discovery = await (await fetch(url + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  const post = (route, body, json = false) => fetch(url + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body) });
  const callback = 'https://chatgpt.com/connector/oauth/test-callback';
  assert.equal((await post('/register', { redirect_uris: ['https://evil.example.test/callback'], token_endpoint_auth_method: 'none' }, true)).status, 400);
  const registration = await post('/register', { redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, true);
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = 'test-verifier-must-be-at-least-forty-three-characters-long';
  const hash = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, resource, response_type: 'code', code_challenge_method: 'S256', code_challenge: hash, scope: 'music', state: 'test-state' });
  const form = await (await fetch(url + '/authorize?' + params)).text();
  assert.doesNotMatch(form, /test-mcp-token-placeholder|TEST_ONLY_NEVER_REAL_COOKIE/);
  const nonce = /name="nonce" value="([^"]+)"/.exec(form)[1];
  assert.equal((await post('/oauth/consent', { nonce, token: WEB })).status, 401);
  const approved = await post('/oauth/consent', { nonce, token: MCP });
  assert.equal(approved.status, 303);
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'test-state');
  assert.equal((await post('/oauth/consent', { nonce, token: MCP })).status, 400);
  const exchange = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource, code: redirect.searchParams.get('code'), code_verifier: verifier };
  assert.equal((await post('/token', { ...exchange, code_verifier: 'wrong' })).status, 400);
  const tokensResponse = await post('/token', exchange); assert.equal(tokensResponse.status, 200);
  const tokens = await tokensResponse.json();
  assert.notEqual(tokens.access_token, MCP);
  assert.equal((await post('/token', exchange)).status, 400);
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } } });
  const sdk = new Client({ name: 'oauth-test', version: '1' }); await sdk.connect(transport); t.after(() => sdk.close());
  assert.equal((await sdk.listTools()).tools.length, 8);
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource, refresh_token: tokens.refresh_token };
  assert.equal((await post('/token', { ...refresh, resource: 'https://evil.example.test/mcp' })).status, 400);
  assert.equal((await post('/token', refresh)).status, 200);
  assert.equal((await post('/token', refresh)).status, 400);
  const persisted = fs.readFileSync(path.join(dir, 'oauth-state.json'), 'utf8');
  assert.equal(persisted.includes(tokens.access_token), false);
  assert.equal(persisted.includes(tokens.refresh_token), false);
  const { mountOAuth } = require('../oauth');
  const reopened = mountOAuth(require('express')(), { publicUrl, token: MCP, dataDir: dir });
  assert.equal(await reopened.verify(tokens.access_token), true);
  const moved = mountOAuth(require('express')(), { publicUrl: 'https://different.example.test', token: MCP, dataDir: dir });
  assert.equal(await moved.verify(tokens.access_token), false);
  const rotated = mountOAuth(require('express')(), { publicUrl, token: 'rotated-test-token', dataDir: dir });
  assert.equal(await rotated.verify(tokens.access_token), false);
  await post('/revoke', { client_id: client.client_id, token: tokens.access_token });
  assert.equal((await fetch(url + '/mcp', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).status, 401);
});
