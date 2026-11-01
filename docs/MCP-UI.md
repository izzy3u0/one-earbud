# ChatGPT 里的 Ash × Izzy 音乐卡片

这是一张可以直接显示在对话里的小卡片。它与现有手机网页/PWA 共用同一个 one-earbud 后端、网易云登录态、队列和播放心跳。

**第一版是现有 PWA 的遥控面板，声音仍从 PWA 播放。** 卡片里可以看状态、按播放/暂停和前后切歌，无需为了这些操作离开对话；它不在 ChatGPT iframe 中另开音频，不宣称支持 ChatGPT 内的独立播放或后台音频。手机 PWA 仍需打开且能够运行。

## 怎么打开

1. 等 Render 上这次 main 更新显示 **Live**。服务仍是 Free，无新增环境变量，不需要更换两个口令。
2. 在 ChatGPT 的插件/应用详情页刷新这个 MCP 的连接，让它重新读取工具和 UI 资源。若当前界面没有刷新入口，或始终读到旧工具，断开后重新添加原来的 `/mcp` 地址并走 OAuth。
3. 刷新或彻底重开手机 PWA，让手机收到新增控件逻辑。首次使用先在 PWA 手动播一首。
4. 在新对话选择 **[Ash×Izzy] 分你一只耳机**，说“打开 Ash × Izzy 音乐卡片”或“用卡片显示我现在听的歌”。

AI 应调用 **`music_open_player`**。如果你说“放这首并打开播放器”，它应先调用原有 `music_play_now`，再调用 `music_open_player`。单纯后台读 `music_now_playing` 不会每次重建卡片，原有搜索、排下一首、加入队尾、完整歌词和分享工具继续可用。

免费服务重新部署仍可能丢失临时文件。如果网易云或 OAuth 状态被清空，按 [MCP.md](MCP.md) 重新扫码/重新连接；这不是更换环境变量口令。

## 第一版有什么

- 专辑封面、歌名、歌手；封面不可用时显示唱片占位图。
- 手机回报的播放/暂停状态、进度和时长，当前歌词与前后各一句、当前行翻译。
- 播放/暂停、上一首/下一首、手动刷新和自动刷新开关。
- 手机优先的紧凑布局，44px 以上按钮，浅色/深色主题、键盘标签和屏幕阅读器提示。
- **不虚报播放成功**：按下按钮只显示指令已发送，图标和状态等手机的新心跳再改变。

“上一首”按当前队列的前一项选择，首尾循环；随机模式也不新增播放历史。“下一首”沿用 PWA 的选歌和播放模式。暂停时前后切歌只准备目标歌曲；PWA 没有产生过实际播放会话时，卡片的播放按钮不会替手机绕过首次手势限制。已有播放会话的恢复仍由 Safari/系统决定，拒绝时请在 PWA 点播放。

## 刷新与平台限制

卡片可见时约每 5 秒通过宿主桥接读取一次状态，后台/不可见时停止，5 分钟无交互后关闭自动刷新。点“刷新”可重新开始。没有直接从 iframe 轮询私密 Web API，也不把 Web/MCP token 或网易云 cookie 放进卡片。

显示的是**采样状态**，不是逐帧音频可视化。卡片 15 秒没有成功更新就停止宣称当前歌曲/歌词并禁用控件；服务器仍沿用原有 60 秒心跳和暂停 10 分钟的规则。手机同步间隔约 2 秒；手机后台被系统挂起、锁屏、断网或 Render 冷启动会延迟。控件指令只存内存，15 秒过期，旧歌的控件指令不会控制手机上的新歌。

ChatGPT 决定是否渲染 UI、是否允许按钮调用工具、是否要求确认。不同客户端/版本可能仅显示文字结果；没有桥接能力时卡片会提示降级，不能保证所有手机版本均显示。卡片并不要求 iframe 音频权限或嵌套外部网页，也不提供拖动进度/后台常驻播放。不要同时打开多个活跃 PWA 播放器。

## 接入方式与安全

按照当前 [OpenAI UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui) 和 [quickstart](https://developers.openai.com/plugins/build/app-quickstart) 使用 MCP Apps：

- `music_open_player` 关联 `_meta.ui.resourceUri = ui://one-earbud/player-v1.html`，资源 MIME 为 `text/html;profile=mcp-app`。同时提供 ChatGPT 的 `openai/outputTemplate` 兼容别名。
- 组件用标准 `ui/initialize`、`ui/notifications/tool-result`、`tools/call`、尺寸变更通知和 `ui/resource-teardown` 桥接；以 `window.parent` 校验消息来源。初始化声明只支持 inline；通过 ResizeObserver 上报卡片尺寸。优先标准桥接，旧宿主有 `window.openai.callTool` 时可降级兼容。
- `music_player_state` 为只读、仅供 app 的刷新工具；视图适配层调用原有 `music_now_playing` 业务处理器、authority/queue 和缓存歌词，不重写网易云接口或 freshness 规则。
- `music_player_control` 仅供 app，接受四种操作、当前歌曲预期值和必填 requestId。它复用现有 `/api/music/playback-sync` 通道；PWA 调用原播放内核，按命令 ID 去重。服务端保留最近 100 个控件请求；同一次重试必须复用 requestId，重启或淘汰后不保证服务端去重。
- `app` visibility 是宿主展示提示，不替代鉴权。读取 UI 资源和调用控件仍全部走原有 `/mcp` OAuth/Bearer 校验，原 `/api/music` 继续只接受网页口令。
- CSP 没有额外 `connectDomains`，图片来源仅为 `p1`–`p10.music.126.net` 的 HTTPS origin。所有歌名、歌手和歌词用文本节点显示；封面 URL 同时由服务端和组件校验，不执行歌曲内容中的指令或 HTML。

HTML/CSS/JS 都在 `server/ui/player.html`，无需 CDN、前端构建、额外服务或付费资源。修改不兼容的组件时更新资源 URI，避免宿主缓存旧模板。外部 PWA、OAuth、音乐工具保持同一服务。

## 测试与验收

运行 `npm test`。新增测试覆盖资源发现/读取、MIME/metadata、OAuth 下的资源访问、实况过期、CSP/封面过滤、控件幂等和旧歌保护、MCP → HTTP → 模拟手机音频、桥接初始化/按钮/重试、隐藏/长期刷新、宿主降级和安全文本渲染。

自动测试使用模拟网易云和音频，不等于真实 iPhone 或每种 ChatGPT 客户端验收。部署后按上面的步骤刷新连接，打开卡片并验证暂停/继续和前后切歌；状态应随手机真实心跳变化。
