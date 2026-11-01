'use strict';
// one-earbud 听歌 · YOU的网易云登录态。按 secret 处理：文件 0600、原子写；cookie 只出不进任何读接口和日志。

const fs = require('fs');
const path = require('path');

function defaultFile() {
  return path.join(process.env.ONE_EARBUD_DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'netease-auth.json');
}

function publicState(v) {
  return v ? { connected: true, profile: v.profile || null, vip: !!v.vip, connectedAt: v.connectedAt || null } : { connected: false };
}
function savedState(prev, cookie, profile, vip, nowMs) {
  const date = new Date(nowMs ?? Date.now()).toISOString();
  return { cookie, profile: profile || (prev && prev.profile) || null, vip: vip == null ? !!(prev && prev.vip) : !!vip,
    connectedAt: (prev && prev.connectedAt) || date, updatedAt: date };
}
function cookieParts(cookie) {
  return new Map(String(cookie || '').split(';').map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }).filter(([k]) => k));
}
// Apply only changed keys: concurrent responses must not revert another response's refresh.
// Ignore a response belonging to a session that has since logged out / been replaced.
function refreshedState(prev, cookie, baseCookie) {
  if (!prev || !cookie) return null;
  let next = cookie;
  if (baseCookie !== undefined) {
    const base = cookieParts(baseCookie), current = cookieParts(prev.cookie), incoming = cookieParts(cookie);
    if (base.get('MUSIC_U') !== current.get('MUSIC_U')) return null;
    for (const [k, v] of incoming) if (base.get(k) !== v) current.set(k, v);
    next = Array.from(current, ([k, v]) => k + '=' + v).join('; ');
  }
  return next === prev.cookie ? null : { ...prev, cookie: next, updatedAt: new Date().toISOString() };
}

function createMusicAuthStore(options) {
  const file = (options && options.file) || defaultFile();
  function read() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v && typeof v.cookie === 'string' && v.cookie) return v;
    } catch (_) {}
    return null;
  }
  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  return {
    cookie() { const v = read(); return v ? v.cookie : ''; },
    // 对外只给这些，不含 cookie
    publicState() {
      return publicState(read());
    },
    save(cookie, profile, vip, nowMs) {
      write(savedState(read(), cookie, profile, vip, nowMs));
    },
    // 网易云每次请求可能刷新 cookie；有变化才写
    refreshCookie(cookie, baseCookie) { const v = refreshedState(read(), cookie, baseCookie); if (v) write(v); },
    clear() { try { fs.unlinkSync(file); } catch (_) {} }
  };
}

module.exports = { createMusicAuthStore, defaultFile, publicState, savedState, refreshedState };
