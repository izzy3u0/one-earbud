'use strict';
// UI controls send bounded commands to the existing phone player, not a second queue/player.
function createPlayerControls({ authority }) {
  const requests = new Map();
  return function control({ action, expectedSongId, requestId }) {
    const existing = requests.get(requestId);
    if (existing) {
      if (existing.action !== action || existing.songId !== expectedSongId) return { ok: false, error: 'REQUEST_ID_CONFLICT', message: '同一请求标识不能用于不同操作。' };
      return existing.result;
    }
    const playing = authority.nowPlaying();
    if (!playing || playing.songId !== expectedSongId) return { ok: false, error: 'PLAYER_STALE', message: '手机状态已变化或不再新鲜，请刷新卡片；需要时回到手机 PWA 点播放。' };
    const sync = authority.playbackSync();
    if (sync.command && !sync.command.action && sync.queue.items.find(x => x.id === sync.command.itemId)?.songId !== expectedSongId) return { ok:false, error:'PLAYER_STALE', message:'手机正在切换歌曲，请稍后刷新卡片。' };
    const playback = authority.requestPlayerControl(action, expectedSongId);
    const result = { ok: true, action, playback, message: '指令已发送，等待手机同步；以手机回报状态为准。首次播放或 Safari 限制时仍需在 PWA 点播放。' };
    requests.set(requestId, { action, songId: expectedSongId, result });
    if (requests.size > 100) requests.delete(requests.keys().next().value);
    return result;
  };
}
module.exports = { createPlayerControls };
