// one-earbud 听歌 · 界面：顶部播放条、全屏歌词页、搜歌抽屉。
// 图标是 Lucide（ISC），YOU挑的 C 套：分享一首用爱心，选几句用荧光笔。
import { escapeHtml } from '../lib/escape.js';
import { apiRequest, API_BASE } from '../lib/api.js';
import * as player from './player.js';
import { TA_NAME, YOU_NAME, TA_ICON } from '../config.js';

export const ICON = {
  play: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M8 5l11 7-11 7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M18 6l-8 6 8 6z M6 6v12"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3C14.7 3 13.5 3.5 12 5c-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 4l10 8-10 8z"/><path d="M19 5v14"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M19 15v6M16 18h6"/></svg>',
  seq: '<svg viewBox="0 0 24 24"><path d="M4 7h13M4 12h13M4 17h9"/><path d="M17 14l3 3-3 3"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h3c3 0 5 10 8 10h6"/><path d="M3 17h3c1.3 0 2.4-1.8 3.4-4M13.6 11C14.6 8.8 15.7 7 17 7h3"/><path d="M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  one: '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/><path d="M11.5 10l1.5-1v6"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  // 分享给TA：纸飞机
  share: '<svg viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/></svg>',
  disc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M7.2 9.2a5.6 5.6 0 0 1 2-2"/></svg>',
  radar: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/><path d="M12 12l6-6"/></svg>',
  highlighter: '<svg viewBox="0 0 24 24"><path d="M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>'
};

// Music 里的搜索栏只有这一个样子。以后 Music 入口里要搜，也用它。
export function searchBarHtml(placeholder) {
  return '<label class="music-searchbar">' + ICON.search + '<input type="search" placeholder="' + escapeHtml(placeholder || '搜歌、歌手') + '" enterkeyhint="search" autocomplete="off"></label>';
}

