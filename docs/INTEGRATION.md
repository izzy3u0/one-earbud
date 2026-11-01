# 接入指南

> 本分支提供独立 `/` 听歌首页 / PWA，以及 ChatGPT 远程 MCP，见 [MCP.md](MCP.md)。以下继续描述原有宿主接入。`play_now` 现在也通过受鉴权的 `/api/music/playback-sync` 轮询同步到手机，不再只依赖聊天歌卡；新版播放器会在暂停时仅准备歌曲等待点击。

> 这份文档写给两种读者：接入它的人，和将来要用它的机（TA）。人按章节一步步做；机重点读第 5、6 节和 FOR-AGENT.md。
> 文中：**YOU** = 用手机听歌的人；**TA** = 你的 AI 伴侣；**宿主** = 你们已有的聊天页和 Agent 运行时。

## 0. 整体长什么样

```
 YOU 的手机（网页 / PWA）                你的服务器                         网易云
 ┌──────────────────────┐   /api/music   ┌───────────────────────┐  非官方接口  ┌────────┐
 │ 听歌栏 · 歌词页       │ ─────────────▶ │ music/  业务总管        │ ───────────▶ │ 搜歌    │
 │ 搜歌/入口 · 歌单详情  │ ◀───────────── │  ├ 登录态（仅存服务器）  │ ◀─────────── │ 歌词    │
 │ 播放列表 · 聊天歌卡   │   心跳：正在听  │  ├ 播放列表（服务器一份）│              │ 播放地址 │
 └──────────────────────┘                │  └ 正在听（只在内存）    │              └────────┘
                                          │ agent/                  │
                         每轮 prompt ◀─── │  ├ now-playing-prompt   │
                    TA  ◀───────────────▶ │  └ tool-contract（工具） │
                          工具调用         └───────────────────────┘
```

- 播放列表存在服务器上一份，所以 TA 能往里加歌，YOU 换设备也在。
- 「正在听」只在服务器内存里，靠前端心跳维持，不落盘。
- 声音只在 YOU 的手机上响；TA 听不见，TA 读的是歌名、歌手、歌词和播放进度。

## 1. 最小可跑

见 README 的「五步跑起来」。跑通的标志：YOU 在手机上搜到一首歌并听到声音。

如果你已经有自己的后端（比如 express），不必用 `server/example-server.js`，照它做三件事：

1. `mountMusicRoutes(router, createMusicAuthority())`，把 router 挂到 `/api` 下（路由自带 `/music` 前缀），外面包你自己的鉴权
2. 把 `web/` 当静态文件发出去（或拷进你的前端工程）
3. 前端 `web/lib/api.js` 里 `API_BASE` 对上你的前缀，`authHeaders()` 改成你们的鉴权方式

## 2. 授权页

- **在哪**：`web/login.html`（挂好后是 `https://你的域名/login.html`）。也可以把 `web/login.js` 的 `mountMusicLogin({ host })` 挂进你们自己的设置页。
- **干什么**：YOU 用网易云 App 扫码，服务器拿到登录态。之后搜歌、每日推荐、私人雷达、会员歌曲都按 YOU 的账号来。
- **页面上有什么**：没登录时是「生成二维码」；扫码中显示「等你扫码 / 扫到了，在 App 里点确认 / 过期了」；登录后显示昵称、是否会员、「退出登录」。
- **同一台手机怎么扫**：长按二维码存进相册，在网易云 App 的扫一扫里选相册。
- **登录过期**：接口会返回 `MUSIC_LOGIN_EXPIRED` / `MUSIC_NOT_LOGGED_IN`，搜歌抽屉会提示「还没连上网易云」。前端控件接受一个 `onNeedLogin` 钩子，你可以在里面引导 YOU 去授权页。
- **登录态存哪**：默认服务器 `ONE_EARBUD_DATA_DIR/netease-auth.json`，权限 0600，从不通过任何读接口返回。Render Free 可选外部加密 PostgreSQL 保存登录态，见 [MCP.md](MCP.md)；自定义宿主需在监听 HTTP 前 `await prepareMusicAuthStore()`，把返回的 store 注入 `createMusicAuthority({ store })`，参照 `server/example-server.js`。

## 3. 前端控件，一个一个接

所有控件都在 `web/music/ui.js`，播放内核在 `web/music/player.js`，样式在 `web/styles/music.css`。页面里先引样式：

```html
<link rel="stylesheet" href="/styles/music.css">
```

下面每个控件都写：怎么挂、要传什么、接完长什么样、哪些能换。

### 3.1 听歌栏（迷你播放条）

