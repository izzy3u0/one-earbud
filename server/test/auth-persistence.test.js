'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createMusicAuthStore } = require('../music/store');
const { createPostgresAuthStore, prepareMusicAuthStore, poolOptions } = require('../music/postgres-auth');
const { createMusicAuthority } = require('../music/authority');
const { createApp } = require('../app');
const netease = require('../music/netease');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const CONNECTION = 'postgresql://test:TEST_PASSWORD@database.example/test?sslmode=require&channel_binding=require';
const KEY = 'TEST_ONLY_ENCRYPTION_KEY_32_CHARACTERS_LONG';
const COOKIE = 'MUSIC_U=TEST_ONLY_NETEASE_SESSION; __csrf=old';

// Model the shared durable row independently of any one process / its temporary files.
function database() {
  const db = { row: null, fail: false, calls: 0, beforeUpdate: null };
  db.pool = () => ({
    on() {}, async end() {},
    async query(sql, args = []) {
      db.calls++;
      if (db.fail) throw new Error('provider error with ' + CONNECTION + ' ' + COOKIE);
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT')) return { rows: db.row ? [{ ...db.row }] : [] };
      if (sql.startsWith('INSERT')) { if (!db.row) db.row = { payload: args[1], revision: '0' }; return { rows: [] }; }
      if (sql.startsWith('UPDATE')) {
        if (db.beforeUpdate) await db.beforeUpdate();
        if (!db.row || String(db.row.revision) !== args[2]) return { rows: [] };
        db.row = { payload: args[0], revision: String(BigInt(db.row.revision) + 1n) };
        return { rows: [{ revision: db.row.revision }] };
      }
      throw new Error('Unexpected SQL');
    }
  });
  return db;
}
function open(db, extra = {}) { return createPostgresAuthStore({ connectionString: CONNECTION, encryptionKey: KEY, pool: db.pool(), ...extra }); }
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earbud-auth-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function client() {
  return { createQr: async () => ({ key: 'test-key', expiresAt: Date.now() + 10000 }),
    checkQr: async () => ({ status: 'success', cookie: COOKIE }),
    account: async () => ({ cookie: COOKIE, profile: { userId: '42', nickname: 'test' }, vip: true }),
    search: async c => { assert.match(c, /TEST_ONLY_NETEASE_SESSION/); return [{ songId: '1', title: 'test' }]; } };
}
function authority(store, dir) { return createMusicAuthority({ store, client: client(), queueFile: path.join(dir, 'queue.json') }); }
async function login(a) { const qr = await a.startQr(); return a.pollQr(qr.key); }

test('QR login survives a completely new process store and deleted temporary directory; encrypted at rest', async t => {
  const db = database(), dir = tmp(t), first = await open(db);
  const a = authority(first, dir);
  assert.equal((await login(a)).status, 'success');
  assert.ok(db.row.payload.startsWith('v1.'));
  assert.ok(!JSON.stringify(db.row).includes('MUSIC_U'));
  assert.ok(!JSON.stringify(db.row).includes('TEST_ONLY_NETEASE_SESSION'));
  await first.close(); fs.rmSync(dir, { force: true, recursive: true });
  const restored = await open(db), b = authority(restored, tmp(t));
  assert.equal(b.status().connected, true);
  assert.equal(b.status().profile.userId, '42');
  assert.equal((await b.search('test'))[0].songId, '1');
  assert.ok(!JSON.stringify(b.status()).includes('cookie'));
  const calls = db.calls;
  for (let i = 0; i < 10; i++) b.status();
  assert.equal(db.calls, calls, 'status/heartbeat must not keep a free database awake');
  await restored.close();
});

test('refresh is durable, merges concurrent changed keys, and ignores responses from replaced sessions', async () => {
  const db = database(), store = await open(db);
  await store.save(COOKIE, null, false);
  await Promise.all([
    store.refreshCookie(COOKIE.replace('__csrf=old', '__csrf=new'), COOKIE),
    store.refreshCookie(COOKIE + '; refresh=next', COOKIE)
  ]);
  const recovered = await open(db);
  assert.match(recovered.cookie(), /__csrf=new/); assert.match(recovered.cookie(), /refresh=next/);
  await store.save('MUSIC_U=DIFFERENT_TEST_SESSION', null, false);
  await store.refreshCookie(COOKIE + '; stale=yes', COOKIE);
  assert.equal(store.cookie(), 'MUSIC_U=DIFFERENT_TEST_SESSION');
});

