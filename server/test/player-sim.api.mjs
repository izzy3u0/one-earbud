export const API_BASE = '/api/music';
export const log = [];
let seq = 0; const nid = () => 'q' + (++seq);
export const server = { items: [], currentId: null, mode: 'seq' };
const Q = () => ({ queue: JSON.parse(JSON.stringify(server)) });
export async function apiRequest(path, opts) {
  opts = opts || {}; const m = (opts.method || 'GET').toUpperCase(); const b = opts.body || {};
  await new Promise(r => setTimeout(r, globalThis.API_DELAY || 0));
  let r;
  if ((r = path.match(/\/music\/song\/(\d+)\/url$/))) { if (r[1] === '5' || r[1] === '55') { const e = new Error('MUSIC_UNAVAILABLE'); e.code = 'MUSIC_UNAVAILABLE'; throw e; } return { url: 'u' + r[1] }; }
  if ((r = path.match(/\/music\/song\/(\d+)$/))) return { song: { songId: r[1], title: 't' + r[1], artist: 'a', durationMs: 10000, lyrics: [] } };
  if (path.endsWith('/music/now-playing')) return {};
  if (path.endsWith('/music/playback-sync')) return Q();
  if (path.endsWith('/music/queue') && m === 'GET') return Q();
  if (path.endsWith('/queue/current')) { server.currentId = b.id; return Q(); }
  if (path.endsWith('/queue/mode')) { server.mode = b.mode; return Q(); }
  if (path.endsWith('/queue/next')) { const i = server.items.findIndex(x => x.id === server.currentId); server.items.splice(i + 1, 0, Object.assign({ id: nid(), addedBy: 'you' }, b.song)); return Q(); }
  if (path.endsWith('/queue/now')) { const i = server.items.findIndex(x => x.id === server.currentId); const it = Object.assign({ id: nid(), addedBy: 'you' }, b.song); server.items.splice(i + 1, 0, it); server.currentId = it.id; return Q(); }
  throw new Error('unmocked ' + m + ' ' + path);
}
export function setItems(ids, mode) { server.items = ids.map(s => ({ id: nid(), songId: String(s), title: 't' + s, artist: 'a', durationMs: 10000, addedBy: 'you' })); server.currentId = server.items[0].id; server.mode = mode || 'seq'; }
