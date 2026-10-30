'use strict';
const path = require('node:path');
const express = require('express');
const { createMusicAuthority } = require('./music/authority');
const { mountMusicRoutes } = require('./music/routes');
const { mountMcp } = require('./mcp');
const { mountOAuth } = require('./oauth');
const { bearer, tokenMatches } = require('./auth');

function createApp(options = {}) {
  const token = options.token ?? process.env.ONE_EARBUD_TOKEN ?? '';
  const mcpToken = options.mcpToken ?? process.env.MCP_AUTH_TOKEN ?? '';
  const publicUrl = (options.publicUrl ?? (process.env.MCP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '')).replace(/\/$/, '');
  if (publicUrl && new URL(publicUrl).origin !== publicUrl) throw new Error('MCP_PUBLIC_URL must be an origin without a path');
  if (mcpToken && (!token || token === mcpToken)) throw new Error('Set distinct ONE_EARBUD_TOKEN and MCP_AUTH_TOKEN');
  if ((process.env.RENDER || process.env.NODE_ENV === 'production') && !token) throw new Error('ONE_EARBUD_TOKEN is required in production');
  const authority = options.authority || createMusicAuthority();
  const app = express();
  if (process.env.RENDER) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
  const router = express.Router();
  router.use((req, res, next) => {
    if (token && !tokenMatches(bearer(req), token)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: '请先填写网页访问口令' });
    next();
  });
  mountMusicRoutes(router, authority);
  app.use('/api', router);
  const oauth = publicUrl && mcpToken ? mountOAuth(app, { publicUrl, token: mcpToken, dataDir: options.dataDir }) : null;
  mountMcp(app, { authority, token: mcpToken, publicUrl, oauth });
  app.use(express.static(path.join(__dirname, '..', 'web'), { setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ ok: false, error: 'REQUEST_FAILED' });
  });
  return { app, authority };
}
module.exports = { createApp };