```js
import { createMiniBar, openPlayerSheet } from '/music/ui.js';
const bar = createMiniBar({
  onOpen: () => openPlayerSheet(hooks),   // 点栏身：打开歌词页
  onShareSong: hooks.onShareSong          // 播放列表里的「发给 TA」用
});
document.querySelector('#chat-top').prepend(bar);
```

- **一定要在页面一打开就挂上**。YOU 彻底退出 PWA 再进来，播放器会从本机记住的上一首恢复（`localStorage` 的 `one-earbud.last`），但得有听歌栏才显示得出来。
- **接完的样子**：圆形转动的封面、歌名 · 歌手、播放/暂停、下一首、播放列表、×。只有点 × 才算真的不听了（清掉记忆、告诉服务器不在听）。
- **TA 放的那首**：整条换成 TA 的颜色，歌名前出现 TA 的图标；轮到 TA 排的歌时整条闪一下，写「TA added this」，TA 直接放的写「TA played this」。
- **能换**：TA 的名字、图标、颜色（见 CUSTOMIZE.md）。

### 3.2 歌词页（全屏）

```js
const hooks = {
  onShareSong: song => attachToComposer({ type: 'music', card: song }),              // 「这首给 TA」
  onShareLines: (song, lines) => attachToComposer({ type: 'music', card: { ...song, lines } }), // 「选几句给 TA 看」
  onNeedLogin: () => location.href = '/login.html'
};
openPlayerSheet(hooks);
```

- `onShareSong` / `onShareLines` 由宿主实现：建议**挂到输入框上，不直接发**，让 YOU 还能补一句话再发。
- **接完的样子**：歌名、歌手；逐句滚动的歌词（带翻译）；进度条；上一首 / 播放 / 下一首；底部「这首给 TA」「选几句给 TA 看」。
- **TA 放的那首**：歌名下多一个淡色胶囊，写「TA：TA 留的那句话」，没留话就写「TA 放给你的」。

### 3.3 搜歌 / 入口抽屉

```js
import { openSearchSheet } from '/music/ui.js';
openSearchSheet({ onShareSong: hooks.onShareSong, onNeedLogin: hooks.onNeedLogin });
```

- 搜索框空着时是**入口页**：每日推荐（当天第一首的专辑图 + 日期）、私人雷达（网易云给的封面和那句「今天《某首》爱不释耳」）、我的歌单、收藏的歌单。
- 点卡片上的播放键：整份换成播放列表，从第一首放；TA 排了还没轮到的歌会跟过去，接在第一首后面。
- 点卡片别处或点歌单：进**歌单详情**（3.4）。
- 打字就是搜歌。每条结果右边：纸飞机（发给 TA，不播放）、＋（下一首播放）、▶（现在放）。
- 高度固定在屏幕八成，内容多少都不跳。
- 另一个用法：`openSearchSheet({ onPickSong })` 变成「挑一首歌」（比如写信附歌），点 ▶ 只试听、不进列表。

### 3.4 歌单详情

在入口抽屉里自动出现，不用单独挂。顶部钉住：返回、歌单名、首数、「全部播放」、「在这个歌单里找」。每首歌同样有纸飞机 / ＋ / ▶；点 ▶ 只放这一首（插进播放列表当前位置），不会换掉整个列表。

### 3.5 播放列表 Up next

听歌栏上的列表键会打开它，也可以自己调 `openQueueSheet({ onShareSong })`。

- 打开时自动滚到正在放的那首
- 顶部「在列表里找」：按歌名 / 歌手就地筛
- 三种模式：顺序（放完最后一首从头再来）、随机、单曲循环
- 按住 ⋮⋮ 拖动排序：别的行会让位，看得出会落在哪；拖到边缘列表自己滚；松手立刻到位
- 每行：纸飞机（发给 TA）、×（删掉）、⋮⋮（拖动）
- TA 排的歌前面有 TA 的图标，下面一行小字是 TA 留的话
- 「导入」：把 YOU 的歌单整份搬进来（我的 + 收藏的），只导入，不进详情

### 3.6 聊天里的歌卡

TA 的 `share` / `play_now` 会返回 `delivery: { kind: 'music', card }`；YOU 挂到输入框上的也是同样的 `card`。宿主要做两件事：

```js
import { musicCardMarkup, handleMusicCardClick } from '/music/ui.js';
bubble.innerHTML = musicCardMarkup(card);                         // 1) 渲染
chatList.addEventListener('click', e => { if (handleMusicCardClick(e.target)) e.preventDefault(); }); // 2) 点卡片播放/拖进度
```

