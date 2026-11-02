'use strict';
// Single-owner OAuth bridge for ChatGPT, using the SDK's discovery, PKCE, DCR and token routes.
const { randomBytes, createHash } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { tokenMatches } = require('./auth');
const { createFileOAuthStore } = require('./oauth-store');
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

function mountOAuth(app, { publicUrl, token, dataDir, store = createFileOAuthStore({ dataDir }), now = Date.now, diagnostic = event => console.info('[one-earbud:oauth] ' + event) }) {
  const resource = publicUrl + '/mcp';
  const owner = digest(token);
  function scoped(fn) {
    return saved => {
      // Rotation and audience changes still invalidate grants; storage migration does not.
      if (saved.owner !== owner || saved.resource !== resource) {
        Object.assign(saved, { clients: {}, tokens: {}, pending: {}, codes: {}, owner, resource });
      }
      saved.pending ||= {}; saved.codes ||= {};
      return fn(saved);
    };
  }
  const read = fn => store.read(scoped(fn));
  const change = fn => store.change(scoped(fn));
  function prune(saved) {
    for (const map of [saved.tokens, saved.pending, saved.codes]) {
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
  function grant(saved, clientId) {
    prune(saved);
    if (Object.keys(saved.tokens).length > 1000) throw new InvalidGrantError('Too many active grants');
    const access = random(), refresh = random();
    saved.tokens[digest(access)] = { clientId, kind: 'access', expiresAt: now() + 3600000 };
    saved.tokens[digest(refresh)] = { clientId, kind: 'refresh', expiresAt: now() + 30 * 86400000 };
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'music' };
  }
  function codeFor(saved, client, code) {
    const entry = saved.codes[digest(code)];
    if (!entry || entry.expiresAt <= now() || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired code');
    return entry;
  }
  const provider = {
    clientsStore: {
      getClient(id) { return read(saved => {
        const client = Object.hasOwn(saved.clients, id) ? saved.clients[id] : undefined;
        if (!client) diagnostic('client_unknown');
        return client;
      }); },
      registerClient(client) {
        return change(saved => {
          if (!client.redirect_uris.length || !client.redirect_uris.every(allowedRedirect) || Object.keys(saved.clients).length >= 100) throw new InvalidClientMetadataError('Unsupported redirect URI or client limit reached');
          const entry = { ...client, client_id: random(), client_id_issued_at: Math.floor(now() / 1000) };
          saved.clients[entry.client_id] = entry; return entry;
        });
      }
    },
    async authorize(client, params, res) {
      checkResource(params.resource);
      if ((params.scopes || []).some(s => s !== 'music')) throw new InvalidScopeError('Only music is supported');
      const nonce = random();
      await change(saved => {
        prune(saved);
        if (Object.keys(saved.pending).length >= 100) throw new InvalidGrantError('Too many pending authorizations');
        saved.pending[digest(nonce)] = { clientId: client.client_id, ...params, resource: String(params.resource), expiresAt: now() + 300000 };
      });
      // Chromium applies form-action to the 303 callback too. Only allow the origin
      // of the exact redirect already validated against this registered client.
      const callbackOrigin = new URL(params.redirectUri).origin;
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self' " + callbackOrigin + "; frame-ancestors 'none'; base-uri 'none'" });
      // Carry the request in the action as well as the hidden field: in-app form
      // handlers must not lose the authorization when forwarding visible inputs.
      res.type('html').send('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 one-earbud</title><h1>允许 ChatGPT 使用你的听歌工具</h1><p>授权读取歌曲、歌词和播放列表，以及加歌和切歌。只在你主动连接时填写 MCP_AUTH_TOKEN；不要填写网易云密码或网页口令。</p><form method="post" action="/oauth/consent?request_id=' + nonce + '"><input type="hidden" name="nonce" value="' + nonce + '"><label>MCP 访问口令 <input type="password" name="token" required autocomplete="off"></label><button type="submit">授权连接</button></form></html>');
    },
    async challengeForAuthorizationCode(client, code) { return read(saved => codeFor(saved, client, code).codeChallenge); },
    async exchangeAuthorizationCode(client, code, verifier, redirectUri, target) {
      const entry = await change(saved => {
        const entry = codeFor(saved, client, code);
        delete saved.codes[digest(code)]; // single use, even if the resource/redirect check fails
        return entry;
      });
      checkResource(target);
      if (redirectUri !== entry.redirectUri) throw new InvalidGrantError('Redirect URI mismatch');
      return change(saved => grant(saved, client.client_id));
    },
    async exchangeRefreshToken(client, refresh, scopes, target) {
      try {
        // RFC 8707 permits omission on refresh: inherit this grant's sole audience.
        // An explicit different resource is always rejected, never broadened.
        if (target !== undefined) checkResource(target);
        if (scopes && scopes.some(s => s !== 'music')) throw new InvalidScopeError('Only music is supported');
        const result = await change(saved => {
          const entry = saved.tokens[digest(refresh)];
          if (!entry || entry.kind !== 'refresh' || entry.clientId !== client.client_id || entry.expiresAt <= now()) throw new InvalidGrantError('Invalid refresh token');
          delete saved.tokens[digest(refresh)];
          return grant(saved, client.client_id);
        });
        diagnostic('refresh_issued');
        return result;
      } catch (error) {
        diagnostic(error.code === 'OAUTH_STORAGE_UNAVAILABLE' ? 'storage_unavailable' : 'refresh_rejected');
        throw error;
      }
    },
    async verifyAccessToken(access) {
      return read(saved => {
        const entry = saved.tokens[digest(access)];
        if (!entry || entry.kind !== 'access' || entry.expiresAt <= now()) {
          diagnostic(entry?.kind === 'access' && entry.expiresAt <= now() ? 'access_expired' : 'access_unknown');
          throw new InvalidTokenError('Invalid access token');
        }
        return { token: access, clientId: entry.clientId, scopes: ['music'], expiresAt: Math.floor(entry.expiresAt / 1000), resource: new URL(resource) };
      });
    },
    async revokeToken(client, request) {
      return change(saved => {
        const key = digest(request.token);
        if (saved.tokens[key]?.clientId === client.client_id) delete saved.tokens[key];
      });
    }
  };
  app.post('/oauth/consent', rateLimit({ windowMs: 900000, limit: 20, standardHeaders: true, legacyHeaders: false }), express.urlencoded({ extended: false, limit: '4kb' }), async (req, res, next) => {
    try {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const fail = (reason, message) => res.set('X-One-Earbud-OAuth-Error', reason).status(400).send(message);
    const nonce = req.query.request_id ?? req.body.nonce;
    if (!nonce) return fail('missing_request', '授权请求标识缺失，请关闭此页并从 ChatGPT 重新连接。');
    if (typeof nonce !== 'string' || (req.body.nonce !== undefined && req.body.nonce !== nonce)) return fail('invalid_request', '授权请求标识不一致，请从 ChatGPT 重新连接。');
    const code = random();
    const result = await change(saved => {
      const key = digest(nonce), entry = saved.pending[key];
      if (!entry) return { error: 'request_unavailable' };
      if (entry.expiresAt <= now()) { delete saved.pending[key]; return { error: 'request_expired' }; }
      if (!tokenMatches(req.body.token, token)) return { error: 'owner_mismatch' };
      delete saved.pending[key];
      saved.codes[digest(code)] = { ...entry, expiresAt: now() + 60000 };
      return { entry };
    });
    if (result.error === 'request_unavailable') return fail(result.error, '授权请求已使用或服务状态已重置，请关闭此页并从 ChatGPT 重新连接。');
    if (result.error === 'request_expired') return fail(result.error, '授权已过期，请从 ChatGPT 重新连接。');
    if (result.error === 'owner_mismatch') return res.status(401).send('MCP 口令不正确。请返回授权页重试。');
    const { entry } = result;
    const redirect = new URL(entry.redirectUri);
    redirect.searchParams.set('code', code);
    if (entry.state !== undefined) redirect.searchParams.set('state', entry.state);
    res.redirect(303, redirect.href);
    } catch (error) { next(error); }
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: new URL(resource), scopesSupported: ['music'], resourceName: 'one-earbud' }));
  return { async verify(access) {
    if (!access) return false;
    try { await provider.verifyAccessToken(access); return true; }
    catch (error) { if (error instanceof InvalidTokenError) return false; throw error; }
  } };
}
module.exports = { mountOAuth };