test('logout tombstone prevents stale local-file migration and in-flight refresh resurrection', async t => {
  const db = database(), local = createMusicAuthStore({ file: path.join(tmp(t), 'auth.json') });
  local.save(COOKIE, { userId: '42' }, false);
  const store = await open(db, { localStore: local });
  assert.equal(store.cookie(), COOKIE);
  await Promise.all([store.clear(), store.refreshCookie(COOKIE + '; old=yes', COOKIE)]);
  assert.equal(db.row.payload, null);
  assert.equal((await open(db, { localStore: local })).cookie(), '');
});

test('configured store fails closed on connection errors, corrupted data or wrong key; no secrets in error', async t => {
  const db = database(), store = await open(db);
  await store.save(COOKIE, null, false);
  const encrypted = db.row.payload;
  await assert.rejects(open(db, { encryptionKey: 'WRONG_TEST_KEY_WITH_32_CHARACTERS_LONG' }), e => {
    assert.equal(e.code, 'MUSIC_AUTH_STORAGE_UNAVAILABLE'); assert.ok(!e.message.includes('TEST')); return true;
  });
  assert.equal(db.row.payload, encrypted);
  db.fail = true;
  await assert.rejects(store.refreshCookie(COOKIE + '; changed=yes', COOKIE), e => {
    assert.equal(e.status, 503); assert.ok(!e.message.includes('TEST')); assert.ok(!e.message.includes('postgres')); return true;
  });
  assert.equal(store.cookie(), COOKIE, 'transient persistence errors must not clear a working session');
  const local = createMusicAuthStore({ file: path.join(tmp(t), 'auth.json') }); local.save(COOKIE);
  await assert.rejects(prepareMusicAuthStore({ ONE_EARBUD_AUTH_DATABASE_URL: CONNECTION, ONE_EARBUD_AUTH_ENCRYPTION_KEY: KEY }, { pool: db.pool(), localStore: local }));
  assert.equal(local.cookie(), COOKIE, 'failed migration must retain its source');
  db.fail = false; db.row.payload = 'v1.corrupted';
  await assert.rejects(open(db), { code: 'MUSIC_AUTH_STORAGE_UNAVAILABLE' });
});

