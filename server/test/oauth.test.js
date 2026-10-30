'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const { mountOAuth } = require('../oauth');

const OWNER = 'oauth-test-owner-placeholder';
const ORIGIN = 'https://music.example.test';
const RESOURCE = ORIGIN + '/mcp';
const VERIFIER = 'oauth-regression-verifier-with-more-than-forty-three-characters';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const CALLBACKS = ['https://chatgpt.com/connector/oauth/test-callback', 'https://chatgpt.com/connector_platform_oauth_redirect'];

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-earbud-oauth-'));
  let server, base, now = Date.now();
  const close = async () => { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } };
  const boot = async () => {
    await close();
    const app = express();
    app.use(express.json());
    mountOAuth(app, { publicUrl: ORIGIN, token: OWNER, dataDir: dir, now: () => now });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
  };
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await boot();
  const post = (route, body, json = false) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body) });
  const register = async callback => {
    const r = await post('/register', { redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, true);
    assert.equal(r.status, 201);
    return r.json();
  };
  const begin = async (client, callback, overrides = {}, method = 'GET') => {
    const params = { client_id: client.client_id, redirect_uri: callback, resource: RESOURCE, response_type: 'code', code_challenge_method: 'S256', code_challenge: CHALLENGE, scope: 'music', state: 'state with + / = 中文', ...overrides };
    const response = method === 'POST' ? await post('/authorize', params) : await fetch(base + '/authorize?' + new URLSearchParams(params), { redirect: 'manual' });
    const html = await response.text();
    return { response, html, nonce: /name="nonce" value="([^"]+)"/.exec(html)?.[1], action: /<form[^>]+action="([^"]+)"/.exec(html)?.[1] };
  };
  const exchange = (client, callback, code, overrides = {}) => post('/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource: RESOURCE, code, code_verifier: VERIFIER, ...overrides });
  return { dir, boot, post, register, begin, exchange, tick(ms) { now += ms; } };
}

test('OAuth keeps request parameters and single-use codes through process restarts for both ChatGPT callbacks', async t => {
  for (const callback of CALLBACKS) await t.test(callback, async t => {
    const f = await fixture(t);
    const client = await f.register(callback);
    const form = await f.begin(client, callback, {}, callback === CALLBACKS[0] ? 'GET' : 'POST');
    assert.equal(form.response.status, 200);
    assert.ok(form.nonce);
    await f.boot(); // Simulates the process losing all in-memory maps after showing the form.
    assert.equal((await f.post('/oauth/consent', { nonce: form.nonce, token: 'wrong-owner-token' })).status, 401);
    const approved = await f.post('/oauth/consent', { nonce: form.nonce, token: OWNER });
    assert.equal(approved.status, 303);
    const redirect = new URL(approved.headers.get('location'));
    assert.equal(redirect.origin + redirect.pathname, callback);
    assert.equal(redirect.searchParams.get('state'), 'state with + / = 中文');
    const code = redirect.searchParams.get('code');
    const privateState = fs.readFileSync(path.join(f.dir, 'oauth-state.json'), 'utf8');
    for (const secret of [OWNER, form.nonce, code]) assert.equal(privateState.includes(secret), false);
    await f.boot(); // Code exchange can reach a newly started process too.
    assert.equal((await f.post('/oauth/consent', { nonce: form.nonce, token: OWNER })).status, 400);
    assert.equal((await f.exchange(client, callback, code, { code_verifier: 'incorrect' })).status, 400);
    const response = await f.exchange(client, callback, code);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.notEqual(tokens.access_token, OWNER);
    await f.boot();
    assert.equal((await f.exchange(client, callback, code)).status, 400);
    assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token })).status, 200);
  });
});

