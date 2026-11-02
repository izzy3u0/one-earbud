// one-earbud 听歌 · 全局播放器。
// 单例：audio 元素挂在 body 上，路由切换不销毁，所以换页歌不停。
// 状态变化立刻报给服务器（「YOU正在听」），在放的时候每 20 秒心跳一次；关掉就清空。
// PWA 退后台放不了，心跳自然会断，服务器 60 秒后当YOU不在听。
import { apiRequest, API_BASE } from '../lib/api.js';

const HEARTBEAT_MS = 20000;

const state = {
  song: null,        // { songId, title, artist, album, coverUrl, durationMs }
  lyrics: [],        // [{ index, timeMs, text, trans }]
  playing: false,
  loading: false,
  buffering: false,  // 调了 play() 但还没出声（缓冲/网卡）；真出声那一刻才撤
  error: '',
  closed: true,
  queueItemId: null  // 在放的是播放列表里的哪一项；从卡片点开的单曲是 null，放完就停
};
const listeners = new Set();
let audio = null;
let hasPlaybackSession = false; // Set only after the phone actually emitted `playing`.
let heartbeat = 0;
const reportSource = 'phone-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
let reportSequence = 0, reportLease = null, reportPending = null, reportFlight = null, mayClaim = true;
let mediaSongId = null, playGeneration = 0, suspended = false;
let playbackSelection = { mode:'pwa',epoch:0 }, playbackKnown = false, handoffBusy = false, lastResume = null;
let handoffStop = null;
function pwaSelected() { return playbackSelection.mode === 'pwa' && !handoffBusy; }
function requirePwa() { if(!playbackKnown || !pwaSelected()){state.error=playbackKnown?'当前播放端是 ChatGPT，请先在卡片切回手机 PWA':'正在确认播放端，请稍后再点播放';emit();if(!playbackKnown)syncPlayback();return false;}return true; }
async function confirmPwa() { if(!playbackKnown)await syncPlayback();return requirePwa(); }
let urlFetchedAt = 0;
// 下一首提前备好：快放完时先把下一首的详情和地址要回来，
// 这首一停直接换上，不再「放完才去问服务器」。
const PREFETCH_BEFORE_MS = 25000;
let prefetched = null;   // { itemId, songId, detail, url, at }
let prefetchFor = null;  // 这一首已经起过预取了，别每次 timeupdate 都起
// 退出 PWA 再进来，听歌栏还在：只记在放哪首、是列表里哪一项；不记听到哪儿。
// 只有点听歌栏上的 × 才算真的不听了，那时候才清掉。
const LAST_KEY = 'one-earbud.last';
function saveLast() {
  try {
    if (!state.song || state.closed) { localStorage.removeItem(LAST_KEY); return; }
    const s = state.song;
    localStorage.setItem(LAST_KEY, JSON.stringify({ song: { songId: s.songId, title: s.title, artist: s.artist, coverUrl: s.coverUrl, durationMs: s.durationMs }, queueItemId: state.queueItemId || null }));
  } catch (_) {}
}
function restoreLast() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (!v || !v.song || !/^\d+$/.test(String(v.song.songId || ''))) return;
    state.song = v.song; state.queueItemId = v.queueItemId || null;
    state.closed = false; state.playing = false;
    // 苹果不许网页自己出声：栏以暂停的样子出现，YOU点播放就从头放这一首
  } catch (_) {}
}
restoreLast();
let stallT = -1, stallSince = 0, stallTries = 0, watchdogTimer = 0, syncTimer = 0;
function watchPlayback() {
  if (!audio || !state.song || audio.paused || state.loading) { stallSince = 0; return; }
  const t = audio.currentTime;
  if (t !== stallT) { stallT = t; stallSince = Date.now(); stallTries = 0; return; }
  if (stallSince && Date.now() - stallSince > 8000 && stallTries < 2) { stallTries++; stallSince = Date.now(); recover({ play: true }); }
}
if (typeof window !== 'undefined') watchdogTimer = setInterval(watchPlayback, 2000);
if (typeof window !== 'undefined') window.addEventListener('online', () => { if (state.song && state.error) { state.error = ''; emit(); if (audio && audio.getAttribute('src')) recover(); } fillDetail(); });
// 苹果只认手势里同步调用的 play()：要是点了才去服务器拿地址，拿回来已经不算YOU点的了，就会被拦。
// 所以恢复出来的这首先把地址备好，挂在 audio 上但不放。
async function warmRestored() {
  if (!state.song || state.closed || (audio && audio.getAttribute('src'))) return;
  const songId = state.song.songId;
  const generation = playGeneration;
  try {
    const [detail, url] = await Promise.all([apiRequest(API_BASE + '/song/' + encodeURIComponent(songId)).then(r => r.song), loadUrl(songId)]);
    if (generation !== playGeneration || state.closed || !state.song || state.song.songId !== songId || (audio && audio.getAttribute('src'))) return;
    ensureAudio();
    state.song = { songId, title: detail.title, artist: detail.artist, album: detail.album, coverUrl: detail.coverUrl, durationMs: detail.durationMs };
    state.lyrics = Array.isArray(detail.lyrics) ? detail.lyrics : [];
    audio.src = url; urlFetchedAt = Date.now();
    mediaSongId = String(songId);
    emit();
  } catch (_) {}
}
if (typeof document !== 'undefined' && state.song) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { warmRestored(); }, { once: true });
  else setTimeout(() => { warmRestored(); }, 0);
}

