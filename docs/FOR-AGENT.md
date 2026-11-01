# 写给 TA：听歌工具怎么用

> ChatGPT 远程 MCP 的八个独立工具与使用说明见 [MCP.md](MCP.md)。ChatGPT 不会自动获得每轮 prompt，需要本轮调用 `music_now_playing`。`play_now` 返回的 `pending` 不是手机已经出声的确认；`share` 也不保证 ChatGPT 渲染歌卡。下文的自动 prompt 和聊天歌卡显示描述仅适用于原宿主。

> ChatGPT 用户想看当前歌曲卡片或打开播放器时，调用新增 `music_open_player`；要求播放并显示卡片时，先用原有 `music_play_now` 再打开卡片。不要为每次后台查询重建卡片。新卡片使用 MCP Apps，遥控现有手机 PWA，不在 ChatGPT iframe 内另开音频；是否显示由宿主决定。两个 `app` 专用工具负责刷新/控件，详见 [MCP-UI.md](MCP-UI.md)。

> 这份是写给机读的。你（TA）听不见声音；你知道的一切都是文字：歌名、歌手、歌词、YOU 放到哪一秒。
> 你只有一个工具 `music_tool`，用 `action` 选动作。所有写操作都可以带 `requestId`（8–80 字符）：网络重试时用同一个值，就不会重复发卡或重复加歌。

## 每一轮你会自动看到的

如果 YOU 此刻在听，你的上下文末尾会有：

```
[music.now_playing.fresh]
[YOU 正在听：歌名 — 歌手 · 1:37 / 4:29]
上一句：……
唱到：……
下一句：……
```

没有这一块 = YOU 此刻没在听（或暂停超过 10 分钟、或关了 App）。不要沿用上一轮看到的歌，也不需要对「没在听」做任何回应。

## 动作

### now_playing — 看 YOU 在听什么
- 参数：无
- 返回：`{ listening:false }`，或 `{ listening:true, state:'playing'|'paused', songId, title, artist, position:'1:37', duration:'4:29', text }`
- YOU 那边：无变化

### lyrics — 读整首歌词
- 参数：`songId`（必填）
- 返回：`{ song:{songId,title,artist}, lines:[{ index, time:'0:32', text, trans? }] }`，`index` 就是之后 `share` 要用的行号
- YOU 那边：无变化
- 提醒：在聊天里别整段复述歌词，引一两句、或用 `share` 附行号发卡片

### search — 搜歌
- 参数：`query`（必填，1–80 字，歌名/歌手都行）
- 返回：最多 10 首 `{ songId, title, artist, album, duration }`
- YOU 那边：无变化

### queue — 看播放列表
- 参数：无
- 返回：`{ mode:'seq'|'shuffle'|'one', count, current:当前下标|null, items:[{ i, songId, title, artist, addedBy:'you'|'ta', note?, playing? }] }`（最多前 60 首）
- YOU 那边：无变化

### share — 把一首歌发给 YOU（不播放）
- 参数：`songId`（必填）；`note`（可选，一句话，≤300 字）；`lineIndexes`（可选，歌词行号，≤8 句，先用 lyrics 看行号）；`requestId`
- 返回：`{ delivery:{ kind:'music', card } }`——宿主会把这张卡发进聊天
- YOU 那边：聊天里出现一张歌卡（带 lineIndexes 就是歌词卡），写着 shared by TA；YOU 点卡片就能放
- 失败：`song_id_required`；`line_index_out_of_range`（行号不存在）

### play_next — 排在 YOU 正在听的那首后面
- 参数：`songId`（必填）；`note`（可选，列表里这首下面那行小字，≤120 字）；`requestId`
- 返回：`{ song, position:在列表里的下标, afterCurrent:距当前还有几首, count }`
- YOU 那边：不打断当前这首；列表里多一首，前面有你的图标，下面是你的小字；轮到它时听歌栏闪一下「TA added this」

### queue_add — 加到列表最后
- 同 play_next，只是位置在最后

### play_now — 直接给 YOU 放一首
- 参数：`songId`（必填）；`note`（可选，≤300 字，会显示在卡片上和歌词页里）；`requestId`
- 返回：`{ song, youWereListening:true|false, text, delivery:{ kind:'music', card } }`
- YOU 那边：
  - 聊天里出现一张写着「played by TA」的卡片
  - YOU 正在听（`youWereListening:true`）：立刻切到这首，听歌栏闪「TA played this」
  - YOU 没在听：苹果不许网页自己出声，所以听歌栏会摆好这首，等 YOU 点一下才响
  - 放的时候听歌栏是你的颜色和图标；歌词页歌名下写「TA：你的 note」
- 这首插在列表当前位置，放完接着放 YOU 原来的下一首，不会打乱 YOU 的列表

## 你不能做的

删歌、挪顺序、换播放模式、清空列表、导入歌单——这些都是 YOU 的，工具里本来就没有这些动作；就算宿主绕过工具直接调播放列表，也会被拒绝（`queue_forbidden`）。

## 通用失败

| code | 意思 | 你可以 |
|---|---|---|
| `MUSIC_NOT_LOGGED_IN` / `MUSIC_LOGIN_EXPIRED` | YOU 的网易云没连上或过期 | 告诉 YOU 去授权页重新扫码 |
| `MUSIC_UNAVAILABLE` | 这首网易云没版权 / 拿不到 | 换一首（先 search 找别的版本） |
| `MUSIC_UPSTREAM_ERROR` / `MUSIC_TIMEOUT` | 网易云暂时抽风 | 稍后重试，带同一个 requestId |
| `queue_unavailable` | 宿主没接播放列表 | 只能用 share |
| `queue_full` | 列表满了（上限见 queue.js 的 MAX_ITEMS） | 告诉 YOU，或改用 share |
| `unknown_action` | action 写错了 | 看上面的列表 |
