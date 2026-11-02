'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../../web/music/player.js'), 'utf8');
const exportsList = [...source.matchAll(/export (?:async )?function (\w+)/g)].map(x => x[1]);
class Target {
  constructor() { this.events = new Map(); }
  addEventListener(type, fn) { this.events.set(type, [...this.events.get(type) || [], fn]); }
  removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(x => x !== fn)); }
  fire(type) { for (const fn of this.events.get(type) || []) fn({ type }); }
}
function phone({ api, now, restored = null }) {
  const intervals = new Map(), timeouts = new Map(), window = new Target(), document = new Target();
  let id = 0, audio;
  const data = new Map(restored ? [['one-earbud.last', JSON.stringify(restored)]] : []);
  const localStorage = { getItem:k => data.get(k) ?? null, setItem:(k,v) => data.set(k,v), removeItem:k => data.delete(k) };
  class Audio extends Target {
    constructor() { super(); this.attrs = {}; this.currentTime = 0; this.duration = 600; this.paused = true; this.ended = false; this.readyState = 4; this.style = {}; }
    getAttribute(k) { return this.attrs[k] ?? null; } setAttribute(k,v) { this.attrs[k]=v; } removeAttribute(k) { delete this.attrs[k]; }
    set src(v) { this.pause(); this.attrs.src=v; this.currentTime=0; this.ended=false; } get src() { return this.attrs.src; }
    play() { this.paused=false; this.fire('play'); this.fire('playing'); return Promise.resolve(); }
    pause() { if (!this.paused) { this.paused=true; this.fire('pause'); } }
    load() {}
  }
  document.hidden = false; document.readyState = 'complete'; document.body = { appendChild() {} }; document.createElement = () => (audio = new Audio());
  const context = { window, document, localStorage, console, crypto, URL, api,
    Date:class extends Date { static now() { return now(); } },
    setInterval(fn, ms) { const key=++id; intervals.set(key,{fn,ms}); return key; }, clearInterval(key) { intervals.delete(key); },
    setTimeout(fn, ms) { const key=++id; timeouts.set(key,{fn,ms}); return key; }, clearTimeout(key) { timeouts.delete(key); }
  };
  vm.runInNewContext(source.replace(/import \{ apiRequest, API_BASE \} from '[^']+';/, "const apiRequest = api; const API_BASE = '/api/music';").replace(/export /g, '') + '\nglobalThis.player={' + exportsList.join(',') + '};', context);
  return { player:context.player, window, document, intervals, timeouts, audio:() => audio,
    timers(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.fn(); },
    start() { for (const [key,timer] of [...timeouts]) if (timer.ms===0) { timeouts.delete(key); timer.fn(); } },
    visibility(hidden) { document.hidden=hidden; document.fire('visibilitychange'); },
    hide() { window.fire('pagehide'); }, show() { window.fire('pageshow'); }
  };
}
module.exports = { phone };