function ensureAudio() {
  if (audio) return audio;
  audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('play', () => { if (state.closed || state.loading || mediaSongId !== String(state.song?.songId)) return; state.playing = true; state.buffering = true; state.error = ''; skipRun = 0; report(); emit(); fillDetail(); });
  // 真出声了才算在放，这时候才撤加载中、才跟服务器说在听
  audio.addEventListener('playing', () => { hasPlaybackSession = true; if (state.buffering) { state.buffering = false; report(); emit(); } });
  audio.addEventListener('waiting', () => { if (!audio.paused && !state.buffering) { state.buffering = true; report(); emit(); } });
  audio.addEventListener('pause', () => { if (!audio.paused || state.loading) return; state.playing = false; state.buffering = false; report(); emit(); });
  audio.addEventListener('ended', () => {
    if (state.closed || state.loading || mediaSongId !== String(state.song?.songId) || (!audio.paused && !audio.ended)) return;
    state.playing = false; state.buffering = false; report(); emit();
    // 试听版之类本来就短的，以 audio 自己的时长为准；同一首只救一次，免得来回转圈
    const meta = (state.song && state.song.durationMs) || 0, own = Number.isFinite(audio.duration) ? audio.duration * 1000 : meta;
    const d = Math.min(meta || own, own || meta), at = positionMs(), key = state.song && state.song.songId;
    if (d > 0 && at < d - 5000 && rescuedEnd !== key) { rescuedEnd = key; recover({ play: true }); return; }
    if (state.queueItemId) next({ auto:true });
  });
  audio.addEventListener('timeupdate', () => {
    // 保险：有的时候 playing 事件漏了，进度真在走就当已经出声
    if (state.buffering && !audio.paused && audio.readyState >= 3 && audio.currentTime > 0) { state.buffering = false; report(); emit(); }
    emit('time'); maybePrefetch();
  });
  audio.addEventListener('seeked', () => { report(); emit(); });
  audio.addEventListener('loadedmetadata', () => { report(); emit(); });
  audio.addEventListener('error', () => { state.buffering = false; if (state.song && !state.loading) recover({ play: wantPlay }); });
  return audio;
}

function emit(kind) { listeners.forEach(fn => { try { fn(state, kind || 'state'); } catch (_) {} }); }

export function subscribe(fn) { listeners.add(fn); fn(state, 'state'); return () => listeners.delete(fn); }
export function getState() { return state; }
export function positionMs() { return audio ? Math.round((audio.currentTime || 0) * 1000) : 0; }
// 以歌曲详情里的时长为准：一边加载一边跳到中间时，audio.duration 会先报出一个错的值
// 。详情没有时长才用 audio 的。
export function durationMs() {
  const fromSong = state.song && Number(state.song.durationMs) > 0 ? Number(state.song.durationMs) : 0;
  const fromAudio = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : 0;
  return Math.round(fromSong || fromAudio || 0);
}

