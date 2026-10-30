class FakeAudio extends EventTarget {
  constructor() { super(); this.attrs = {}; this.currentTime = 0; this.duration = NaN; this.paused = true; this.style = {}; }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
  set src(v) { this.attrs.src = v; this.currentTime = 0; this.duration = 10; } get src() { return this.attrs.src; }
  load() {} async play() { this.paused = false; this.dispatchEvent(new Event('play')); } pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
}
let theAudio = null;
globalThis.localStorage = { _: {}, getItem(k) { return this._[k] ?? null; }, setItem(k, v) { this._[k] = v; }, removeItem(k) { delete this._[k]; } };
globalThis.document = { readyState: 'complete', body: { appendChild() {} }, createElement() { return theAudio = new FakeAudio(); }, addEventListener() {} };
globalThis.window = { addEventListener() {} };
const api = await import('./api.mjs');
const P = await import('./player.mjs');
const tick = () => new Promise(r => setTimeout(r, 5 + (globalThis.API_DELAY || 0) * 4));
async function finish() { // 放到 -20 秒触发预取（这里总长 10 秒，直接跳到 9.5 秒），再结束
  theAudio.currentTime = 9.5; theAudio.dispatchEvent(new Event('timeupdate')); await tick(); await tick();
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended')); await tick(); await tick();
}
const cur = () => { const q = P.getQueue(); const st = P.getState(); const i = q.items.findIndex(x => x.id === st.queueItemId); return { song: st.song && st.song.songId, idx: i, playing: st.playing }; };
let failures = 0;
async function scenario(name, ids, mode, body) {
  api.setItems(ids, mode); await P.refreshQueue(); await P.playQueueItem(P.getQueue().items[0].id); await new Promise(r => setTimeout(r, 30 + (globalThis.API_DELAY || 0) * 4));
  const out = await body(); if (!out.ok) failures++; console.log((out.ok ? 'OK  ' : 'FAIL') + ' ' + name + ' -> ' + JSON.stringify(out.info));
}
await scenario('seq 3首 放完接第2首', [1,2,3], 'seq', async () => { await finish(); const c = cur(); return { ok: c.song === '2' && c.playing, info: c }; });
await scenario('seq 预取后再加一首(下一首播放)', [1,2,3], 'seq', async () => {
  theAudio.currentTime = 9.5; theAudio.dispatchEvent(new Event('timeupdate')); await tick(); await tick();
  await P.queueOp('/next', { song: { songId: '9', title: 't9', artist: 'a', durationMs: 10000 } });
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended')); await tick(); await tick();
  const c = cur(); return { ok: c.song === '9' && c.playing, info: c }; });
