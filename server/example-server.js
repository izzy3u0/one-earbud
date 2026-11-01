'use strict';
require('dotenv').config({ quiet: true });
const { createApp } = require('./app');
const { createMusicAuthority } = require('./music/authority');
const { prepareMusicAuthStore } = require('./music/postgres-auth');
async function start() {
  if (!process.env.ONE_EARBUD_TOKEN) console.warn('[one-earbud] No web access token configured; use only for local testing.');
  const store = await prepareMusicAuthStore();
  if (process.env.RENDER && !process.env.ONE_EARBUD_AUTH_DATABASE_URL) console.warn('[one-earbud] NetEase auth uses temporary storage; configure external auth storage to survive redeploys.');
  const { app, authority } = createApp({ authority: createMusicAuthority({ store }) });
  const port = Number(process.env.PORT) || 8787;
  const server = app.listen(port, '0.0.0.0', () => console.log('[one-earbud] ready on port ' + port));
  function shutdown() {
    server.close(async () => { if (store.close) await store.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { app, authority, server };
}
if (require.main === module) start().catch(() => { console.error('[one-earbud] Startup failed; check access tokens and auth storage configuration.'); process.exitCode = 1; });
module.exports = { start };