function report() {
  if (!pwaSelected() || suspended || !state.song || state.closed || state.loading || mediaSongId !== String(state.song.songId)) return;
  // Buffering/visibility changes are not a user pause. Sample the matching audio only.
  reportPending = { sourceId: reportSource, sequence: ++reportSequence, generation:playGeneration, songId: state.song.songId, title: state.song.title, artist: state.song.artist, positionMs: positionMs(), durationMs: durationMs(), playing: !!(state.playing && audio && !audio.paused), active: hasPlaybackSession || !!(audio && !audio.paused) };
  if (!heartbeat) heartbeat = setInterval(report, HEARTBEAT_MS);
  flushReport();
}
function flushReport() {
  if (reportFlight || suspended) return reportFlight;
  reportFlight = (async () => {
    while (reportPending && !suspended) {
      let body = reportPending; reportPending = null;
      if (!reportLease || (body.active && !reportLease.active)) {
        if (!mayClaim) continue;
        const lease = await apiRequest(API_BASE + '/now-playing/session', { method:'POST', body:{ sourceId:reportSource, active:body.active, modeEpoch:playbackSelection.epoch } });
        if (!lease.accepted) { mayClaim = false; continue; }
        reportLease = { ...lease, active:body.active };
      }
      // Coalesce events sampled while acquiring a session; no stale queued snapshots.
      if (reportPending) { body = reportPending; reportPending = null; }
      if (state.closed) {
        await apiRequest(API_BASE + '/now-playing', { method:'DELETE', body:{ sourceId:reportSource, sessionId:reportLease.sessionId, sequence:++reportSequence } });
        reportLease = null; continue;
      }
      if (suspended || body.generation !== playGeneration || String(state.song?.songId) !== String(body.songId)) continue;
      if (body.active && !reportLease.active) { reportPending = body; continue; }
      const sessionId=reportLease.sessionId;
      const result = await apiRequest(API_BASE + '/now-playing', { method:'POST', body:{ ...body, sessionId } });
      if(reportLease?.sessionId!==sessionId)continue; // ACK may have completed while this request was in flight.
      if (result?.accepted === false && !result.sessionValid) {
        reportLease = null; mayClaim = result.canClaim === true;
        // A timed-out handoff may revoke us while iOS has suspended sync polling.
        if (!mayClaim) { ++playGeneration; reportPending=null; wantPlay=false; if(audio)audio.pause(); syncPlayback(); }
      }
    }
  })().catch(() => {}).finally(() => { reportFlight = null; if (reportPending && !suspended) flushReport(); });
  return reportFlight;
}

async function loadUrl(songId) {
  const r = await apiRequest(API_BASE + '/song/' + encodeURIComponent(songId) + '/url');
  urlFetchedAt = Date.now();
  return r.url;
}

// 播放地址过期或断流：重新取地址，从原位置接着放
// 网络请求别无限等：超过这个时间当作网慢，给YOU一句话和能按的播放键，而不是一直「加载中」
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
function isUnavailable(e) { return !!e && (e.code === 'MUSIC_UNAVAILABLE' || e.message === 'MUSIC_UNAVAILABLE'); }
function netMsg(e, fallback) {
  if (e && e.message === 'timeout') return '网络有点慢，点播放再试';
  if (isUnavailable(e)) return '这首网易云放不了';
  if (e && /^[A-Z_]+$/.test(String(e.message || ''))) return fallback; // 别把错误代码直接给她看
  const m = String((e && e.message) || '');
  if (!m || /load failed|failed to fetch|network|networkerror|aborted/i.test(m)) return '网断了一下，点播放再试';
  return m || fallback;
}
let skipRun = 0; // 连着跳过了几首放不了的
let rescuedEnd = null; // 这首已经救过一次「假结束」了
let needDetail = false; // 这首的歌词/详情没拿到（网断了），能放了再补
async function fillDetail() {
  if (!state.song || !needDetail) return;
  const songId = state.song.songId;
  try {
    const d = await apiRequest(API_BASE + '/song/' + encodeURIComponent(songId)).then(r => r.song);
    if (!state.song || state.song.songId !== songId) return;
    needDetail = false;
    state.song = { songId, title: d.title, artist: d.artist, album: d.album, coverUrl: d.coverUrl, durationMs: d.durationMs };
    state.lyrics = Array.isArray(d.lyrics) ? d.lyrics : [];
    saveLast(); emit();
  } catch (_) {}
}
// 地址过期/卡住时重新拿地址接着放。拿地址限时；「加载中」只管拿地址这一段，
// 不再等 audio.play()——苹果在网不好时那个 promise 可能一直不回，之前就是这样一直转圈
let recovering = null;
let wantPlay = false; // YOU想让它响着（点了播放、或正在自动接歌）；YOU点暂停/关掉才是 false
function recover(opts) {
  if(!requirePwa())return Promise.resolve();
  if (!state.song) return Promise.resolve();
  if (recovering) return recovering;
  const songId = state.song.songId;
  const generation = playGeneration;
  const at = positionMs(); const wasPlaying = state.playing || !!(opts && opts.play);
  recovering = (async () => {
    try {
      state.loading = true; emit();
      const url = await withTimeout(loadUrl(songId), 10000);
      if (generation !== playGeneration || !state.song || state.song.songId !== songId) return;
      audio.src = url; urlFetchedAt = Date.now();
      try { audio.currentTime = at / 1000; } catch (_) {}
    } catch (e) { if (generation !== playGeneration) return; state.error = netMsg(e, '这首歌现在放不了'); state.loading = false; emit(); return; }
    state.loading = false; emit();
    if (wasPlaying) audio.play().catch(() => { state.error = '点一下播放键开始'; emit(); });
  })().finally(() => { recovering = null; });
  return recovering;
}

