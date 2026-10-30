'use strict';
// Single-owner OAuth bridge for ChatGPT, using the SDK's discovery, PKCE, DCR and token routes.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { tokenMatches } = require('./auth');
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

function mountOAuth(app, { publicUrl, token, dataDir, now = Date.now }) {
  const resource = publicUrl + '/mcp';
  const file = path.join(dataDir || process.env.ONE_EARBUD_DATA_DIR || path.join(__dirname, '..', 'data'), 'oauth-state.json');
  let saved = { clients: {}, tokens: {} };
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('OAuth state could not be loaded'); }
  // Rotating the owner token also invalidates OAuth grants.
  if (saved.owner !== digest(token) || saved.resource !== resource) saved = { clients: {}, tokens: {}, owner: digest(token), resource };
  // Keep all stages together: an in-memory-only form/code dies on a process restart.
  // Backwards compatible with existing client registrations and token hashes.
  const pending = saved.pending ||= {}, codes = saved.codes ||= {};
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + random();
    fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  function prune() {
    for (const map of [saved.tokens, pending, codes]) {
      for (const [key, value] of Object.entries(map)) if (value.expiresAt <= now()) delete map[key];
    }
  }
  const extras = (process.env.MCP_OAUTH_REDIRECT_URIS || '').split(',').map(x => x.trim()).filter(Boolean);
  function allowedRedirect(value) {
    if (extras.includes(value)) return true;
    try {
      const u = new URL(value);
      return u.origin === 'https://chatgpt.com' && !u.search && !u.hash &&
        (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
    } catch (_) { return false; }
  }
  function checkResource(value) {
    if (!value || String(value) !== resource) throw new InvalidTargetError('Expected this server MCP resource');
  }
  function grant(clientId) {
    prune();
    if (Object.keys(saved.tokens).length > 1000) throw new InvalidGrantError('Too many active grants');
    const access = random(), refresh = random();
    saved.tokens[digest(access)] = { clientId, kind: 'access', expiresAt: now() + 3600000 };
    saved.tokens[digest(refresh)] = { clientId, kind: 'refresh', expiresAt: now() + 30 * 86400000 };
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'music' };
  }
  function codeFor(client, code) {
    const entry = codes[digest(code)];
    if (!entry || entry.expiresAt <= now() || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired code');
    return entry;
  }
  const provider = {
    clientsStore: {
      getClient(id) { return Object.hasOwn(saved.clients, id) ? saved.clients[id] : undefined; },
      registerClient(client) {
        if (!client.redirect_uris.length || !client.redirect_uris.every(allowedRedirect) || Object.keys(saved.clients).length >= 100) throw new InvalidClientMetadataError('Unsupported redirect URI or client limit reached');
        const entry = { ...client, client_id: random(), client_id_issued_at: Math.floor(now() / 1000) };
        saved.clients[entry.client_id] = entry; save(); return entry;
      }
    },
    async authorize(client, params, res) {
      checkResource(params.resource);
      if ((params.scopes || []).some(s => s !== 'music')) throw new InvalidScopeError('Only music is supported');
      prune();
      if (Object.keys(pending).length >= 100) throw new InvalidGrantError('Too many pending authorizations');
      const nonce = random();
      pending[digest(nonce)] = { clientId: client.client_id, ...params, resource: String(params.resource), expiresAt: now() + 300000 };
      save();
      // Chromium applies form-action to the 303 callback too. Only allow the origin
      // of the exact redirect already validated against this registered client.
      const callbackOrigin = new URL(params.redirectUri).origin;
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self' " + callbackOrigin + "; frame-ancestors 'none'; base-uri 'none'" });
      // Carry the request in the action as well as the hidden field: in-app form
      // handlers must not lose the authorization when forwarding visible inputs.
      res.type('html').send('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 one-earbud</title><h1>允许 ChatGPT 使用你的听歌工具</h1><p>授权读取歌曲、歌词和播放列表，以及加歌和切歌。只在你主动连接时填写 MCP_AUTH_TOKEN；不要填写网易云密码或网页口令。</p><form method="post" action="/oauth/consent?request_id=' + nonce + '"><input type="hidden" name="nonce" value="' + nonce + '"><label>MCP 访问口令 <input type="password" name="token" required autocomplete="off"></label><button type="submit">授权连接</button></form></html>');
    },
    async challengeForAuthorizationCode(client, code) { return codeFor(client, code).codeChallenge; },
    async exchangeAuthorizationCode(client, code, verifier, redirectUri, target) {
      const entry = codeFor(client, code);
      delete codes[digest(code)]; // single use, even if the resource/redirect check fails
      save();
      checkResource(target);
      if (redirectUri !== entry.redirectUri) throw new InvalidGrantError('Redirect URI mismatch');
      return grant(client.client_id);
    },
    async exchangeRefreshToken(client, refresh, scopes, target) {
      checkResource(target);
      const entry = saved.tokens[digest(refresh)];
      if (!entry || entry.kind !== 'refresh' || entry.clientId !== client.client_id || entry.expiresAt <= now()) throw new InvalidGrantError('Invalid refresh token');
      if (scopes && scopes.some(s => s !== 'music')) throw new InvalidScopeError('Only music is supported');
      delete saved.tokens[digest(refresh)];
      return grant(client.client_id);
    },
    async verifyAccessToken(access) {
      const entry = saved.tokens[digest(access)];
      if (!entry || entry.kind !== 'access' || entry.expiresAt <= now()) throw new InvalidTokenError('Invalid access token');
      return { token: access, clientId: entry.clientId, scopes: ['music'], expiresAt: Math.floor(entry.expiresAt / 1000), resource: new URL(resource) };
    },
    async revokeToken(client, request) {
      const key = digest(request.token);
      if (saved.tokens[key]?.clientId === client.client_id) { delete saved.tokens[key]; save(); }
    }
  };
  app.post('/oauth/consent', rateLimit({ windowMs: 900000, limit: 20, standardHeaders: true, legacyHeaders: false }), express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const fail = (reason, message) => res.set('X-One-Earbud-OAuth-Error', reason).status(400).send(message);
    const nonce = req.query.request_id ?? req.body.nonce;
    if (!nonce) return fail('missing_request', '授权请求标识缺失，请关闭此页并从 ChatGPT 重新连接。');
    if (typeof nonce !== 'string' || (req.body.nonce !== undefined && req.body.nonce !== nonce)) return fail('invalid_request', '授权请求标识不一致，请从 ChatGPT 重新连接。');
    const key = digest(nonce), entry = pending[key];
    if (!entry) return fail('request_unavailable', '授权请求已使用或服务状态已重置，请关闭此页并从 ChatGPT 重新连接。');
    if (entry.expiresAt <= now()) {
      delete pending[key]; save();
      return fail('request_expired', '授权已过期，请从 ChatGPT 重新连接。');
    }
    if (!tokenMatches(req.body.token, token)) return res.status(401).send('MCP 口令不正确。请返回授权页重试。');
    delete pending[key];
    const code = random(); codes[digest(code)] = { ...entry, expiresAt: now() + 60000 };
    save();
    const redirect = new URL(entry.redirectUri);
    redirect.searchParams.set('code', code);
    if (entry.state !== undefined) redirect.searchParams.set('state', entry.state);
    res.redirect(303, redirect.href);
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: new URL(resource), scopesSupported: ['music'], resourceName: 'one-earbud' }));
  return { async verify(access) { try { await provider.verifyAccessToken(access); return true; } catch (_) { return false; } } };
}
module.exports = { mountOAuth };
