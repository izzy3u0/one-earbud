'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp } = require('../app');
const { createMusicAuthority } = require('../music/authority');
const { createFileOAuthStore, createPostgresOAuthStore, prepareOAuthStore } = require('../oauth-store');
const OWNER = 'TEST_ONLY_OAUTH_OWNER_PLACEHOLDER';
const KEY = 'TEST_ONLY_OAUTH_ENCRYPTION_KEY_32_CHARACTERS';
const CONNECTION = 'postgresql://test:test@database.example.test/test?sslmode=require';
const ORIGIN = 'https://music.example.test', RESOURCE = ORIGIN + '/mcp';
const CALLBACK = 'https://chatgpt.com/connector/oauth/lifecycle-test';
const VERIFIER = 'TEST_ONLY_PKCE_VERIFIER_WITH_MORE_THAN_43_CHARACTERS';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// Shared row plus transaction locking, independently of any process or local files.
function database() {
  const db = { payload: null, fail: false, calls: [], locks: 0 };
  let queue = Promise.resolve();
  function execute(sql, args = [], tx) {
    db.calls.push(sql);
    if (db.fail) throw new Error(CONNECTION + ' secret provider error');
    if (sql.startsWith('CREATE TABLE')) return { rows: [] };
    if (sql.startsWith('SELECT')) return { rows: db.payload === null ? [] : [{ payload: db.payload }] };
    if (sql.startsWith('INSERT')) { if (db.payload === null) db.payload = args[1]; return { rows: [] }; }
    if (sql.startsWith('UPDATE') && tx) { tx.payload = args[0]; return { rows: [], rowCount: 1 }; }
    throw new Error('Unexpected SQL ' + sql);
  }
  db.pool = () => ({
    on() {}, async end() {},
    async query(sql, args) { return execute(sql, args); },
    async connect() {
      let unlock;
      const tx = { payload: undefined };
      return {
        async query(sql, args) {
          if (sql === 'BEGIN') {
            const prev = queue;
            queue = new Promise(resolve => { unlock = resolve; });
            await prev; db.locks++; return { rows: [] };
          }
          if (sql === 'COMMIT') { if (db.fail) throw new Error(CONNECTION); if (tx.payload !== undefined) db.payload = tx.payload; return { rows: [] }; }
          if (sql === 'ROLLBACK') return { rows: [] };
          return execute(sql, args, tx);
        },
        release() { unlock?.(); }
      };
    }
  });
  return db;
}
const open = (db, options = {}) => createPostgresOAuthStore({ connectionString: CONNECTION, encryptionKey: KEY, pool: db.pool(), ...options });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earbud-oauth-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const db = database(), dir = temp(t), events = [];
  let server, base, store, now = Date.now();
  async function close() {
    if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
    if (store) await store.close();
  }
  async function boot({ owner = OWNER, origin = ORIGIN } = {}) {
    await close();
    fs.rmSync(dir, { force: true, recursive: true }); // Render replacement: no old files.
    store = await open(db, { dataDir: dir });
    const authority = createMusicAuthority({ queueFile: path.join(dir, 'queue.json'), dataDir: dir });
    const { app } = createApp({ authority, token: 'TEST_ONLY_WEB_TOKEN', mcpToken: owner, publicUrl: origin, oauthStore: store, oauthNow: () => now, oauthDiagnostic: event => events.push(event), dataDir: dir });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(close);
  await boot();
  const post = (route, body, json = false) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body) });
  const register = async () => {
    const r = await post('/register', { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, true);
    assert.equal(r.status, 201); return r.json();
  };
  const begin = async client => {
    const r = await fetch(base + '/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', resource: RESOURCE, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'kept-state', scope: 'music' }));
    assert.equal(r.status, 200);
    return /name="nonce" value="([^"]+)"/.exec(await r.text())[1];
  };
  const approve = async nonce => {
    const r = await post('/oauth/consent', { nonce, token: OWNER });
    assert.equal(r.status, 303);
    const url = new URL(r.headers.get('location'));
    assert.equal(url.searchParams.get('state'), 'kept-state');
    return url.searchParams.get('code');
  };
  const exchange = async (client, code) => {
    const r = await post('/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, code, code_verifier: VERIFIER });
    assert.equal(r.status, 200); return r.json();
  };
  const refresh = (client, tokens, extra = {}) => post('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, ...extra });
  const mcp = access => fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + access, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1' } } }) });
  return { db, dir, events, boot, post, register, begin, approve, exchange, refresh, mcp, tick(ms) { now += ms; }, base: () => base };
}

test('durable OAuth survives filesystem replacement at every grant stage; expired access refreshes with the same DCR client', async t => {
  const f = await fixture(t), client = await f.register();
  const nonce = await f.begin(client);
  await f.boot();
  const code = await f.approve(nonce);
  await f.boot();
  const tokens = await f.exchange(client, code);
  assert.equal(tokens.expires_in, 3600);
  await f.boot();
  f.tick(3599999); assert.equal((await f.mcp(tokens.access_token)).status, 200);
  f.tick(1);
  const expired = await f.mcp(tokens.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.match(expired.headers.get('www-authenticate'), /resource_metadata=/);
  const refreshed = await f.refresh(client, tokens); // Omitted resource inherits the original audience.
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await f.refresh(client, tokens)).status, 400); // Still single use.
  await f.boot();
  assert.equal((await f.mcp(next.access_token)).status, 200);
  assert.equal((await f.refresh(client, next, { resource: RESOURCE })).status, 200);
  assert.ok(f.events.includes('access_expired')); assert.ok(f.events.includes('refresh_issued'));
  assert.ok(!fs.existsSync(path.join(f.dir, 'oauth-state.json')));
  for (const secret of [OWNER, client.client_id, nonce, code, tokens.access_token, tokens.refresh_token]) {
    assert.ok(!f.db.payload.includes(secret)); assert.ok(!JSON.stringify(f.events).includes(secret));
  }
  assert.ok(f.db.calls.every(sql => !sql.includes('netease')));
});

