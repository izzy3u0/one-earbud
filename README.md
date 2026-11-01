# 分你一只耳机 · one-earbud

两个人一人塞一只耳机，听同一首歌。

这是一个让你的 AI 伴侣（下文叫 **TA**）和你（下文叫 **YOU**）一起听网易云音乐的小工具：

- YOU 在手机网页里听歌：搜歌、每日推荐、私人雷达、导入和浏览歌单、播放列表（顺序 / 随机 / 单曲循环、拖拽排序、列表内搜索）
- TA 每一轮对话都能看到 YOU 正在听哪首、唱到哪一句、前后一句是什么
- TA 能读整首歌词、搜歌、把一首歌或几句词作为卡片发给 YOU、把歌排进 YOU 的播放列表，或者直接给 YOU 放一首
- YOU 一眼看得出哪首是 TA 放的：听歌栏换成 TA 的颜色和图标，歌词页写着 TA 留的那句话
- YOU 也能不播放、直接把一首歌或选几句歌词发给 TA

它不是一个独立 App，而是一组可以挂进你现有「聊天页 + Agent」的零件：一个后端模块、一组前端控件、一个给 TA 的工具、一段每轮注入的 prompt。

## 五步跑起来（最小可跑）

**ChatGPT + 独立手机播放器 / PWA + Render 部署：请先看 [docs/MCP.md](docs/MCP.md)。** 本分支保留原组件接入方式，并提供可直接打开的 `/` 听歌首页，以及带独立鉴权的远程 `/mcp`。使用 Node 22+。

**ChatGPT 对话内音乐卡片：见 [docs/MCP-UI.md](docs/MCP-UI.md)。** `music_open_player` 打开 Ash × Izzy 小卡片，显示实况并遥控现有 PWA；声音继续来自 PWA。

```bash
git clone https://github.com/izzy3u0/one-earbud.git && cd one-earbud
npm install
cp .env.example .env        # 填两个不同的长随机口令 ONE_EARBUD_TOKEN / MCP_AUTH_TOKEN
npm start                   # 默认 http://localhost:8787
```

1. 打开 `http://你的服务器:8787/login.html`，用网易云 App 扫码登录
2. 打开 `/` 保存网页口令，使用现成的听歌页；也可在自己的聊天页挂组件（见 docs/INTEGRATION.md 第 3 节）
3. 搜一首歌，点播放，听到声音——跑通了

之后再一步步接：播放列表和歌单 → 把 TA 接进来 → 换成你们自己的名字、颜色和图标。每一步做完都能用，也可以停在任何一步。

## 文档

| 文档 | 给谁看 | 讲什么 |
|---|---|---|
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | 人和机 | 主文档：整体结构、授权页、每个前端控件怎么接、YOU 和 TA 各自能做什么 |
| [docs/FOR-AGENT.md](docs/FOR-AGENT.md) | 机 | TA 的工具：每个动作的参数、返回、失败，以及 YOU 那边会看到什么 |
| [docs/CUSTOMIZE.md](docs/CUSTOMIZE.md) | 人 | 名字、颜色、图标、文案，哪些能换、在哪换 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 人和机 | 真实踩过的坑，尤其是 iPhone 上的 |
| [docs/SECURITY.md](docs/SECURITY.md) | 人 | 登录信息存在哪、什么绝不能提交、免责 |
| [docs/MCP.md](docs/MCP.md) | 人和机 | ChatGPT、远程 MCP、手机切歌、Render Free 部署和临时数据 |
| [docs/MCP-UI.md](docs/MCP-UI.md) | 人和机 | ChatGPT 内嵌音乐卡片、刷新连接、手机控件与平台限制 |

## 测试

```bash
npm test     # 原有测试 + MCP/OAuth/手机同步集成 + 播放器模拟
```

## 说明

本项目使用网易云音乐的非官方网页接口，仅供个人和自己的 TA 使用，请勿商用；歌曲版权归各自权利人。详见 docs/SECURITY.md。
