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
  let selection = { mode:'pwa', epoch:0, sourceId:null }, handoff = null, resume = null, pwaSource = null;
  const switches = new Map();
  const snapshot = nowMs => cur ? { ...cur, positionMs:cur.playing ? Math.min(cur.durationMs || Infinity, cur.positionMs + Math.max(0,nowMs-cur.receivedAt)) : cur.positionMs } : null;
  function finish(nowMs) {
    selection = { mode:handoff.target, epoch:selection.epoch+1, sourceId:handoff.target==='chatgpt' ? handoff.sourceId : pwaSource };
    resume = { id:handoff.id, at:nowMs, ...handoff.snapshot };
    if (resume.songId) cur = { ...resume, playing:false, receivedAt:nowMs, pausedAt:nowMs };
    lease = null; handoff = null; revision++;
  }
  function playback() {
    return { ...selection, streamId, ownerSourceId:lease && !lease.closed ? lease.sourceId : null,
      handoff:handoff ? { id:handoff.id, target:handoff.target, sourceId:handoff.sourceId, requestedAt:handoff.requestedAt } : null,
      resume:resume ? { ...resume } : null };
  }
  function claim(input, nowMs) {
    const sourceId = str(input?.sourceId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(sourceId)) return null;
    if ((input.playbackMode || 'pwa') !== selection.mode || handoff ||
      (selection.epoch > 0 && input.modeEpoch !== selection.epoch) ||
      (selection.sourceId && sourceId !== selection.sourceId && !(selection.mode==='pwa' && input.active===true))) return null;
    const active = input.active === true;
    // A restored/idle tab never takes the microphone from a real playback session.
    if (lease && !lease.closed && lease.sourceId !== sourceId && !active && (lease.active || nowMs - lease.seenAt <= staleMs)) return null;
    if (!lease || lease.closed || lease.sourceId !== sourceId || (active && !lease.active)) {
      lease = { sourceId, sessionId: randomUUID(), sequence: -1, active, seenAt: nowMs, closed: false };
    }
    if (selection.mode === 'pwa') pwaSource = sourceId;
    if (selection.mode === 'pwa' && selection.sourceId && input.active===true) selection.sourceId = sourceId;
    return { sessionId: lease.sessionId, streamId, modeEpoch:selection.epoch };
  }
  function ordered(input, nowMs) {
    if (!input?.sessionId) return !lease && selection.epoch === 0; // Fence V1 requests after a mode switch too.
    if (!lease || lease.closed || input.sessionId !== lease.sessionId || input.sourceId !== lease.sourceId ||
      !Number.isSafeInteger(input.sequence) || input.sequence <= lease.sequence) return false;
    lease.sequence = input.sequence; lease.seenAt = nowMs;
    return true;
  }
  function version() { return { streamId, revision, observedAt: cur?.receivedAt ?? null }; }
  return {
    claim,
    version,
    playback,
    switchPlayback(input, nowMs) {
      if (!['pwa','chatgpt'].includes(input.target) || !/^[A-Za-z0-9_-]{8,80}$/.test(input.sourceId || '') || !/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId || '')) return { ok:false, error:'INVALID_SWITCH' };
      const signature = JSON.stringify([input.target,input.sourceId,input.expectedEpoch,input.expectedStreamId]);
      const previous = switches.get(input.requestId);
      if (previous) return previous === signature ? { ok:true, playback:playback() } : { ok:false,error:'REQUEST_ID_CONFLICT' };
      if (input.expectedEpoch !== selection.epoch || input.expectedStreamId !== streamId) return { ok:false,error:'PLAYBACK_CHANGED' };
      if (handoff) {
        if(input.target===selection.mode && handoff.sourceId===input.sourceId) {handoff=null;revision++;return {ok:true,playback:playback()};}
        return { ok:false,error:'HANDOFF_PENDING' };
      }
      if (selection.mode === input.target && (input.target === 'pwa' || selection.sourceId === input.sourceId) && lease && !lease.closed) return { ok:true,playback:playback() };
      handoff = { id:randomUUID(), target:input.target, sourceId:input.sourceId, requestedAt:nowMs, snapshot:snapshot(nowMs) };
      switches.set(input.requestId,signature); if (switches.size > 100) switches.delete(switches.keys().next().value);
      // Never guess that a stale but previously playing endpoint has stopped.
      if ((!lease || lease.closed) && !cur?.playing) finish(nowMs);
      return { ok:true,playback:playback() };
    },
    acknowledgeHandoff(input, nowMs) {
      if (!lease || !handoff || input.handoffId !== handoff.id || !ordered(input,nowMs)) return false;
      if (cur && cur.songId!==handoff.snapshot?.songId) handoff.snapshot=snapshot(nowMs);
      if (/^\d+$/.test(String(input.songId||''))) {
        const same=handoff.snapshot?.songId===String(input.songId),old=handoff.snapshot||{};
        handoff.snapshot={...old,songId:String(input.songId),title:str(input.title??(same?old.title:''),160),artist:str(input.artist??(same?old.artist:''),160),durationMs:Math.max(0,Number(input.durationMs)||(same?old.durationMs:0)||0),playing:typeof input.playing==='boolean'?input.playing:!!old.playing};
      }
      if (handoff.snapshot && Number.isFinite(input.positionMs)) handoff.snapshot.positionMs = Math.max(0,Math.min(handoff.snapshot.durationMs || Infinity,input.positionMs));
      finish(nowMs); return true;
    },
    release(input, nowMs) {
      if (!lease || !ordered(input,nowMs)) return false;
      if (cur) cur = { ...cur, positionMs:Math.max(0,Number(input.positionMs)||0), playing:false, receivedAt:nowMs, pausedAt:nowMs };
      lease.closed = true; revision++;
      if (handoff) finish(nowMs);
      return true;
    },
    owns(input) { return !!(lease && !lease.closed && lease.sessionId === input.sessionId && lease.sourceId === input.sourceId); },
    canClaim() { return selection.mode === 'pwa' && !handoff && (!lease || lease.closed || !lease.active); },
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
      return { ...version(), playbackMode:selection.mode, state: cur.playing ? 'playing' : 'paused', songId: cur.songId, title: cur.title, artist: cur.artist, positionMs: Math.max(0, pos), durationMs: cur.durationMs, pausedAt: cur.pausedAt };
    }
  };
}

module.exports = { createNowPlaying, HEARTBEAT_STALE_MS, PAUSE_VISIBLE_MS };
