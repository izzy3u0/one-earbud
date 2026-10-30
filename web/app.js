import { createMiniBar, openPlayerSheet, openSearchSheet, openQueueSheet, player } from './music/ui.js';
import { apiRequest, API_BASE } from './lib/api.js';
const status = document.querySelector('#status');
const hooks = {
  onNeedLogin: () => { location.href = '/login.html'; },
  onShareSong: song => share(song),
  onShareLines: (song, lines) => share(song, lines)
};
function share(song, lines = []) {
  const text = '我想和你一起听《' + song.title + '》— ' + song.artist + '（songId: ' + song.songId + '）' + (lines.length ? '\n' + lines.map(l => l.text).join('\n') : '');
  const box = document.querySelector('#share'); box.hidden = false;
  box.textContent = text + '\n可复制以上文字发给 ChatGPT。';
  navigator.clipboard?.writeText(text).catch(() => {});
}
async function refreshStatus() {
  try { const s = await apiRequest(API_BASE + '/status'); status.textContent = s.connected ? '网易云已连接，可以搜歌和播放。' : '请先打开网易云扫码登录。'; await player.syncPlayback(); }
  catch (_) { status.textContent = '请填写正确的网页访问口令，再打开网易云扫码登录。'; }
}
document.querySelector('#access').addEventListener('submit', event => {
  event.preventDefault(); localStorage.setItem('one-earbud.token', document.querySelector('#token').value.trim()); document.querySelector('#token').value = ''; refreshStatus();
});
document.querySelector('#bar').append(createMiniBar({ onOpen: () => openPlayerSheet(hooks), onShareSong: hooks.onShareSong }));
document.querySelector('#search').addEventListener('click', () => openSearchSheet(hooks));
document.querySelector('#queue').addEventListener('click', () => openQueueSheet(hooks));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refreshStatus();
