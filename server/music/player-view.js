'use strict';
// Presentation only: all music/lyrics/freshness comes from the existing authority/tool.
const { z } = require('zod');
const COVER_ORIGINS = Array.from({ length: 10 }, (_, i) => 'https://p' + (i + 1) + '.music.126.net');
function safeCover(value) {
  try {
    const u = new URL(value);
    return !u.username && !u.password && COVER_ORIGINS.includes(u.origin) ? u.href : '';
  } catch (_) { return ''; }
}
const songSchema = z.object({ songId: z.string(), title: z.string(), artist: z.string(), coverUrl: z.string(), durationMs: z.number() });
const lineSchema = z.object({ index: z.number(), timeMs: z.number(), text: z.string(), trans: z.string().optional() }).nullable();
const playerViewSchema = z.object({
  ok: z.literal(true), kind: z.literal('one-earbud-player'), sampledAt: z.number(),
  streamId: z.string().optional(), revision: z.number().optional(), observedAt: z.number().nullable().optional(),
  playback: z.object({ mode:z.enum(['pwa','chatgpt']), epoch:z.number(), streamId:z.string(), sourceId:z.string().nullable(), ownerSourceId:z.string().nullable(), handoff:z.any().nullable(), resume:z.any().nullable() }).optional(),
  fresh: z.boolean(), state: z.enum(['playing', 'paused', 'unknown']),
  current: songSchema.nullable(), prepared: songSchema.nullable(), positionMs: z.number(),
  lyricContext: z.object({ previous: lineSchema, current: lineSchema, next: lineSchema }).nullable(),
  queue: z.object({ count: z.number(), mode: z.string() })
});

function createPlayerView({ authority, tool }) {
  const covers = new Map();
  async function coverFor(songId, queued) {
    const found = safeCover(queued?.coverUrl);
    if (found) return found;
    const cached = covers.get(songId);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = Promise.resolve().then(() => authority.song(songId)).then(song => safeCover(song.coverUrl)).catch(() => '');
    covers.set(songId, { value, until: Date.now() + 60000 });
    if (covers.size > 20) covers.delete(covers.keys().next().value);
    return value;
  }
  function song(value, coverUrl = '') {
    return { songId: String(value.songId), title: String(value.title || ''), artist: String(value.artist || ''), coverUrl, durationMs: Math.max(0, Number(value.durationMs) || 0) };
  }
  return async function view() {
    let playing = await tool.handler({ action: 'now_playing' });
    let q = authority.queue.get();
    let current = null;
    if (playing.listening && playing.fresh) {
      const coverUrl = await coverFor(playing.songId, q.items.find(x => x.songId === playing.songId));
      // A network fetch must not revive a heartbeat that expired/switched meanwhile.
      const latest = await tool.handler({ action: 'now_playing' });
      if (latest.listening && latest.fresh) current = song(latest, latest.songId === playing.songId ? coverUrl : safeCover(q.items.find(x => x.songId === latest.songId)?.coverUrl));
      playing = latest;
    }
    q = authority.queue.get();
    const playback = authority.playbackOwner?.();
    // A handoff is a prepared snapshot, not a fresh phone heartbeat. Keep it
    // even for single/preview songs absent from the shared queue.
    const saved = playback?.handoff?.snapshot;
    const prepared = saved || (!current && playback?.resume?.songId ? playback.resume : null) || q.items.find(x => x.id === q.currentId);
    return {
      ok: true, kind: 'one-earbud-player', sampledAt: Date.now(), fresh: !!current,
      streamId:playing.streamId, revision:playing.revision, observedAt:playing.observedAt,
      playback,
      state: current ? playing.state : 'unknown', current,
      prepared: (!current || saved) && prepared ? song(prepared, safeCover(prepared.coverUrl || q.items.find(x=>x.songId===prepared.songId)?.coverUrl)) : null,
      positionMs: saved ? saved.positionMs : current ? playing.positionMs : playback?.resume?.positionMs || 0,
      lyricContext: current ? playing.lyricContext || null : null,
      queue: { count: q.items.length, mode: q.mode }
    };
  };
}
module.exports = { createPlayerView, playerViewSchema, COVER_ORIGINS, safeCover };
