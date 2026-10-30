# MCP 改造完成记录

代码已在当前本地 `main` 分支实现并提交。主实现提交：`2f47e66`。未修改上游仓库。

验证结果：`npm test` 全通过（33 个后端/集成测试 + 22 个播放器场景）；依赖审计 0 个已知漏洞；`git diff --check` 通过；文件/凭证扫描未发现真实 token、登录态或 data 被纳入提交。

`npm start` 在生产配置、独立测试口令和隔离数据目录下启动通过。`/healthz`、`/`、`/login.html`、已鉴权的 Web API、MCP initialize 均返回 200；未鉴权 `/mcp` 返回 401。

网易云接口使用 mock；没有使用真实账号扫码，也没有在真实 iPhone/Safari 或 Render 公网实例上验收。手机端集成验证使用真实 HTTP 服务、官方 MCP 客户端和模拟 audio 元素，覆盖播放中切歌、暂停/关闭后只准备歌曲、队列同步、过期/被取代的指令、重复请求与歌卡去重。

上传状态：Git CLI 推送遇到网络连接失败；已连接的 GitHub 集成在创建文件树时返回 403 `Resource not accessible by integration`。因此 GitHub 上的 main 仍未包含本次改造。需要恢复仓库写入授权或本机 Git 推送能力后，将本地提交推到 `izzy3u0/one-earbud`，再让 Render 拉取。

部署步骤、变量、URL 和 ChatGPT instruction 见 [MCP.md](MCP.md)。

## 新增文件（15）

- `.node-version`：Node 22。
- `docs/MCP.md`：部署、连接、验证和故障排查。
- `docs/MCP-CHANGES.md`：本完成记录和完整文件清单。
- `server/app.js`：可测试的单服务应用工厂、Web/API/MCP/healthz。
- `server/auth.js`：Bearer 解析和常量时间口令比较。
- `server/mcp.js`：官方 SDK Streamable HTTP，八个音乐工具适配。
- `server/oauth.js`：ChatGPT OAuth/PKCE、DCR、授权页和持久化令牌哈希。
- `server/music/playback-sync.js`：短期远程播放指令。
- `server/test/mcp.test.js`：MCP、鉴权、幂等、泄漏检查和 OAuth 集成测试。
- `server/test/remote-player.test.js`：MCP 到手机播放器的 HTTP 集成测试。
- `web/app.js`：复用现有组件的独立听歌页入口。
- `web/index.html`：手机听歌首页和网页口令表单。
- `web/icon.svg`：PWA 图标。
- `web/manifest.webmanifest`：主屏幕独立窗口配置。
- `web/sw.js`：不缓存私密 API/音频/旧脚本的 service worker。

## 修改文件（20）

- `.env.example`：独立 MCP 口令、公网 URL、可选 OAuth 回调、挂盘说明。
- `.gitignore`：排除环境文件、登录态和 OAuth 私密文件。
- `README.md`：本分支运行入口和 MCP 文档链接。
- `docs/FOR-AGENT.md`：区分 ChatGPT 工具和原宿主自动上下文。
- `docs/INTEGRATION.md`：说明新播放指令通道。
- `docs/SECURITY.md`：MCP/Web 口令隔离及私密文件边界。
- `package.json`：官方 MCP SDK、schema、dotenv、OAuth 限流依赖，Node 22+。
- `package-lock.json`：锁定依赖并应用安全修复。
- `server/agent/tool-contract.js`：复用原动作、合并并发重试、结构化当前歌词和发布播放指令。
- `server/example-server.js`：dotenv、PORT、0.0.0.0、关闭流程。
- `server/music/authority.js`：共享现有队列、心跳、歌词缓存，提供播放同步。
- `server/music/queue.js`：直接播放的留言保留到 300 字。
- `server/music/routes.js`：受原鉴权保护的同步读接口，减少错误日志敏感信息。
- `server/test/authority.test.js`：Windows/POSIX 权限断言兼容，Linux 保持 0600 校验。
- `server/test/player-sim.scenarios.mjs`：场景失败时正确返回非零退出码。
- `web/lib/api.js`：请求超时，防止轮询永久卡死。
- `web/login.html`：保存网页口令、返回播放器入口。
- `web/login.js`：独立播放器跳转。
- `web/music/player.js`：两秒同步、播放会话内切歌、未播放时预备、暂停心跳、指令去重。
- `web/music/ui.js`：歌卡与远程轮询共用播放去重记录。