await scenario('seq 只有1首放完 → 从头再来', [1], 'seq', async () => { await finish(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
await scenario('seq 3首放到最后 → 回到第1首', [1,2,3], 'seq', async () => { await finish(); await finish(); await finish(); const c = cur(); return { ok: c.song === '1' && c.idx === 0 && c.playing, info: c }; });
await scenario('seq 最后一首时再加一首到后面 → 接着放', [1], 'seq', async () => {
  theAudio.currentTime = 9.5; theAudio.dispatchEvent(new Event('timeupdate')); await tick(); await tick();
  await P.queueOp('/next', { song: { songId: '8', title: 't8', artist: 'a', durationMs: 10000 } });
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended')); await tick(); await tick();
  const c = cur(); return { ok: c.song === '8' && c.playing, info: c }; });
await scenario('one 单曲循环 3首', [1,2,3], 'one', async () => { await finish(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
await scenario('one 单曲循环 只有1首', [1], 'one', async () => { await finish(); await finish(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
await scenario('shuffle 3首', [1,2,3], 'shuffle', async () => { await finish(); const c = cur(); return { ok: c.song !== '1' && c.playing, info: c }; });
await scenario('shuffle 只有1首', [1], 'shuffle', async () => { await finish(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
await scenario('seq 连放三首', [1,2,3,4], 'seq', async () => { await finish(); await finish(); await finish(); const c = cur(); return { ok: c.song === '4' && c.playing, info: c }; });
await scenario('点一首单放(插进列表)后放完接原来的下一首', [1,2,3], 'seq', async () => { await P.playSingle({ songId: '7', title: 't7', artist: 'a', durationMs: 10000 }, 0); await tick(); await finish(); const c = cur(); return { ok: c.song === '2' && c.playing, info: c }; });
await scenario('K 直接放后放完接下一首', [1,2,3], 'seq', async () => { await P.queueOp('/now', { song: { songId: '6', title: 't6', artist: 'a', durationMs: 10000 } }); const id = api.server.currentId; await P.playFromTa(id, { songId: '6' }); await tick(); await finish(); const c = cur(); return { ok: c.song === '2' && c.playing, info: c }; });
await scenario('预取后切到单曲循环 → 重放这首', [1,2,3], 'seq', async () => { theAudio.currentTime = 9.5; theAudio.dispatchEvent(new Event('timeupdate')); await tick(); await tick(); await P.setMode('one'); theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended')); await tick(); await tick(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
globalThis.API_DELAY = 40;
await scenario('[慢网] 拖到快结束马上结束(预取还没回来)', [1,2,3], 'seq', async () => {
  P.seek(9800); theAudio.currentTime = 9.8; theAudio.dispatchEvent(new Event('timeupdate'));
  await new Promise(r => setTimeout(r, 5));
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended'));
  await new Promise(r => setTimeout(r, 500));
  const c = cur(); const st = P.getState(); return { ok: c.song === '2' && c.playing && !st.loading, info: Object.assign(c, { loading: st.loading, err: st.error }) }; });
await scenario('[慢网] 再接第三首', [1,2,3], 'seq', async () => {
  P.seek(9800); theAudio.currentTime = 9.8; theAudio.dispatchEvent(new Event('timeupdate'));
  await new Promise(r => setTimeout(r, 5));
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended'));
  await new Promise(r => setTimeout(r, 500)); await finish();
  const c = cur(); return { ok: c.song === '3' && c.playing, info: c }; });
await scenario('[慢网] 三种模式: 单曲循环', [1,2], 'one', async () => { await finish(); const c = cur(); return { ok: c.song === '1' && c.playing, info: c }; });
await scenario('[慢网] 预取后加歌', [1,2,3], 'seq', async () => {
  theAudio.currentTime = 9.5; theAudio.dispatchEvent(new Event('timeupdate')); await tick(); await tick();
  await P.queueOp('/next', { song: { songId: '9', title: 't9', artist: 'a', durationMs: 10000 } });
  theAudio.currentTime = 10; theAudio.paused = true; theAudio.dispatchEvent(new Event('ended')); await tick(); await tick();
  const c = cur(); return { ok: c.song === '9' && c.playing, info: c }; });
globalThis.API_DELAY = 0;
await scenario('放不了的歌自动跳过', [1,5,3], 'seq', async () => { await finish(); await new Promise(r => setTimeout(r, 1500)); const c = cur(); const st = P.getState(); return { ok: c.song === '3' && c.playing, info: Object.assign(c, { err: st.error }) }; });
await scenario('连着两首放不了也跳过', [1,5,55,4], 'seq', async () => { await finish(); await new Promise(r => setTimeout(r, 3000)); const c = cur(); return { ok: c.song === '4' && c.playing, info: c }; });
await scenario('放不了时点播放不会响上一首', [1,5,55], 'seq', async () => { await finish(); await new Promise(r => setTimeout(r, 50)); const src = theAudio.getAttribute('src'); return { ok: src == null, info: { src, err: P.getState().error } }; });
await scenario('播放中音频报错 → 自己换地址接着放，不卡加载中', [1,2], 'seq', async () => { theAudio.dispatchEvent(new Event('error')); await new Promise(r => setTimeout(r, 200)); const st = P.getState(); const c = cur(); return { ok: c.song === '1' && c.playing && !st.loading, info: Object.assign(c, { loading: st.loading }) }; });
await scenario('暂停后地址过期再点播放 → 响', [1,2], 'seq', async () => { P.toggle(); await tick(); const realNow = Date.now; Date.now = () => realNow() + 20 * 60 * 1000; P.toggle(); await new Promise(r => setTimeout(r, 200)); Date.now = realNow; const st = P.getState(); return { ok: st.playing && !st.loading, info: { playing: st.playing, loading: st.loading, err: st.error } }; });
process.exit(failures ? 1 : 0);