test('official MCP client automatically refreshes after 401 and both music tools work over multiple one-hour boundaries', async t => {
  const f = await fixture(t), clientInfo = await f.register();
  let tokens = { ...await f.exchange(clientInfo, await f.approve(await f.begin(clientInfo))), issuer: ORIGIN + '/' };
  let info = { ...clientInfo, issuer: ORIGIN + '/' }, renewals = 0;
  const provider = {
    redirectUrl: CALLBACK, clientMetadata: clientInfo,
    clientInformation: () => info, saveClientInformation: value => { info = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; renewals++; },
    redirectToAuthorization() { throw new Error('Unexpected interactive reauthorization'); },
    saveCodeVerifier() {}, codeVerifier: () => VERIFIER,
    validateResourceURL: async () => new URL(RESOURCE)
  };
  // Only route public discovery/token URLs to this test HTTP server; metadata stays realistic.
  const mappedFetch = (url, init) => {
    const target = new URL(String(url));
    if (target.origin === ORIGIN) return fetch(f.base() + target.pathname + target.search, init);
    return fetch(url, init);
  };
  const client = new Client({ name: 'refresh-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base() + '/mcp'), { authProvider: provider, fetch: mappedFetch }));
  t.after(() => client.close());
  for (let i = 0; i < 3; i++) {
    if (i) f.tick(3600001);
    for (const name of ['music_now_playing', 'music_open_player']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.notEqual(result.isError, true); assert.ok(result.structuredContent);
    }
  }
  assert.equal(renewals, 2);
});

test('refresh rejects wrong audiences, clients, scopes and expired grants without destroying a valid grant', async t => {
  const f = await fixture(t), a = await f.register(), b = await f.register();
  const tokens = await f.exchange(a, await f.approve(await f.begin(a)));
  for (const [client, extra] of [[a, { resource: 'https://evil.example/mcp' }], [b, {}], [a, { scope: 'admin' }]]) assert.equal((await f.refresh(client, tokens, extra)).status, 400);
  const responses = await Promise.all([f.refresh(a, tokens), f.refresh(a, tokens)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]); // Atomic consume, no lost updates.
  const next = await responses.find(r => r.status === 200).json();
  f.tick(30 * 86400000);
  assert.equal((await f.refresh(a, next)).status, 400);
});

test('database outages fail as retryable 503, never as an auth reset; owner rotation still revokes tokens', async t => {
  const f = await fixture(t), client = await f.register();
  const tokens = await f.exchange(client, await f.approve(await f.begin(client)));
  const before = f.db.payload;
  f.db.fail = true;
  const response = await f.mcp(tokens.access_token);
  assert.equal(response.status, 503); assert.equal(response.headers.get('www-authenticate'), null);
  assert.doesNotMatch(await response.text(), /postgresql|secret provider|TEST_ONLY/);
  assert.equal(f.db.payload, before);
  f.db.fail = false;
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  await f.boot({ owner: 'TEST_ONLY_ROTATED_OWNER_PLACEHOLDER' });
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  await f.boot({ origin: 'https://new.example.test' });
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
});

test('durable store migrates private OAuth file once, validates encryption, and rolls back failed writes', async t => {
  const db = database(), dir = temp(t), file = path.join(dir, 'oauth-state.json');
  const local = createFileOAuthStore({ dataDir: dir });
  await local.change(state => { state.clients.test = { client_id: 'test' }; });
  const store = await open(db, { dataDir: dir });
  assert.equal(fs.existsSync(file), false);
  assert.equal(await store.read(state => state.clients.test.client_id), 'test');
  await assert.rejects(store.change(state => { state.clients.bad = {}; throw new Error('abort'); }), /abort/);
  assert.equal(await store.read(state => state.clients.bad), undefined);
  const before = db.payload;
  await assert.rejects(open(db, { dataDir: dir, encryptionKey: KEY + 'different' }), { code: 'OAUTH_STORAGE_UNAVAILABLE' });
  assert.equal(db.payload, before);
  assert.equal(await store.read(state => state.clients.test.client_id), 'test');
  await store.close();
  const fallback = await prepareOAuthStore({}, { dataDir: dir });
  await fallback.change(state => { state.clients.local = {}; });
  assert.ok(fs.existsSync(file));
  await fallback.close();
});

test('overlapping processes see each other\'s changes and cannot overwrite newer OAuth registrations', async t => {
  const db = database(), dir = temp(t);
  const a = await open(db, { dataDir: dir }), b = await open(db, { dataDir: dir });
  await Promise.all([
    a.change(state => { state.clients.a = { client_id: 'a' }; }),
    b.change(state => { state.clients.b = { client_id: 'b' }; })
  ]);
  assert.deepEqual(await a.read(state => Object.keys(state.clients).sort()), ['a', 'b']);
  assert.deepEqual(await b.read(state => Object.keys(state.clients).sort()), ['a', 'b']);
  assert.ok(db.calls.some(sql => sql.endsWith('FOR UPDATE')));
  await a.close(); await b.close();
});