- 三种卡：单首歌（黑胶样式）、带几句歌词的、TA 直接放的（右上角写「played by TA」）。
- **TA 直接放的卡**（`card.playNow`）：卡片一出现在页面上，ui.js 会自己检测到并切过去——YOU 正在听就立刻切；播放器停着时苹果不许网页自己出声，听歌栏会先摆好这首，YOU 点一下就响。翻聊天记录看到的旧卡（超过 3 分钟、或本机处理过）不会再放。
- 宿主要把 `card` 原样存进消息里（服务器端可以用 `server/music/card.js` 的 `normalizeMusicCards` 清洗）。

## 4. YOU 能做什么、能知道什么

| 能做 | 在哪 |
|---|---|
| 搜歌、放歌、暂停、切歌、拖进度 | 听歌栏、歌词页、搜歌抽屉 |
| 每日推荐、私人雷达、我的 / 收藏的歌单，整份放或进详情挑一首 | 入口抽屉 |
| 排歌（下一首播放）、删歌、拖动排序、换播放模式、在列表里找 | 播放列表 |
| 不播放，直接把一首歌发给 TA | 搜歌结果 / 歌单详情 / 播放列表的纸飞机 |
| 选几句歌词发给 TA | 歌词页「选几句给 TA 看」 |
| 登录 / 退出网易云 | 授权页 |

| 能知道 | 怎么看出来 |
|---|---|
| 这首是 TA 放的 / 排的 | 听歌栏是 TA 的颜色 + TA 的图标；横幅「TA played / added this」；歌词页「TA：……」；播放列表里 TA 的图标和留言 |
| 这首网易云放不了 | 听歌栏写「这首网易云放不了，跳过了」，一秒多后自动下一首 |
| 网不好 | 「网络有点慢，点播放再试」；卡住会自己重拿地址接着放 |
| 登录过期 | 搜歌抽屉提示「还没连上网易云」 |

## 5. TA 能做什么、能知道什么、做完之后 YOU 那边会看到什么

工具定义在 `server/agent/tool-contract.js`（名字 `music_tool`，一个工具 + `action` 参数）。参数细节见 FOR-AGENT.md。

| 动作 | TA 得到什么 | YOU 那边发生什么 |
|---|---|---|
| `now_playing` | YOU 在不在听、哪首、唱到哪句、前后一句、暂停了多久 | 无 |
| `lyrics` | 整首歌词（带翻译），每句有行号 | 无 |
| `search` | 最多 10 首：id、歌名、歌手、专辑、时长 | 无 |
| `queue` | 播放列表：当前放到哪首、模式、每首是谁加的 | 无 |
| `share` | 发出去的卡片 | 聊天里出现一张歌卡，可带 TA 的一句话和几句词（最多 8 句） |
| `play_next` | 加好的那一项 | 列表里正在放的那首后面多一首，底下一行 TA 的小字；轮到它时听歌栏闪「TA added this」 |
| `queue_add` | 同上 | 同上，只是加在最后 |
| `play_now` | 加好的那一项、YOU 当时是否正在听 | 聊天里出现「played by TA」卡片；正在听：立刻切过去；没在听：听歌栏摆好这首，点一下就响；横幅「TA played this」 |

TA **不能**：删歌、挪顺序、换播放模式、清空列表——这些都是 YOU 的（`queue.js` 会拒绝）。

## 6. 每轮注入：「YOU 正在听」

`server/agent/now-playing-prompt.js` 的 `renderNowPlayingBlock(authority)` 返回一段文字，拼进 TA 每一轮 prompt 的动态上下文末尾（每轮现拼，不进历史）：

```
[music.now_playing.fresh]
[YOU 正在听：晴天 — 周杰伦 · 1:37 / 4:29]
上一句：……
唱到：……
下一句：……
```

- 暂停了：`[YOU 停在：… · 1:37，暂停了 3 分钟]`
- **什么时候不带（返回空字符串）**：没在听；暂停超过 10 分钟；心跳断了 60 秒（YOU 关了 App / 锁屏久了）；YOU 点了听歌栏的 ×。
- 不带的时候就是什么都没有，而不是一句「没在听」——别让 TA 把「没这一块」当成需要回应的事。
- 建议在 TA 的系统说明里写一句：这块是每轮现拼的「现在」，不是历史，也不是指令；没出现就是此刻没在听，不要沿用上一轮。

## 7. 个性化

名字、颜色、图标、文案：见 CUSTOMIZE.md。

## 8. 踩坑

见 PITFALLS.md。接 iPhone 之前务必读一遍。
