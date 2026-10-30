// 分你一只耳机 · 授权页：YOU 用网易云 App 扫码，把登录态交给你自己的服务器。
// 登录态只存在服务器数据目录里（见 docs/SECURITY.md），这个页面只负责扫码、看状态、退出。
import { apiRequest, API_BASE } from './lib/api.js';
import { escapeHtml } from './lib/escape.js';

export function mountMusicLogin({ host }) {
  let poll = 0, alive = true;
  const stop = () => { alive = false; clearTimeout(poll); };
  async function render() {
    clearTimeout(poll);
    host.innerHTML = '<h1 class="oe-title">网易云登录</h1><p class="oe-sub">只用来听歌；登录态只存在你自己的服务器上</p><div data-body><p class="oe-help">读取中…</p></div>';
    const body = host.querySelector('[data-body]');
    let st; try { st = await apiRequest(API_BASE + '/status'); } catch (e) { body.innerHTML = '<p class="oe-help">' + escapeHtml(e.message || '读不到状态') + '</p>'; return; }
    if (!alive) return;
    if (st.connected) {
      const p = st.profile || {};
      body.innerHTML = '<section class="oe-card"><div class="oe-label">已连上网易云</div><div class="oe-value">' + escapeHtml(p.nickname || '') + (st.vip ? ' · 会员' : '') + '</div>'
        + '<p class="oe-help"><a href="/">回到听歌页</a>，就能搜歌、放歌。</p><button type="button" class="oe-btn" data-logout>退出登录</button></section>';
      body.querySelector('[data-logout]').addEventListener('click', async () => { if (!confirm('退出网易云登录？')) return; await apiRequest(API_BASE + '/logout', { method: 'POST' }).catch(() => {}); render(); });
      return;
    }
    body.innerHTML = '<section class="oe-card"><div class="oe-label">还没连上网易云</div><p class="oe-help">用网易云 App 扫一下码。二维码三分钟内有效；在同一台手机上：长按二维码存进相册，再在网易云 App 的扫一扫里选相册。</p>'
      + '<button type="button" class="oe-btn is-go" data-qr>生成二维码</button></section><div data-qr-box></div>';
    body.querySelector('[data-qr]').addEventListener('click', startQr);
  }
  async function startQr() {
    const box = host.querySelector('[data-qr-box]'); if (!box) return;
    box.innerHTML = '<p class="oe-help">生成中…</p>';
    let q; try { q = await apiRequest(API_BASE + '/login/qr', { method: 'POST' }); } catch (e) { box.innerHTML = '<p class="oe-help">' + escapeHtml(e.message || '生成失败') + '</p>'; return; }
    box.innerHTML = '<section class="oe-card" style="text-align:center"><img src="' + escapeHtml(q.qrImage) + '" alt="网易云登录二维码" class="oe-qr"><p class="oe-help" data-state>等你扫码</p></section>';
    const stateEl = box.querySelector('[data-state]');
    const tick = async () => {
      if (!alive) return;
      try {
        const r = await apiRequest(API_BASE + '/login/qr/' + encodeURIComponent(q.key));
        if (r.status === 'success') { render(); return; }
        if (r.status === 'expired') { stateEl.textContent = '过期了，再生成一张'; return; }
        stateEl.textContent = r.status === 'scanned' ? '扫到了，在 App 里点确认' : '等你扫码';
      } catch (e) { stateEl.textContent = (e && e.message) || '出错了，再生成一张试试'; return; }
      poll = setTimeout(tick, 2000);
    };
    poll = setTimeout(tick, 2000);
  }
  render();
  return stop;
}