test('QR success and logout await durable commit; failure returns sanitized 503 through existing REST', async t => {
  const db = database(), store = await open(db), a = authority(store, tmp(t));
  let release, entered;
  const updating = new Promise(r => { entered = r; });
  db.beforeUpdate = () => { entered(); return new Promise(r => { release = r; }); };
  let acknowledged = false;
  const loggingIn = login(a).then(r => { acknowledged = true; return r; });
  await updating;
  assert.equal(acknowledged, false); assert.equal(a.status().connected, false);
  release(); await loggingIn; db.beforeUpdate = null;
  const { app } = createApp({ authority: a, token: 'TEST_WEB', mcpToken: 'TEST_MCP', publicUrl: '' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = 'http://127.0.0.1:' + server.address().port;
  db.fail = true;
  const failed = await fetch(url + '/api/music/logout', { method: 'POST', headers: { Authorization: 'Bearer TEST_WEB' } });
  assert.equal(failed.status, 503);
  const text = await failed.text(); assert.ok(!text.includes('TEST')); assert.ok(!text.includes('postgres'));
  assert.equal(a.status().connected, true);
  db.fail = false;
  const success = await fetch(url + '/api/music/logout', { method: 'POST', headers: { Authorization: 'Bearer TEST_WEB' } });
  assert.equal(success.status, 200); assert.equal((await success.json()).connected, false);
  assert.equal((await open(db)).cookie(), '');
});

test('startup migrates the existing auth file once, removes plaintext, and retains local-only compatibility', async t => {
  const db = database(), local = createMusicAuthStore({ file: path.join(tmp(t), 'auth.json') });
  local.save(COOKIE, { userId: '42' }, true, 1234);
  assert.equal(await prepareMusicAuthStore({}, { localStore: local }), local);
  const store = await prepareMusicAuthStore({ ONE_EARBUD_AUTH_DATABASE_URL: CONNECTION, ONE_EARBUD_AUTH_ENCRYPTION_KEY: KEY }, { pool: db.pool(), localStore: local });
  assert.equal(store.cookie(), COOKIE); assert.equal(local.cookie(), '');
  assert.equal(store.publicState().connectedAt, new Date(1234).toISOString());
});

test('stale process cannot overwrite a newer durable session; TLS cannot be disabled via URL', async () => {
  const db = database(), first = await open(db), stale = await open(db);
  await first.save(COOKIE);
  await assert.rejects(stale.save('MUSIC_U=STALE'), { code: 'MUSIC_AUTH_STORAGE_UNAVAILABLE' });
  assert.equal((await open(db)).cookie(), COOKIE);
  assert.equal(stale.cookie(), COOKIE);
  await stale.refreshCookie(COOKIE + '; recovered=yes', COOKIE);
  assert.match((await open(db)).cookie(), /recovered=yes/);
  const options = poolOptions(CONNECTION + '&sslrootcert=system&sslrejectUnauthorized=false');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.ok(!options.connectionString.includes('ssl'));
  await assert.rejects(open(db, { encryptionKey: 'short' }), { code: 'MUSIC_AUTH_STORAGE_CONFIG' });
  assert.throws(() => poolOptions('not a URL TEST_PASSWORD'), { code: 'MUSIC_AUTH_STORAGE_CONFIG' });
});

test('real NetEase transport persists Set-Cookie from search, lyrics and playlists before shaping results', async t => {
  const db = database(), store = await open(db); await store.save(COOKIE);
  const observed = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      observed.push(options.headers.Cookie);
      const response = new EventEmitter(); response.statusCode = 200;
      response.headers = { 'set-cookie': ['__csrf=refreshed-' + observed.length + '; Path=/; HttpOnly'] };
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ code: 200, result: { songs: [] }, playlist: [], lrc: { lyric: '[00:01]test' } })));
      response.emit('end');
    }); return req;
  });
  const c = netease.createClient({ onCookie: (cookie, base) => store.refreshCookie(cookie, base) });
  assert.deepEqual(await c.search(store.cookie(), 'test'), []);
  assert.match(store.cookie(), /refreshed-1/);
  const lyrics = await c.lyrics(store.cookie(), '1'); assert.equal(lyrics.lines[0].text, 'test');
  assert.ok(!JSON.stringify(lyrics).includes('cookie'));
  await c.userPlaylists(store.cookie(), '42');
  assert.match(observed[1], /refreshed-1/); assert.match(observed[2], /refreshed-2/);
  assert.match((await open(db)).cookie(), /refreshed-3/);
});

test('local auth store also merges refreshes and never restores a logged-out session', t => {
  const store = createMusicAuthStore({ file: path.join(tmp(t), 'auth.json') }); store.save(COOKIE);
  store.refreshCookie(COOKIE + '; added=yes', COOKIE);
  store.refreshCookie(COOKIE.replace('__csrf=old', '__csrf=new'), COOKIE);
  assert.match(store.cookie(), /added=yes/); assert.match(store.cookie(), /__csrf=new/);
  store.clear(); store.refreshCookie(COOKIE, COOKIE); assert.equal(store.cookie(), '');
});

test('MCP works with restored encrypted auth, keeps stale heartbeat empty, and never exposes storage secrets', async t => {
  const db = database(), old = await open(db); await old.save(COOKIE, { userId: '42' }, false); await old.close();
  const store = await open(db), dir = tmp(t);
  const a = authority(store, dir);
  const { app } = createApp({ authority: a, token: 'TEST_WEB', mcpToken: 'TEST_MCP', publicUrl: '' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const mcp = new Client({ name: 'auth-restore-test', version: '1.0.0' });
  t.after(async () => { await mcp.close(); await new Promise(r => server.close(r)); await store.close(); });
  assert.equal((await fetch(url + '/mcp')).status, 401);
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer TEST_MCP' } } }));
  const search = await mcp.callTool({ name: 'music_search', arguments: { query: 'test' } });
  assert.equal(search.structuredContent.songs[0].songId, '1');
  const current = await mcp.callTool({ name: 'music_now_playing', arguments: {} });
  assert.equal(current.structuredContent.listening, false, 'login recovery must not invent a phone heartbeat');
  const status = await (await fetch(url + '/api/music/status', { headers: { Authorization: 'Bearer TEST_WEB' } })).json();
  assert.equal(status.connected, true);
  assert.doesNotMatch(JSON.stringify([search, current, status]), /MUSIC_U|TEST_PASSWORD|TEST_ONLY_NETEASE|ENCRYPTION_KEY|"cookie"|v1\./);
});