test('OAuth form carries its request in the action URL and permits its validated callback redirect', async t => {
  const f = await fixture(t), callback = CALLBACKS[0];
  const client = await f.register(callback);
  const form = await f.begin(client, callback);
  assert.equal(form.response.headers.get('cache-control'), 'no-store');
  const csp = form.response.headers.get('content-security-policy');
  const sources = /(?:^|;)\s*form-action\s+([^;]+)/.exec(csp)[1].split(/\s+/);
  assert.ok(sources.includes("'self'"));
  assert.ok(sources.includes('https://chatgpt.com')); // Chromium checks form-action on 303 redirects too.
  assert.ok(!sources.includes('*'));
  assert.match(csp, /frame-ancestors 'none'/);
  const action = new URL(form.action, ORIGIN);
  assert.equal(action.searchParams.get('request_id'), form.nonce);
  assert.doesNotMatch(form.html + form.action, /oauth-test-owner-placeholder/);
  // In-app form handlers can drop hidden fields: the request must still survive.
  assert.equal((await f.post(action.pathname + action.search, { token: OWNER })).status, 303);
});

test('OAuth distinguishes missing requests from real expiry; TTL uses epoch milliseconds across restarts', async t => {
  const f = await fixture(t), callback = CALLBACKS[0];
  const client = await f.register(callback);
  const form = await f.begin(client, callback);
  const missing = await f.post('/oauth/consent', { token: OWNER });
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get('x-one-earbud-oauth-error'), 'missing_request');
  f.tick(299999);
  await f.boot();
  assert.equal((await f.post('/oauth/consent', { nonce: form.nonce, token: 'wrong' })).status, 401);
  f.tick(1);
  const expired = await f.post('/oauth/consent', { nonce: form.nonce, token: OWNER });
  assert.equal(expired.status, 400);
  assert.equal(expired.headers.get('x-one-earbud-oauth-error'), 'request_expired');
  const fresh = await f.begin(client, callback);
  const approved = await f.post('/oauth/consent', { nonce: fresh.nonce, token: OWNER });
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  f.tick(60000);
  assert.equal((await f.exchange(client, callback, code)).status, 400);
});

test('OAuth rejects tampered request IDs, unregistered redirects, wrong clients and resource changes', async t => {
  const f = await fixture(t), callback = CALLBACKS[0];
  const a = await f.register(callback), b = await f.register(CALLBACKS[1]);
  assert.equal((await f.begin(a, 'https://evil.example.test/callback')).response.status, 400);
  assert.equal((await f.begin(a, callback, { client_id: 'unknown-client' })).response.status, 400);
  const form = await f.begin(a, callback);
  assert.equal((await f.post('/oauth/consent?request_id=not-the-form', { nonce: form.nonce, token: OWNER })).status, 400);
  const approved = await f.post('/oauth/consent', { nonce: form.nonce, token: OWNER, redirect_uri: 'https://evil.example.test/callback', state: 'tampered', code_challenge: 'tampered' });
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), 'state with + / = 中文');
  const code = redirect.searchParams.get('code');
  assert.equal((await f.exchange(b, CALLBACKS[1], code)).status, 400);
  assert.equal((await f.exchange(a, callback, code, { resource: 'https://evil.example.test/mcp' })).status, 400);
  assert.equal((await f.exchange(a, callback, code)).status, 400); // Failed resource check consumed the code.
});

test('OAuth upgrades existing state without rotating the owner token; filesystem resets fail safely and allow fresh DCR', async t => {
  const f = await fixture(t), callback = CALLBACKS[0];
  const client = await f.register(callback);
  const form = await f.begin(client, callback, { state: '' });
  const approved = await f.post('/oauth/consent', { nonce: form.nonce, token: OWNER });
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), '');
  const tokens = await (await f.exchange(client, callback, redirect.searchParams.get('code'))).json();
  const file = path.join(f.dir, 'oauth-state.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.pending; delete legacy.codes;
  fs.writeFileSync(file, JSON.stringify(legacy));
  await f.boot();
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token };
  assert.equal((await f.post('/token', refresh)).status, 200);
  const next = await f.begin(client, callback);
  fs.unlinkSync(file); // Free instance filesystem reset, unlike a process-only restart.
  await f.boot();
  const missing = await f.post('/oauth/consent', { nonce: next.nonce, token: OWNER });
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get('x-one-earbud-oauth-error'), 'request_unavailable');
  assert.equal((await f.begin(client, callback)).response.status, 400);
  const replacement = await f.register(callback);
  const fresh = await f.begin(replacement, callback);
  assert.equal((await f.post(fresh.action, { token: OWNER })).status, 303);
});