// 列表里就地筛（歌单详情、播放列表共用）：不走网易云，只把不匹配的行藏起来
function matchSong(q, title, artist) { q = String(q || '').trim().toLowerCase(); return !q || String(title || '').toLowerCase().includes(q) || String(artist || '').toLowerCase().includes(q); }
export function fmt(ms) { const s = Math.floor((ms || 0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function hueOf(id) { let h = 0; String(id || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; }
function bg(url) { return url ? 'background-image:url(' + JSON.stringify(url + '?param=120y120') + ')' : ''; }

// ---------- 顶部播放条 ----------
export function createMiniBar({ onOpen, onList, onShareSong }) {
  const el = document.createElement('div');
  el.className = 'music-mini'; el.hidden = true;
  el.innerHTML = '<div class="mm-disc"></div><div class="mm-text"><span class="mm-ta" aria-label="' + escapeHtml(TA_NAME) + ' 放的">' + TA_ICON + '</span><span class="mm-title"></span><span class="mm-sub"></span></div>'
    + '<button type="button" class="mm-pp" aria-label="播放/暂停"></button><button type="button" class="mm-next" aria-label="下一首">' + ICON.next + '</button>'
    + '<button type="button" class="mm-list" aria-label="播放列表">' + ICON.list + '</button><button type="button" class="mm-x" aria-label="关掉，不听了">' + ICON.x + '</button><div class="mm-bar"></div>'
    + '<div class="mm-taflash" aria-hidden="true">' + TA_ICON + '<span>K added this</span></div>';
  const $ = s => el.querySelector(s);
  el.addEventListener('click', e => { if (!e.target.isConnected || e.target.closest('button')) return; onOpen && onOpen(); });
  $('.mm-pp').addEventListener('click', () => player.toggle());
  $('.mm-next').addEventListener('click', () => player.next());
  $('.mm-list').addEventListener('click', () => (onList ? onList() : openQueueSheet({ onShareSong })));
  // 只有这个 × 才算真的不听了：听歌栏收起，下次打开也不会再出现
  $('.mm-x').addEventListener('click', () => player.close());
  const off = player.subscribe((st, kind) => {
    el.hidden = st.closed || !st.song;
    if (el.hidden) return;
    const d = player.durationMs();
    $('.mm-bar').style.width = d ? (player.positionMs() / d * 100) + '%' : '0';
    if (kind === 'time') return;
    $('.mm-disc').setAttribute('style', bg(st.song.coverUrl));
    $('.mm-title').textContent = st.song.title || '…';
    $('.mm-sub').textContent = st.error ? st.error : (st.song.artist || '') + (st.loading || st.buffering ? ' · 加载中' : '');
    const ppNow = st.playing ? 'pause' : 'play';
    if ($('.mm-pp').dataset.icon !== ppNow) { $('.mm-pp').dataset.icon = ppNow; $('.mm-pp').innerHTML = ICON[ppNow]; }
    el.classList.toggle('is-playing', st.playing);
    el.classList.toggle('is-ta', !!player.taItem());
  });
  // 轮到TA塞进来的那首：整条闪一下
  let flashTimer = 0;
  const offQ = player.subscribeQueue((q, extra) => {
    el.classList.toggle('is-ta', !!player.taItem());
    if (!extra || !extra.taAdded) return;
    $('.mm-taflash span').textContent = TA_NAME + (extra.taPlayed ? ' played this' : ' added this');
    el.classList.add('k-flash'); clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('k-flash'), 2400);
  });
  player.refreshQueue();
  el.destroy = () => { off(); offQ(); clearTimeout(flashTimer); el.remove(); };
  return el;
}

// ---------- 全屏歌词页 ----------
// onShareSong(song) / onShareLines(song, lines) 由聊天页给：挂到输入框上，不直接发。
let sheet = null;
export function openPlayerSheet({ onShareSong, onShareLines, onNeedLogin }) {
  if (sheet) { sheet.remove(); sheet = null; }
  const el = document.createElement('div');
  el.className = 'music-sheet';
  el.innerHTML = '<div class="ms-head"><button type="button" data-close aria-label="收起">' + ICON.down + '</button>'
    + '<div class="ms-titles"><div class="ms-title"></div><div class="ms-artist"></div><div class="ms-taline" hidden></div></div>'
    + '<button type="button" data-search aria-label="搜歌">' + ICON.search + '</button></div>'
    + '<div class="ms-lines"></div>'
    + '<div class="ms-pickbar"><button type="button" class="music-pill" data-pick-cancel>取消</button><button type="button" class="music-pill is-go" data-pick-send>挂给 ' + escapeHtml(TA_NAME) + '</button></div>'
    + '<div class="ms-normal"><div class="music-note"></div>'
    + '<div class="ms-prog"><div class="ms-hit"><div class="ms-track"><i></i><b></b></div></div><div class="ms-times"><span data-now>0:00</span><span data-dur>0:00</span></div></div>'
    + '<div class="ms-ctr"><button type="button" data-restart aria-label="从头">' + ICON.restart + '</button><button type="button" class="ms-big" data-pp aria-label="播放/暂停"></button><button type="button" data-next aria-label="下一首">' + ICON.next + '</button></div>'
    + '<div class="ms-acts"><button type="button" class="music-pill" data-share-song>' + ICON.heart + '这首给 ' + escapeHtml(TA_NAME) + '</button><button type="button" class="music-pill" data-pick>' + ICON.highlighter + '选几句给 ' + escapeHtml(TA_NAME) + ' 看</button></div></div>';
  document.body.appendChild(el); sheet = el;
  const $ = s => el.querySelector(s);
  const linesEl = $('.ms-lines');
  let picking = false; let picks = []; let dragging = false; let lastK = -2; let builtFor = '';

  function build(st) {
    const key = st.song ? st.song.songId + ':' + st.lyrics.length : '';
    if (key === builtFor) return; builtFor = key; lastK = -2;
    el.style.setProperty('--music-hue', st.song ? hueOf(st.song.songId) : 200);
    if (!st.lyrics.length) { linesEl.innerHTML = '<div class="ms-empty">' + (st.loading ? '歌词在路上…' : '这首没有歌词，或者是纯音乐') + '</div>'; return; }
    linesEl.innerHTML = st.lyrics.map(l => '<div class="ms-ln" data-i="' + l.index + '"><div class="en">' + escapeHtml(l.text) + '</div>' + (l.trans ? '<div class="zh">' + escapeHtml(l.trans) + '</div>' : '') + '</div>').join('');
  }
  function paint(st, kind) {
    if (!st.song) { close(); return; }
    build(st);
    const d = player.durationMs(), p = player.positionMs();
    if (!dragging) { $('.ms-track i').style.width = (d ? p / d * 100 : 0) + '%'; $('.ms-track b').style.left = (d ? p / d * 100 : 0) + '%'; $('[data-now]').textContent = fmt(p); }
    $('[data-dur]').textContent = fmt(d);
    const k = player.currentLineIndex();
    if (k !== lastK) {
      lastK = k;
      linesEl.querySelectorAll('.ms-ln').forEach((e, i) => e.classList.toggle('is-cur', i === k));
      const cur = linesEl.querySelector('.ms-ln.is-cur');
      if (cur && !picking) linesEl.scrollTo({ top: cur.offsetTop - linesEl.clientHeight * 0.42, behavior: 'smooth' });
    }
    if (kind === 'time') return;
    $('.ms-title').textContent = st.song.title || '…'; $('.ms-artist').textContent = (st.song.artist || '') + (st.loading || st.buffering ? ' · 加载中' : '');
    paintK();
    $('[data-pp]').innerHTML = st.playing ? ICON.pause : ICON.play;
    $('.music-note').textContent = st.error || '';
  }
  function paintK() {
    const k = player.taItem(), kl = $('.ms-taline');
    kl.hidden = !k;
    if (k) kl.innerHTML = TA_ICON + '<span>' + escapeHtml(k.note ? TA_NAME + '：' + k.note : TA_NAME + ' 放给你的') + '</span>';
  }
  const off = player.subscribe(paint);
  const offKQ = player.subscribeQueue(() => paintK());
  function close() { off(); offKQ(); el.classList.remove('is-open'); setTimeout(() => el.remove(), 420); if (sheet === el) sheet = null; }
  function setPicking(on) { picking = on; picks = []; el.classList.toggle('is-picking', on); linesEl.querySelectorAll('.is-picked').forEach(e => e.classList.remove('is-picked')); $('[data-pick-send]').textContent = '挂给 ' + TA_NAME; }

  $('[data-close]').onclick = close;
  $('[data-search]').onclick = () => openSearchSheet({ onPick: () => {}, onShareSong: s => { onShareSong && onShareSong(s); close(); }, onNeedLogin });
  $('[data-pp]').onclick = () => player.toggle();
  $('[data-restart]').onclick = () => player.seek(0);
  $('[data-next]').onclick = () => player.next();
  $('[data-share-song]').onclick = () => { const st = player.getState(); if (st.song) { onShareSong && onShareSong(Object.assign({}, st.song)); close(); } };
  $('[data-pick]').onclick = () => { if (player.getState().lyrics.length) setPicking(true); };
  $('[data-pick-cancel]').onclick = () => setPicking(false);
  $('[data-pick-send]').onclick = () => {
    const st = player.getState(); if (!picks.length || !st.song) return;
    const lines = picks.slice().sort((a, b) => a - b).map(i => st.lyrics[i]).filter(Boolean).slice(0, 8);
    onShareLines && onShareLines(Object.assign({}, st.song), lines); setPicking(false); close();
  };
  // 点一句：平时是跳过去，选句模式是勾选；长按进选句模式
  let pressTimer = 0, pressed = false;
  linesEl.addEventListener('pointerdown', e => {
    const ln = e.target.closest('.ms-ln'); if (!ln || picking) return;
    pressed = false; pressTimer = setTimeout(() => { pressed = true; setPicking(true); toggleLine(ln); }, 450);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => linesEl.addEventListener(t, () => clearTimeout(pressTimer)));
  linesEl.addEventListener('click', e => {
    const ln = e.target.closest('.ms-ln'); if (!ln) return;
    if (pressed) { pressed = false; return; }
    if (picking) { toggleLine(ln); return; }
    const l = player.getState().lyrics[Number(ln.dataset.i)]; if (l) player.seek(l.timeMs);
  });
  function toggleLine(ln) {
    const i = Number(ln.dataset.i); const at = picks.indexOf(i);
    if (at < 0) { if (picks.length >= 8) return; picks.push(i); } else picks.splice(at, 1);
    ln.classList.toggle('is-picked', at < 0);
    $('[data-pick-send]').textContent = picks.length ? '挂给 ' + TA_NAME + ' · ' + picks.length + ' 句' : '挂给 ' + TA_NAME;
  }
  // 进度条：按住拖
  const prog = $('.ms-prog'), hit = $('.ms-hit'), track = $('.ms-track');
  function at(e) { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
  function show(u) { $('.ms-track i').style.width = u * 100 + '%'; $('.ms-track b').style.left = u * 100 + '%'; $('[data-now]').textContent = fmt(u * player.durationMs()); }
  hit.addEventListener('pointerdown', e => { dragging = true; prog.classList.add('is-drag'); hit.setPointerCapture(e.pointerId); show(at(e)); });
  hit.addEventListener('pointermove', e => { if (dragging) show(at(e)); });
  const end = e => { if (!dragging) return; dragging = false; prog.classList.remove('is-drag'); player.seek(at(e) * player.durationMs()); };
  hit.addEventListener('pointerup', end); hit.addEventListener('pointercancel', () => { dragging = false; prog.classList.remove('is-drag'); });

  requestAnimationFrame(() => el.classList.add('is-open'));
  return close;
}

// ---------- 搜歌抽屉 ----------
// onPickSong switches the sheet to picking (e.g. a song to go with a letter): tapping a row picks it, the play button previews it, nothing is sent to chat.
export function openSearchSheet({ onShareSong, onNeedLogin, onPickSong }) {
  const el = document.createElement('div');
  el.className = 'music-search';
  el.innerHTML = '<div class="msr-sheet"><div class="msr-grab"></div>' + searchBarHtml('搜歌、歌手') + '<div class="msr-list"></div></div>';
  document.body.appendChild(el);
  const input = el.querySelector('input'), list = el.querySelector('.msr-list');
  let timer = 0, seq = 0, songs = [], homeHtml = '';
  // Music 入口：搜索框空着的时候，下面是每日推荐、私人雷达和YOU的歌单；点一下整份换过去。
  // 写信挑歌（onPickSong）不需要这些，还是一句「想听什么」。
  function showHome() {
    el.classList.remove('is-detail');
    if (onPickSong) { list.innerHTML = '<div class="msr-msg">想听什么</div>'; return; }
    if (homeHtml) { list.innerHTML = homeHtml; return; }
    const now = new Date(), day = now.getDate(), mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][now.getMonth()];
    // 两张卡：网易云的真图（每日推荐=当天第一首的专辑图，雷达=它自己的封面），拿不到就是底色
    function card(src, name, sp, extra) {
      sp = sp || {};
      return '<button type="button" class="msh-card" data-src="' + src + '"><span class="msh-art' + (sp.coverUrl ? '' : ' is-empty msh-art-' + src) + '" style="' + escapeHtml(cover(sp.coverUrl, 300)) + '">' + (extra || '')
        + '<span class="msh-play"><svg viewBox="0 0 10 10"><path d="M1.5 0.5l8 4.5-8 4.5z"/></svg></span></span><b>' + name + '</b><small>' + escapeHtml(sp.line || (src === 'daily' ? '今天的歌' : '按你的口味')) + '</small></button>';
    }
    function tilesHtml(specials) {
      const by = {}; (specials || []).forEach(x => { by[x.id] = x; });
      return '<div class="msh-sp">' + card('daily', '每日推荐', by.daily, '<span class="msh-dt"><i>' + day + '</i><em>' + mon + '</em></span>') + card('radar', '私人雷达', by.radar) + '</div>';
    }
    // 歌单统一用 one-earbud 的底色+唱片，不用网易云的封面
    function rowHtml(p) {
      return '<button type="button" class="msh-row" data-src="' + escapeHtml(p.playlistId) + '" data-name="' + escapeHtml(p.liked ? '我喜欢的音乐' : p.name) + '"><span class="msh-cov">' + ICON.disc + '</span>'
        + '<span class="msh-name">' + escapeHtml(p.liked ? '我喜欢的音乐' : p.name) + '</span><small>' + (Number(p.count) || 0) + ' 首</small></button>';
    }
    list.innerHTML = tilesHtml() + '<div class="msh-h">我的歌单</div><div class="msh-pl"><div class="msr-msg">拿歌单…</div></div>';
    apiRequest(API_BASE + '/sources').then(r => {
      const pls = (r && r.playlists) || [];
      const mine = pls.filter(p => p.mine || p.liked).sort((x, y) => (y.liked ? 1 : 0) - (x.liked ? 1 : 0)), saved = pls.filter(p => !(p.mine || p.liked));
      homeHtml = tilesHtml(r && r.specials)
        + '<div class="msh-h">我的歌单</div><div class="msh-pl">' + (mine.length ? mine.map(rowHtml).join('') : '<div class="msr-msg">没找到你的歌单</div>') + '</div>'
        + (saved.length ? '<div class="msh-h">收藏的歌单</div><div class="msh-pl">' + saved.map(rowHtml).join('') + '</div>' : '')
        + '<div class="msh-hint">点一下就换成这一份；K 排了还没轮到的歌会跟过来</div>';
      if (!input.value.trim()) list.innerHTML = homeHtml;
    }).catch(e => {
      const needLogin = e && (e.status === 401 || /LOGIN|NOT_LOGGED/.test(String(e.code || '')));
      const pl = list.querySelector('.msh-pl');
      if (pl) pl.innerHTML = '<div class="msr-msg">' + (needLogin ? '还没连上网易云，去 设置 → 听歌 扫一下码' : '网易云那边没连上，关掉再打开试试') + '</div>';
      if (needLogin && onNeedLogin) onNeedLogin();
    });
  }
  function songRow(s, i) {
    return '<div class="msr-row" data-i="' + i + '"><div class="msr-cov" style="' + escapeHtml(bg(s.coverUrl)) + '"></div>'
      + '<div class="msr-tt"><div class="msr-t">' + escapeHtml(s.title) + '</div><div class="msr-a">' + escapeHtml(s.artist) + (s.album ? ' · ' + escapeHtml(s.album) : '') + '</div></div>'
      + (onPickSong ? '' : '<button type="button" data-send aria-label="发给 ' + escapeHtml(TA_NAME) + '">' + ICON.share + '</button><button type="button" data-queue aria-label="下一首播放">' + ICON.plus + '</button>') + '<button type="button" data-play aria-label="播放">' + ICON.play + '</button></div>';
  }
  // 歌单详情：点歌单先进来看歌，点哪首只放那一首（插进列表成为当前），「全部播放」才整份换
  async function openDetail(src, name) {
    const my = ++seq;
    const top0 = '<div class="msd-top"><div class="msd-head"><button type="button" class="msd-back" aria-label="返回">' + ICON.back + '</button><div class="msd-tt"><b>' + escapeHtml(name || '歌单') + '</b><small>拿歌…</small></div>'
      + '<button type="button" class="music-pill is-go msd-all" data-all="' + escapeHtml(src) + '">' + ICON.play + '全部播放</button></div>';
    const head = top0 + '<label class="music-searchbar msd-filter">' + ICON.search + '<input type="search" placeholder="在这个歌单里找" enterkeyhint="search" autocomplete="off"></label></div>';
    songs = [];
    el.classList.add('is-detail'); // 详情里只留「在这个歌单里找」，顶上的全局搜歌先藏起来（09-29 她说）
    list.innerHTML = head + '<div class="msr-msg">拿歌…</div>';
    list.scrollTop = 0;
    try {
      const r = await apiRequest(API_BASE + '/source/' + encodeURIComponent(src) + '/songs');
      if (my !== seq) return;
      songs = (r && r.songs) || [];
      list.innerHTML = head.replace('<small>拿歌…</small>', '<small>' + songs.length + ' 首</small>') + (songs.length ? songs.map(songRow).join('') + '<div class="msr-msg msd-none" hidden>这个歌单里没有</div>' : '<div class="msr-msg">这个歌单是空的</div>');
    } catch (e) {
      if (my !== seq) return;
      list.innerHTML = head.replace('<small>拿歌…</small>', '<small></small>') + '<div class="msr-msg">网易云那边没连上，返回再点一次试试</div>';
    }
  }
  // 详情页里的小搜索框：只筛这一份
  list.addEventListener('input', e => {
    const f = e.target.closest('.msd-filter input'); if (!f) return;
    let shown = 0;
    list.querySelectorAll('.msr-row').forEach(row => { const x = songs[Number(row.dataset.i)]; const ok = !!x && matchSong(f.value, x.title, x.artist); row.hidden = !ok; if (ok) shown++; });
    const none = list.querySelector('.msd-none'); if (none) none.hidden = shown > 0;
  });
  list.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.msd-filter input')) e.target.blur(); });
  async function loadSource(src, btn) {
    if (btn.classList.contains('is-loading')) return;
    btn.classList.add('is-loading');
    try {
      const q = await player.queueOp('/load', { source: src });
      if (q && q.currentId) await player.playQueueItem(q.currentId);
      close();
    } catch (e) {
      btn.classList.remove('is-loading');
      const small = btn.querySelector('small'); if (small) small.textContent = '没换成，点一下再试';
    }
  }
  showHome();
  function close() { el.classList.remove('is-open'); setTimeout(() => el.remove(), 320); }
  el.addEventListener('click', e => { if (e.target === el) close(); });
  async function run() {
    const q = input.value.trim(); const my = ++seq;
    if (!q) { showHome(); return; }
    list.innerHTML = '<div class="msr-msg">找找…</div>';
    try {
      const r = await apiRequest(API_BASE + '/search?q=' + encodeURIComponent(q));
      if (my !== seq) return;
      songs = r.songs || [];
      list.innerHTML = songs.length ? songs.map(songRow).join('') : '<div class="msr-msg">没搜到</div>';
    } catch (e) {
      if (my !== seq) return;
      const needLogin = e && (e.status === 401 || /LOGIN|NOT_LOGGED/.test(String(e.code || '')));
      list.innerHTML = '<div class="msr-msg">' + (needLogin ? '还没连上网易云，去 设置 → 听歌 扫一下码' : escapeHtml((e && e.message) || '搜不了')) + '</div>';
      if (needLogin && onNeedLogin) onNeedLogin();
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 380); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  list.addEventListener('click', e => {
    if (e.target.closest('.msd-back')) { ++seq; songs = []; showHome(); return; }
    const allBtn = e.target.closest('[data-all]');
    if (allBtn) { loadSource(allBtn.dataset.all, allBtn); return; }
    const srcBtn = e.target.closest('[data-src]');
    if (srcBtn) {
      // 卡片上那个播放键：整份直接放；点别处进详情
      if (e.target.closest('.msh-play')) { loadSource(srcBtn.dataset.src, srcBtn); return; }
      openDetail(srcBtn.dataset.src, srcBtn.dataset.name || (srcBtn.querySelector('b, .msh-name') || {}).textContent);
      return;
    }
    const row = e.target.closest('.msr-row'); if (!row) return;
    const s = songs[Number(row.dataset.i)]; if (!s) return;
    if (onPickSong) {
      if (e.target.closest('[data-play]')) { player.preview(s); return; }
      onPickSong(s); close(); return;
    }
    if (e.target.closest('[data-send]')) { onShareSong && onShareSong(s); close(); return; }
    // ＋：放在下一首（排在正在放的这首后面），抽屉不关，可以连着加好几首；按钮变成一个勾
    if (e.target.closest('[data-queue]')) {
      const b = e.target.closest('[data-queue]');
      player.queueOp('/next', { song: { songId: s.songId, title: s.title, artist: s.artist, coverUrl: s.coverUrl, durationMs: s.durationMs } })
        .then(() => { b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>'; b.disabled = true; }).catch(() => {});
      return;
    }
    player.playSingle(s, 0); close();
  });
  requestAnimationFrame(() => { el.classList.add('is-open'); if (onPickSong) input.focus(); });
  return close;
}

// ---------- 聊天里的卡片（二期：黑胶 + 一百根短线；歌词是便签 + 荧光笔） ----------
// card: { kind:'song'|'lyric', songId, title, artist, coverUrl, durationMs, lines:[{index,timeMs,text,trans}], note, from:'you'|'ta' }
// note 不在卡片里画：渲染器把它拆成卡片上面一条普通消息。
const LINES100 = '<div class="mc-lines100">' + '<i></i>'.repeat(100) + '</div>';
function cover(url, size) { return url ? 'background-image:url(' + JSON.stringify(url + '?param=' + size + 'y' + size) + ')' : ''; }
export function musicCardMarkup(card) {
  if (!card || !/^\d+$/.test(String(card.songId || ''))) return '';
  const her = card.from !== 'ta';
  const pn = !her && card.playNow && card.playNow.itemId ? card.playNow : null;
  const by = '<div class="mc-by">' + (pn ? 'played by ' + TA_NAME : 'shared by ' + (her ? YOU_NAME : TA_NAME)) + '</div>';
  const at = card.lines && card.lines.length ? card.lines[0].timeMs : 0;
  const data = ' data-music-song="' + escapeHtml(card.songId) + '" data-music-at="' + (Number(at) || 0) + '" data-music-dur="' + (Number(card.durationMs) || 0) + '" data-music-title="' + escapeHtml(card.title || '') + '" data-music-artist="' + escapeHtml(card.artist || '') + '" data-music-cover="' + escapeHtml(card.coverUrl || '') + '"';
  const pnData = pn ? ' data-play-now="' + escapeHtml(pn.itemId) + '" data-play-at="' + (Number(pn.at) || 0) + '"' : '';
  if (card.kind === 'lyric' && card.lines && card.lines.length) {
    return '<div class="music-card mc-sticky' + (her ? ' is-her' : '') + '"' + data + pnData + '>' + by + '<div class="mc-ly">'
      + card.lines.map(l => '<p><span class="hl">' + escapeHtml(l.text) + '</span></p>' + (l.trans ? '<p class="tr">' + escapeHtml(l.trans) + '</p>' : '')).join('')
      + '</div><div class="mc-src"><span>' + escapeHtml(card.title) + (card.artist ? ' · ' + escapeHtml(card.artist) : '') + '</span><span class="mc-num">' + fmt(at) + '</span></div></div>';
  }
  return '<div class="music-card mc-vinyl' + (her ? ' is-her' : '') + (pn ? ' is-playnow' : '') + '"' + data + pnData + '>' + by
    + '<div class="mc-deck"><div class="mc-sleeve" style="' + escapeHtml(cover(card.coverUrl, 200)) + '"></div><div class="mc-disc"><div class="mc-label" style="' + escapeHtml(cover(card.coverUrl, 120)) + '"></div></div></div>'
    + '<div class="mc-t">' + escapeHtml(card.title) + '</div><div class="mc-a">' + escapeHtml(card.artist || '') + '</div>'
    + LINES100 + '<div class="mc-time"><span class="mc-num mc-cur">0:00</span><span class="mc-num">' + fmt(card.durationMs) + '</span></div></div>';
}

// 卡片跟着播放器走：放的是这首就转、短线从左往右变深
function syncMusicCards(st) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.music-card[data-music-song]').forEach(el => {
    const mine = Boolean(st && st.song && st.song.songId === el.dataset.musicSong);
    el.classList.toggle('on', mine && Boolean(st.playing));
    if (!el.classList.contains('mc-vinyl')) return;
    const dur = mine ? (player.durationMs() || Number(el.dataset.musicDur) || 0) : Number(el.dataset.musicDur) || 0;
    const pos = mine ? player.positionMs() : 0;
    const n = dur ? Math.min(100, Math.round(pos / dur * 100)) : 0;
    const bars = el.querySelector('.mc-lines100');
    if (bars && Number(bars.dataset.n || -1) !== n) { bars.dataset.n = String(n); Array.prototype.forEach.call(bars.children, (b, k) => b.classList.toggle('p', k < n)); }
    const cur = el.querySelector('.mc-cur'); if (cur) cur.textContent = fmt(pos);
  });
}
player.subscribe(syncMusicCards);

// TA直接放的卡（play_now）：卡片刚出现在聊天里的那一下切一次。
// 翻历史、重开页面看到的旧卡不会再切：超过三分钟的不算，切过的记在本机。
const PLAY_NOW_FRESH_MS = 3 * 60 * 1000;
const PLAY_NOW_DONE_KEY = 'one-earbud.playnow.done';
function playNowDone() { try { return JSON.parse(localStorage.getItem(PLAY_NOW_DONE_KEY) || '[]'); } catch (_) { return []; } }
function checkPlayNow(el) {
  const id = el.dataset.playNow; if (!id) return;
  if (playNowDone().includes(id)) return;
  if (Date.now() - (Number(el.dataset.playAt) || 0) > PLAY_NOW_FRESH_MS) return;
  player.playFromTa(id, { songId: el.dataset.musicSong, title: el.dataset.musicTitle, artist: el.dataset.musicArtist, durationMs: Number(el.dataset.musicDur) || 0 }).catch(() => {});
}
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const scan = root => { if (root.matches && root.matches('.music-card[data-play-now]')) checkPlayNow(root); if (root.querySelectorAll) root.querySelectorAll('.music-card[data-play-now]').forEach(checkPlayNow); };
  const start = () => { scan(document.body); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && scan(n)))).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
}
export function refreshMusicCards() { syncMusicCards(player.getState()); }

// 点卡片：歌卡 = 放 / 停（是正在放的这首就暂停）；点短线 = 跳到那儿；歌词卡从那一句开始放
export function handleMusicCardClick(target) {
  const card = target && target.closest && target.closest('[data-music-song]');
  if (!card) return false;
  const st = player.getState();
  const mine = st.song && st.song.songId === card.dataset.musicSong;
  const song = { songId: card.dataset.musicSong, title: card.dataset.musicTitle, artist: card.dataset.musicArtist, coverUrl: card.dataset.musicCover };
  const bars = target.closest('.mc-lines100');
  if (bars && card.classList.contains('mc-vinyl')) {
    const r = bars.getBoundingClientRect(), x = (window.__lastTapX != null ? window.__lastTapX : r.left);
    const frac = Math.max(0, Math.min(1, (x - r.left) / r.width)), dur = Number(card.dataset.musicDur) || player.durationMs();
    if (mine) player.seek(frac * player.durationMs()); else player.playSingle(song, frac * dur);
    return true;
  }
  if (mine && card.classList.contains('mc-vinyl')) { player.toggle(); return true; }
  player.playSingle(song, Number(card.dataset.musicAt) || 0);
  return true;
}
if (typeof document !== 'undefined') document.addEventListener('pointerdown', e => { window.__lastTapX = e.clientX; }, true);

export { player };

// ---------- Up next：播放列表抽屉 ----------
// YOU什么都能动：点一首放、× 删、按住 ⋮⋮ 拖、换模式、导入歌单、停止播放。TA加的歌前面是TA 的图标，底下那行是TA附的话。
let queueEl = null;
export function openQueueSheet(opts) {
  const onShareSong = opts && opts.onShareSong;
  if (queueEl) return;
  const el = document.createElement('div');
  el.className = 'music-queue';
  el.innerHTML = '<div class="mq-sheet"><div class="msr-grab"></div>'
    + '<div class="mq-head"><h3>Up next</h3><div class="mq-modes"></div><button type="button" class="mq-imp">导入</button></div>'
    + '<div class="mq-impmenu" hidden></div><div class="mq-find">' + searchBarHtml('在列表里找') + '</div><div class="mq-list"></div>'
    + '<button type="button" class="mq-stop">停止播放</button></div>';
  document.body.appendChild(el); queueEl = el;
  const $ = s => el.querySelector(s);
  function close() { el.classList.remove('is-open'); setTimeout(() => { el.remove(); }, 320); queueEl = null; offQ(); offP(); }
  el.addEventListener('click', e => { if (e.target === el) close(); });
  const MODES = [['seq', '顺序'], ['shuffle', '随机'], ['one', '单曲循环']];
  function drawModes(q) {
    $('.mq-modes').innerHTML = MODES.map(([m, label]) => '<button type="button" data-mode="' + m + '" class="' + (q.mode === m ? 'on' : '') + '" aria-label="' + label + '">' + ICON[m] + '</button>').join('');
  }
  function drawList(q) {
    if (drag) { drawPending = true; return; }
    const st = player.getState();
    const cur = st.queueItemId || q.currentId;
    $('.mq-list').innerHTML = q.items.length ? q.items.map(x => '<div class="mq-row' + (x.id === cur ? ' cur' : '') + '" data-id="' + escapeHtml(x.id) + '">'
      + '<div class="mq-c" style="' + escapeHtml(bg(x.coverUrl)) + '"></div><div class="mq-m"><div class="mq-t">' + (x.addedBy === 'ta' ? TA_ICON : '') + '<span>' + escapeHtml(x.title) + '</span>'
      + (x.id === st.queueItemId ? '<span class="mq-eq' + (st.playing ? ' on' : '') + '"><i></i><i></i><i></i></span>' : '') + '</div><div class="mq-a">' + escapeHtml(x.artist || '') + '</div>'
      + (x.addedBy === 'ta' && x.note ? '<div class="mq-n">' + escapeHtml(TA_NAME) + '：' + escapeHtml(x.note) + '</div>' : '') + '</div>'
      + (onShareSong ? '<button type="button" class="mq-s" aria-label="发给 ' + escapeHtml(TA_NAME) + '">' + ICON.share + '</button>' : '')
      + '<button type="button" class="mq-x" aria-label="删掉">' + ICON.x + '</button><span class="mq-h" aria-label="拖动排序">' + ICON.grip + '</span></div>').join('')
      : '<div class="msr-msg">列表是空的。搜歌时点 ＋，或者从「导入」把你的歌单搬进来。</div>';
    applyFind();
    // 打开时直接滚到正在放的那首
    if (!centered) { const row = $('.mq-list .mq-row.cur'); if (row) { centered = true; centerRow(row); } }
  }
  let centered = false;
  let drag = null, drawPending = false; // 拖动中
  function centerRow(row) { const l = $('.mq-list'); l.scrollTop = Math.max(0, row.offsetTop - l.clientHeight / 2 + row.offsetHeight / 2); }
  function applyFind() {
    const v = ($('.mq-find input') || {}).value || '';
    const items = (player.getQueue() || {}).items || [];
    const byId = new Map(items.map(x => [x.id, x]));
    $('.mq-list').classList.toggle('is-find', !!v.trim());
    $('.mq-list').querySelectorAll('.mq-row').forEach(row => { const x = byId.get(row.dataset.id); row.hidden = !(x && matchSong(v, x.title, x.artist)); });
  }
  const offQ = player.subscribeQueue(q => { drawModes(q); drawList(q); });
  const offP = player.subscribe((st, kind) => { if (kind !== 'time') drawList(player.getQueue()); });
  player.refreshQueue();

  $('.mq-find input').addEventListener('input', () => { applyFind(); if (!$('.mq-find input').value.trim()) { const row = $('.mq-list .mq-row.cur'); if (row) centerRow(row); } else $('.mq-list').scrollTop = 0; });
  $('.mq-find input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('.mq-modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) player.setMode(b.dataset.mode).catch(() => {}); });
  $('.mq-stop').addEventListener('click', () => { player.close(); close(); });
  $('.mq-imp').addEventListener('click', async () => {
    const m = $('.mq-impmenu');
    if (!m.hidden) { m.hidden = true; return; }
    m.hidden = false; m.innerHTML = '<div class="msr-msg">找找你的歌单…</div>';
    try {
      const r = await apiRequest(API_BASE + '/playlists');
      const all = r.playlists || [];
      const mine = all.filter(p => p.mine || p.liked).sort((a, b) => (b.liked ? 1 : 0) - (a.liked ? 1 : 0)), saved = all.filter(p => !(p.mine || p.liked));
      const one = p => '<button type="button" data-pl="' + escapeHtml(p.playlistId) + '"><span class="mq-plcov">' + ICON.disc + '</span>'
        + '<span class="mq-plname">' + escapeHtml(p.liked ? '我喜欢的音乐' : p.name) + '</span><small>' + p.count + ' 首</small></button>';
      m.innerHTML = (mine.map(one).join('') + (saved.length ? '<div class="mq-plh">收藏的歌单</div>' + saved.map(one).join('') : '')) || '<div class="msr-msg">没找到你的歌单</div>';
    } catch (e) { m.innerHTML = '<button type="button" class="mq-retry">网易云那边没连上，点这里再试一次</button>'; }
  });
  $('.mq-impmenu').addEventListener('click', async e => {
    if (e.target.closest('.mq-retry')) { $('.mq-impmenu').hidden = true; $('.mq-imp').click(); return; }
    const b = e.target.closest('[data-pl]'); if (!b) return;
    const m = $('.mq-impmenu'); m.innerHTML = '<div class="msr-msg">搬进来…</div>';
    try {
      const r = await apiRequest(API_BASE + '/queue/import', { method: 'POST', body: { playlistId: b.dataset.pl } });
      await player.refreshQueue();
      m.innerHTML = '<div class="msr-msg">加了 ' + (r.imported || 0) + ' 首' + (r.skipped ? '，还有 ' + r.skipped + ' 首放不下（列表最多 500 首）' : '') + '</div>';
      setTimeout(() => { m.hidden = true; }, 1600);
    } catch (e2) { m.innerHTML = '<button type="button" class="mq-retry">没搬进来，网易云那边没连上，点这里重新选</button>'; }
  });
  $('.mq-list').addEventListener('click', e => {
    const row = e.target.closest('.mq-row'); if (!row || e.target.closest('.mq-h')) return;
    if (e.target.closest('.mq-s')) { const x = (player.getQueue().items || []).find(i => i.id === row.dataset.id); if (x && onShareSong) { onShareSong({ songId: x.songId, title: x.title, artist: x.artist, coverUrl: x.coverUrl, durationMs: x.durationMs }); close(); } return; }
    if (e.target.closest('.mq-x')) { player.queueOp('/' + encodeURIComponent(row.dataset.id), {}, 'DELETE').catch(() => {}); return; }
    player.playQueueItem(row.dataset.id);
  });
  // 按住 ⋮⋮ 上下拖：别的行跟着让位，看得出会落在哪；松手当场换好位置，服务器在后面追
  $('.mq-list').addEventListener('pointerdown', e => {
    const h = e.target.closest('.mq-h'); if (!h) return;
    const list = $('.mq-list');
    const row = h.closest('.mq-row'); const rows = Array.from(list.querySelectorAll('.mq-row'));
    const step = rows.length > 1 ? Math.abs(rows[1].offsetTop - rows[0].offsetTop) || row.offsetHeight : row.offsetHeight;
    drag = { row, rows, from: rows.indexOf(row), to: rows.indexOf(row), y: e.clientY, s0: list.scrollTop, step, lastY: e.clientY, timer: 0 };
    list.classList.add('is-dragging'); row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault();
    // 手指停在上下边缘时列表自己滚
    drag.timer = setInterval(() => {
      if (!drag) return; const r = list.getBoundingClientRect(); const edge = 56;
      const v = drag.lastY < r.top + edge ? -9 : drag.lastY > r.bottom - edge ? 9 : 0;
      if (v) { list.scrollTop += v; layout(); }
    }, 16);
  });
  function layout() {
    if (!drag) return;
    const list = $('.mq-list');
    const dy = drag.lastY - drag.y + (list.scrollTop - drag.s0);
    drag.row.style.transform = 'translateY(' + dy + 'px)';
    const to = Math.max(0, Math.min(drag.rows.length - 1, drag.from + Math.round(dy / drag.step)));
    if (to === drag.to) return; drag.to = to;
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      const shift = (drag.from < i && i <= to) ? -drag.step : (to <= i && i < drag.from) ? drag.step : 0;
      r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }
  $('.mq-list').addEventListener('pointermove', e => { if (!drag) return; drag.lastY = e.clientY; layout(); });
  function endDrag() {
    if (!drag) return;
    const d = drag; drag = null; clearInterval(d.timer);
    const list = $('.mq-list');
    list.classList.remove('is-dragging'); d.row.classList.remove('drag');
    d.rows.forEach(r => { r.style.transform = ''; });
    if (d.to !== d.from) {
      const ref = d.rows[d.to];
      if (d.to > d.from) ref.after(d.row); else ref.before(d.row);
      player.queueOp('/move', { id: d.row.dataset.id, to: d.to }).catch(() => { drawList(player.getQueue()); });
    } else if (drawPending) { drawPending = false; drawList(player.getQueue()); }
    drawPending = false;
  }
  $('.mq-list').addEventListener('pointerup', endDrag);
  $('.mq-list').addEventListener('pointercancel', endDrag);
  requestAnimationFrame(() => el.classList.add('is-open'));
}