// song：至少要 songId；有 title/artist 先显示，详情和歌词随后补齐
export async function play(song, atMs, opts) {
  if(!playbackKnown){if(!await confirmPwa())return;}else if(!requirePwa())return;
  const generation = ++playGeneration;
  if (!opts?.automatic) mayClaim = true; // Only a deliberate play reclaims a fenced page.
  ensureAudio(); wantPlay = true;
  const songId = String(song && song.songId || '');
  if (!/^\d+$/.test(songId)) return;
  const same = !!(state.song && state.song.songId === songId && audio.getAttribute('src'));
  state.closed = false; state.error = '';
  if (!same) {
    mediaSongId = null; reportPending = null;
    state.song = { songId, title: song.title || '', artist: song.artist || '', coverUrl: song.coverUrl || '', durationMs: song.durationMs || 0 };
    state.lyrics = [];
    state.loading = true; emit();
    try {
      const ready = prefetched && prefetched.songId === songId && Date.now() - prefetched.at < 10 * 60 * 1000 ? prefetched : null;
      prefetched = null;
      const [detail, url] = ready ? [ready.detail, ready.url] : await withTimeout(Promise.all([
        apiRequest(API_BASE + '/song/' + encodeURIComponent(songId)).then(r => r.song).catch(() => null),
        loadUrl(songId)
      ]), 12000);
      needDetail = !detail;
      if (ready) urlFetchedAt = ready.at;
      if (generation !== playGeneration || !state.song || state.song.songId !== songId) return;
      if (detail) { state.song = { songId, title: detail.title, artist: detail.artist, album: detail.album, coverUrl: detail.coverUrl, durationMs: detail.durationMs }; state.lyrics = Array.isArray(detail.lyrics) ? detail.lyrics : []; }
      audio.src = url;
      mediaSongId = songId;
      saveLast();
    } catch (e) {
      if (generation !== playGeneration || !state.song || state.song.songId !== songId) return;
      state.error = netMsg(e, '这首歌现在放不了');
      state.loading = false;
      // 上一首的音频还挂着：清掉，不然YOU点播放响的是上一首
      if (audio.getAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      emit();
      // 在列表里、这首网易云放不了：像网易云一样跳到下一首，连着跳最多 5 首
      if (isUnavailable(e) && state.queueItemId && skipRun < 5) {
        skipRun++; state.error = '这首网易云放不了，跳过了'; emit();
        setTimeout(() => { if (state.song && state.song.songId === songId) next({ auto: true, skip: true }); }, 1200);
      }
      return;
    }
    state.loading = false;
  } else if (Date.now() - urlFetchedAt > 15 * 60 * 1000) {
    const url = await loadUrl(songId).catch(() => audio.src);
    if (generation !== playGeneration || state.closed) return;
    audio.src = url;
  }
  if (Number.isFinite(atMs)) audio.currentTime = Math.max(0, atMs) / 1000;
  // Safari can leave play() pending on a stalled connection; keep remote polling alive.
  audio.play().catch(() => { state.error = '点一下播放键开始'; emit(); });
  emit();
}

export function toggle() {
  if(!requirePwa())return;
  if (!state.song) return;
  mayClaim = true;
  wantPlay = !!(audio && audio.paused) || !audio || !audio.getAttribute('src');
  if (!audio || !audio.getAttribute('src')) { play(state.song, 0); return; }
  if (audio.paused) {
    // 地址放久了可能过期：先在YOU这一下里同步 play()（让苹果认这个播放器），再换新地址接着放
    if (Date.now() - urlFetchedAt > 15 * 60 * 1000) { audio.play().catch(() => {}); recover({ play: true }); return; }
    audio.play().catch(() => { state.error = '点一下播放键开始'; emit(); });
  } else audio.pause();
}

export function seek(ms) {
  if(!requirePwa())return;
  if (!audio || !state.song) return;
  audio.currentTime = Math.max(0, Math.min(durationMs(), ms)) / 1000;
  emit('time');
}

// 关掉播放条：停、清空，服务器那边也清空（TA这边就不再看到「正在听」）
export function close() {
  ++playGeneration; state.closed = true; reportPending = null;
  const lease = reportLease; reportLease = null; mayClaim = true;
  wantPlay = false;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  clearInterval(heartbeat); heartbeat = 0;
  clearInterval(queuePoll); queuePoll = 0;
  state.song = null; state.lyrics = []; state.playing = false; state.buffering = false; state.closed = true; state.error = '';
  prefetched = null; prefetchFor = null; saveLast();
  if (lease) apiRequest(API_BASE + '/now-playing', { method: 'DELETE', body:{ sourceId:reportSource, sessionId:lease.sessionId, sequence:++reportSequence } }).catch(() => {});
  emit();
}

export function currentLineIndex() {
  const p = positionMs() + 300; let k = -1;
  for (let i = 0; i < state.lyrics.length; i++) { if (state.lyrics[i].timeMs <= p) k = i; else break; }
  return k;
}

// ---------- 播放列表（服务器上一份，TA也能往里塞歌） ----------
// 放完一首按模式接下一首；换歌时、放着的时候每分钟刷一次列表，这样TA刚塞进来的歌能排上。
let queue = { items: [], currentId: null, mode: 'seq' };
const queueListeners = new Set();
let queuePoll = 0;
function emitQueue(extra) { queueListeners.forEach(fn => { try { fn(queue, extra || null); } catch (_) {} }); }
export function subscribeQueue(fn) { queueListeners.add(fn); fn(queue, null); return () => queueListeners.delete(fn); }
export function getQueue() { return queue; }
function takeQueue(r) {
  if (r && r.queue && Array.isArray(r.queue.items)) {
    queue = r.queue;
    // 列表变了，预取的下一首对不上了就作废，放到结尾前会重新预取
    if (prefetched && queue.mode !== 'shuffle') { const want = pickNext({ auto: true }); if (!want || want.id !== prefetched.itemId) { prefetched = null; prefetchFor = null; } }
    emitQueue();
  }
  return queue;
}
export async function refreshQueue() {
  try { takeQueue(await apiRequest(API_BASE + '/queue')); } catch (_) {}
  return queue;
}
export async function queueOp(path, body, method) {
  return takeQueue(await apiRequest(API_BASE + '/queue' + path, { method: method || 'POST', body: body || {} }));
}
function startQueuePoll() { clearInterval(queuePoll); queuePoll = setInterval(() => { if (state.playing) refreshQueue(); }, 60000); }

export async function playQueueItem(id, opts) {
  if(!playbackKnown){if(!await confirmPwa())return;}else if(!requirePwa())return;
  const item = queue.items.find(x => x.id === id);
  if (!item) return;
  state.queueItemId = item.id;
  queueOp('/current', { id: item.id }).catch(() => {});
  if (item.addedBy === 'ta') emitQueue({ taAdded: item, taPlayed: !!(opts && opts.taPlayed) });
  startQueuePoll();
  const pending = play({ songId: item.songId, title: item.title, artist: item.artist, coverUrl: item.coverUrl, durationMs: item.durationMs }, 0, { automatic:!!(opts?.auto || opts?.taPlayed) });
  const generation = playGeneration;
  await pending;
  if (generation !== playGeneration || state.closed) return;
  state.queueItemId = item.id; saveLast(); emit();
}
function pickNext(opts) {
  const items = queue.items;
  if (!items.length) return null;
  const at = items.findIndex(x => x.id === (state.queueItemId || queue.currentId));
  // 顺序放到最后一首，从头再来
  if (queue.mode === 'one' && opts && opts.auto && at >= 0) return items[at];
  if (queue.mode === 'shuffle' && items.length > 1) { let k = at; while (k === at) k = Math.floor(Math.random() * items.length); return items[k]; }
  return items[(at + 1) % items.length];
}
let prefetchInflight = null, prefetchWaitFor = null;
function maybePrefetch() {
  const p = doPrefetch(); if (p) { prefetchInflight = p; p.finally(() => { if (prefetchInflight === p) prefetchInflight = null; }); }
  return p;
}
async function doPrefetch() {
  if (!audio || !state.playing || !state.queueItemId || prefetchFor === state.queueItemId) return;
  const d = durationMs(); if (!d || d - positionMs() > PREFETCH_BEFORE_MS) return;
  const forItem = prefetchFor = state.queueItemId;
  await refreshQueue(); // 顺便把TA刚塞进来的歌拿到
  const target = pickNext({ auto: true });
  if (!target || state.queueItemId !== forItem) return;
  try {
    const [detail, url] = await Promise.all([
      apiRequest(API_BASE + '/song/' + encodeURIComponent(target.songId)).then(r => r.song),
      apiRequest(API_BASE + '/song/' + encodeURIComponent(target.songId) + '/url').then(r => r.url)
    ]);
    if (state.queueItemId === forItem || prefetchWaitFor === forItem) prefetched = { itemId: target.id, songId: String(target.songId), detail, url, at: Date.now() };
  } catch (_) {}
}
export async function next(opts) {
  if(!requirePwa())return;
  // 自动接下一首：预取时已经刷新过列表、选好了下一首，直接用；手动点下一首才先刷新
  const auto = !!(opts && opts.auto);
  // 拖到快结尾时，预取可能刚发出去就放完了：等它回来再接，最多等 6 秒
  if (auto && prefetchInflight && !prefetched) { prefetchWaitFor = state.queueItemId; await withTimeout(prefetchInflight, 6000).catch(() => {}); prefetchWaitFor = null; }
  // 预取之后YOU又加了歌/换了模式，预取的那首就不一定是「下一首」了：只有它还是该放的那首才用（随机模式本来就随便挑，照用）
  if (auto && prefetched && queue.items.some(x => x.id === prefetched.itemId)) {
    const want = queue.mode === 'shuffle' ? null : pickNext({ auto: true });
    if (queue.mode === 'shuffle' || (want && want.id === prefetched.itemId)) { await playQueueItem(prefetched.itemId, opts); return; }
  }
  if (!auto) await refreshQueue();
  const items = queue.items;
  if (!items.length) return;
  const at = items.findIndex(x => x.id === (state.queueItemId || queue.currentId));
  let target = null;
  if (queue.mode === 'one' && opts && opts.auto && at >= 0) target = items[at];
  else if (queue.mode === 'shuffle' && items.length > 1) { let k = at; while (k === at) k = Math.floor(Math.random() * items.length); target = items[k]; }
  else target = items[(at + 1) % items.length];
  if (target) await playQueueItem(target.id, opts);
}
export async function previous() {
  if(!requirePwa())return;
  await refreshQueue();
  const item = pickPrevious();
  if (item) await playQueueItem(item.id);
}
function pickPrevious() {
  const items = queue.items;
  if (!items.length) return null;
  const at = items.findIndex(x => x.id === (state.queueItemId || queue.currentId));
  return items[(at - 1 + items.length) % items.length];
}
export async function setMode(mode) { return queueOp('/mode', { mode }); }
// 从卡片、搜歌里点开的一首：插进播放列表当前位置、成为当前这首，放完接着放列表。
// 服务器没接住（断网之类）就退回老样子：单放这一首，不进列表。
export async function playSingle(song, atMs) {
  if(!playbackKnown){if(!await confirmPwa())return;}else if(!requirePwa())return;
  const body = { song: { songId: song.songId, title: song.title, artist: song.artist, coverUrl: song.coverUrl, durationMs: song.durationMs } };
  // 先开始放，插列表跟它同时进行：别让点一下到出声之间多等一次服务器。
  state.queueItemId = null;
  const inserted = queueOp('/now', body).then(q => {
    const cur = q && q.items.find(x => x.id === q.currentId);
    return cur && String(cur.songId) === String(song.songId) ? cur.id : null;
  }).catch(() => null);
  await play(song, atMs);
  const id = await inserted;
  if (id && state.song && String(state.song.songId) === String(song.songId)) { state.queueItemId = id; startQueuePoll(); emit(); }
}
// TA直接放的那首：服务器已经把它插进列表、设成当前，
// 这边刷新列表、按那一项放。YOU正在听就直接切过去；播放器停着时苹果不让自己出声，
// 只准备音频地址，听歌栏摆好这首，YOU点一下就响。
export async function playFromTa(itemId) {
  if(!requirePwa())return;
  await refreshQueue();
  const item = queue.items.find(x => x.id === itemId);
  // Ignore superseded commands/cards and share one dedupe ledger with polling.
  if (!item || queue.currentId !== itemId) return;
  const key = 'one-earbud.playnow.done';
  let done = [];
  try { done = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}
  if (done.includes(itemId)) return;
  try { localStorage.setItem(key, JSON.stringify([...done.slice(-39), itemId])); } catch (_) {}
  const wasPlaying = !!(audio && !audio.paused && state.playing && !state.closed);
  state.queueItemId = item.id;
  emitQueue({ taAdded: item, taPlayed: true });
  startQueuePoll();
  if (wasPlaying) { await play(item, 0, { automatic:true }); return; }
  await prepareQueueItem(item);
}
async function prepareQueueItem(item) {
  ++playGeneration; mediaSongId = null; reportPending = null;
  // No audio.play() here: never attempt to bypass Safari's user-gesture requirement.
  state.queueItemId = item.id;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  wantPlay = false;
  state.song = { songId: item.songId, title: item.title, artist: item.artist, coverUrl: item.coverUrl, durationMs: item.durationMs };
  state.lyrics = []; state.closed = false; state.playing = false; state.buffering = false; state.loading = false;
  state.error = '点一下播放键开始';
  prefetched = null; prefetchFor = null;
  saveLast(); emit();
  await warmRestored();
  report();
}

// One small authenticated poll serves both queue updates and remote play_now.
// Start even when paused/empty so an open PWA can prepare its first remote song.
let syncInFlight = null;
const handledControls = new Set();
async function applyPlayerControl(command) {
  if (handledControls.has(command.id)) return;
  const ledgerKey = 'one-earbud.controls.done';
  let done = [];
  try { const saved = JSON.parse(localStorage.getItem(ledgerKey) || '[]'); if (Array.isArray(saved)) done = saved; } catch (_) {}
  if (done.includes(command.id)) return;
  handledControls.add(command.id);
  if (handledControls.size > 100) handledControls.delete(handledControls.values().next().value);
  try { localStorage.setItem(ledgerKey, JSON.stringify([...done.slice(-99), command.id])); } catch (_) {}
  // A stale card must never pause/skip a newer song on the phone.
  if (!state.song || state.closed || state.song.songId !== command.songId) return;
  if (command.action === 'pause') {
    wantPlay = false;
    if (audio) audio.pause();
  } else if (command.action === 'resume') {
    if (!hasPlaybackSession) { state.error = '请先在手机播放器点播放'; emit(); report(); return; }
    if (audio && audio.paused) toggle();
  } else if (command.action === 'next' || command.action === 'previous') {
    const active = !!(audio && !audio.paused && state.playing);
    if (active) await (command.action === 'next' ? next() : previous());
    else {
      // Same preparation path as play_now: a remote click is not a phone gesture.
      const item = command.action === 'next' ? pickNext() : pickPrevious();
      if (item) { await queueOp('/current', { id: item.id }); await prepareQueueItem(item); }
    }
  }
  report();
}
export function syncPlayback() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const result = await apiRequest(API_BASE + '/playback-sync');
      playbackKnown = true;
      takeQueue(result);
      if (!await syncPlaybackOwner(result.playback)) return;
      const command = result && result.command;
      if (command && command.expiresAt > Date.now() && command.at > (playbackSelection.resume?.at || 0)) {
        if (command.action) await applyPlayerControl(command);
        else if (command.itemId === queue.currentId) await playFromTa(command.itemId);
      }
    } catch (_) { /* Offline/auth failures retry when the page is online again. */ }
  })().finally(() => { syncInFlight = null; });
  return syncInFlight;
}
async function syncPlaybackOwner(owner) {
  if (!owner) return true; // V1/mock hosts remain compatible.
  playbackSelection = owner;
  if (owner.handoff && owner.ownerSourceId === reportSource) {
    handoffBusy = true; ++playGeneration; reportPending = null;
    if(handoffStop?.id!==owner.handoff.id) handoffStop={id:owner.handoff.id,at:positionMs(),playing:!!(audio&&!audio.paused&&!audio.ended),song:mediaSongId===String(state.song?.songId)?state.song:null};
    const {at,playing,song}=handoffStop; wantPlay=false;
    if(audio) audio.pause();
    try {
      // The higher sequence fences a delayed heartbeat; don't wait for its fetch.
      if(reportLease) {
        const result=await apiRequest(API_BASE+'/playback-handoff',{method:'POST',body:{sourceId:reportSource,sessionId:reportLease.sessionId,sequence:++reportSequence,handoffId:owner.handoff.id,positionMs:at,...(song?{songId:String(song.songId),title:song.title,artist:song.artist,durationMs:durationMs(),playing}:{})}});
        playbackSelection=result.playback || owner;
        reportLease=null;mayClaim=false;
      }
    } finally { handoffBusy=false;emit(); }
    return false;
  }
  if (owner.mode!=='pwa' || owner.handoff) {
    if(audio && !audio.paused) {++playGeneration;reportPending=null;wantPlay=false;audio.pause();}
    if(owner.mode!=='pwa') { reportLease=null;mayClaim=false; }
    state.error='当前播放端是 ChatGPT，可在音乐卡片切回手机 PWA';emit();return false;
  }
  const saved=owner.resume;
  if(saved?.songId && saved.id!==lastResume && owner.sourceId && owner.sourceId!==reportSource && !hasPlaybackSession && !state.playing) {
    lastResume=saved.id;handoffBusy=true;
    try {await prepareQueueItem(queue.items.find(x=>String(x.songId)===saved.songId)||saved);if(audio)audio.currentTime=(saved.positionMs||0)/1000;}
    finally {handoffBusy=false;}
    state.error='已准备好交接的歌曲，点播放在此手机继续';emit();
  }
  if(saved?.songId && saved.id!==lastResume && (!owner.sourceId || owner.sourceId===reportSource)) {
    const lease=await apiRequest(API_BASE+'/now-playing/session',{method:'POST',body:{sourceId:reportSource,active:hasPlaybackSession,modeEpoch:owner.epoch}});
    if(!lease.accepted)return false;
    reportLease={...lease,active:hasPlaybackSession};mayClaim=true;lastResume=saved.id;
    handoffBusy=true;
    try {
      const item=queue.items.find(x=>String(x.songId)===saved.songId)||saved;
      await prepareQueueItem(item);
      if(audio) audio.currentTime=(saved.positionMs||0)/1000;
    } finally {handoffBusy=false;}
    if(saved.playing && hasPlaybackSession && audio) {wantPlay=true;audio.play().catch(()=>{state.error='点一下播放键继续';emit();});}
    report();emit();
  }
  return true;
}
if (typeof window !== 'undefined') {
  syncTimer = setInterval(syncPlayback, 2000);
  window.addEventListener('online', syncPlayback);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncPlayback(); report(); } });
  window.addEventListener('pagehide', () => {
    suspended = true; reportPending = null;
    clearInterval(heartbeat); heartbeat = 0;
    clearInterval(queuePoll); queuePoll = 0;
    clearInterval(syncTimer); syncTimer = 0;
    clearInterval(watchdogTimer); watchdogTimer = 0;
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    if (!syncTimer) syncTimer = setInterval(syncPlayback, 2000);
    if (!watchdogTimer) watchdogTimer = setInterval(watchPlayback, 2000);
    if (state.queueItemId && !queuePoll) startQueuePoll();
    syncPlayback(); report();
  });
  setTimeout(syncPlayback, 0);
}
// 写信挑歌时的试听：只听一下，不进列表。
export function preview(song) { state.queueItemId = null; return play(song, 0); }

// 当前这首如果是TA（K）放的或排的，返回那一项（带 note），否则 null
export function taItem() {
  const id = state.queueItemId; if (!id) return null;
  const x = (queue.items || []).find(i => i.id === id);
  return x && x.addedBy === 'ta' ? x : null;
}
