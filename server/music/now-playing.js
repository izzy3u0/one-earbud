'use strict';
// one-earbud 听歌 · 「YOU正在听」。只在内存里，靠前端心跳维持；不落盘。
// 规则：
//   在放 → playing；暂停 → paused，暂停超过 10 分钟不再算；关掉播放条 → 清空；
//   心跳断了 60 秒（PWA 退后台就放不了）→ 当YOU已经不在听。

const HEARTBEAT_STALE_MS = 60 * 1000;
const PAUSE_VISIBLE_MS = 10 * 60 * 1000;
const { randomUUID } = require('node:crypto');

function str(v, max) { const s = v == null ? '' : String(v).trim(); return s.slice(0, max); }

function createNowPlaying(options) {
  const staleMs = (options && options.staleMs) || HEARTBEAT_STALE_MS;
  const pauseMs = (options && options.pauseVisibleMs) || PAUSE_VISIBLE_MS;
  let cur = null;
  const streamId = randomUUID();
  let revision = 0, lease = null;
  function claim(input, nowMs) {
    const sourceId = str(input?.sourceId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(sourceId)) return null;
    const active = input.active === true;
    // A restored/idle tab never takes the microphone from a real playback session.
    if (lease && !lease.closed && lease.sourceId !== sourceId && !active && (lease.active || nowMs - lease.seenAt <= staleMs)) return null;
    if (!lease || lease.closed || lease.sourceId !== sourceId || (active && !lease.active)) {
      lease = { sourceId, sessionId: randomUUID(), sequence: -1, active, seenAt: nowMs, closed: false };
    }
    return { sessionId: lease.sessionId, streamId };
  }
  function ordered(input, nowMs) {
    if (!input?.sessionId) return !lease; // Old hosts work until a versioned phone session exists.
    if (!lease || lease.closed || input.sessionId !== lease.sessionId || input.sourceId !== lease.sourceId ||
      !Number.isSafeInteger(input.sequence) || input.sequence <= lease.sequence) return false;
    lease.sequence = input.sequence; lease.seenAt = nowMs;
    return true;
  }
  function version() { return { streamId, revision, observedAt: cur?.receivedAt ?? null }; }
  return {
    claim,
    version,
    owns(input) { return !!(lease && !lease.closed && lease.sessionId === input.sessionId && lease.sourceId === input.sourceId); },
    canClaim() { return !lease || lease.closed || !lease.active; },
    // 前端每次状态变化和每 ~20 秒心跳都调这个
    report(input, nowMs) {
      const songId = str(input && input.songId, 32);
      if (!/^\d+$/.test(songId)) return false;
      if (!ordered(input, nowMs)) return false;
      const playing = !!(input && input.playing);
      const wasPlaying = cur && cur.songId === songId && cur.playing;
      cur = {
        songId, title: str(input.title, 160), artist: str(input.artist, 160),
        positionMs: Math.max(0, Number(input.positionMs) || 0), durationMs: Math.max(0, Number(input.durationMs) || 0),
        playing,
        pausedAt: playing ? null : (wasPlaying || !cur || cur.songId !== songId || cur.pausedAt == null ? nowMs : cur.pausedAt),
        receivedAt: nowMs
      };
      revision++;
      return true;
    },
    clear(input, nowMs, force = false) {
      if (!force && !ordered(input, nowMs)) return false;
      cur = null; revision++;
      if (lease) lease.closed = true; // Fence delayed reports from a closed session.
      return true;
    },
    // 返回 null（没在听）或 { state: 'playing'|'paused', ...，positionMs 按经过的时间外推 }
    current(nowMs) {
      if (!cur) return null;
      if (nowMs - cur.receivedAt > staleMs) return null;
      if (!cur.playing && cur.pausedAt != null && nowMs - cur.pausedAt > pauseMs) return null;
      const pos = cur.playing ? Math.min(cur.durationMs || Infinity, cur.positionMs + (nowMs - cur.receivedAt)) : cur.positionMs;
      return { ...version(), state: cur.playing ? 'playing' : 'paused', songId: cur.songId, title: cur.title, artist: cur.artist, positionMs: Math.max(0, pos), durationMs: cur.durationMs, pausedAt: cur.pausedAt };
    }
  };
}

module.exports = { createNowPlaying, HEARTBEAT_STALE_MS, PAUSE_VISIBLE_MS };
