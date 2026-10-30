// Intentionally network-only: never cache auth, APIs, MCP, signed audio URLs or stale JS.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
