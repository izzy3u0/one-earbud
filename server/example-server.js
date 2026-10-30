'use strict';
require('dotenv').config({ quiet: true });
const { createApp } = require('./app');
if (!process.env.ONE_EARBUD_TOKEN) console.warn('[one-earbud] No web access token configured; use only for local testing.');
const { app, authority } = createApp();
const port = Number(process.env.PORT) || 8787;
const server = app.listen(port, '0.0.0.0', () => console.log('[one-earbud] ready on port ' + port));
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
module.exports = { app, authority, server };
