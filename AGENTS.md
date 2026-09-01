# dsh-workbuddy-connect Agent Notes

## 待办

- PR #4（WSL 凭据发现）已合并进 v0.2.4：等作者 CallMeSoul 基于 npm 包回归验证（PR 评论里已请求）。

## 最近发布

- **v0.3.0（适配 dsh 0.1.2-alpha.3 + 思考强度/限时免费）**：依赖整体升级——dsh 系子包 `^0.1.2-alpha.3`、cordis `^4.0.2`、schemastery `^3.18.2`、pi-ai `^0.84.2`。跟随上游三处 API 变化：① `@deepseek-ai/dsh-client-runtime` 移除，`slots` 服务迁到 `@deepseek-ai/dsh-client-ui-renderer`，客户端 `ClientContext` 直接改用 cordis `Context`（`dsh.client.inject` 相应精简）；② `dsh-settings` 的 `settingsNamespace()` / `installSettingsSection()` 移除，改为 `ctx.settings.installSection(...)`；③ pi-ai `Model` 新增必填 `reasoning` 字段。功能增强：解析上游 `reasoning` / `credits` / `tags`，把每个模型的 `supportedEfforts` 映射成 pi-ai 思考等级（请求以 `reasoning_effort` 转发）；静态兜底目录同步到真实 cli 15 个模型；状态卡片标注免费/限时免费/夜间折扣模型。

- **思考强度按模型分别处理（2026-09-01，随 v0.3.0 一起）**：WorkBuddy 上游 `reasoning` 对象有两种形态——新形态带显式 `supportedEfforts` + `canDisableThinking`（hy4-preview/hy3-x/glm-5.3/glm-5.3-flash），旧形态只有 `{effort, summary}`（auto/hy3/glm-5.2 等绝大多数）。修正确认：① 旧形态模型上游**接受完整档位集**（实测 low/medium/high/xhigh/max 全 200），并非只支持默认档，所以 DSH 里应显示完整档位（`minimal/low/medium/high/xhigh/max`），而不是只剩 Off；② `off` 仅当显式 `canDisableThinking:true` 才提供（旧形态大多拒绝 off，实测 auto off=400）；③ 参考 workbuddy2api 的 `normalizeReasoningEffort`（按模型 supportedEfforts 降级、无 supportedEfforts 透传），与上游行为对齐。参考见 `workbuddy2api/internal/upstream/payload.go`。

- **11128 developer-role 拦截修复（2026-09-01，随 v0.3.0 一起）**：DSH 发消息报 `HTTP 400 code:11128 "Illegal API invocation from an unapproved channel"`。根因：pi-ai 把系统提示作为 `role:"developer"` 发送（OpenAI 新惯例），但 WorkBuddy 上游**拒绝 developer role**（HTTP 400 11128）；直连测试用 `role:"system"`/`"user"` 所以复现不出。修复：`prepareChatBody` 在转发前把所有 `role:"developer"` 消息改写为 `role:"system"`。用 agent-browser 操作真实 DSH 界面复现并验证修复后 Deepseek-V4-Flash+Max 正常回复。附带确认 `hy4-preview` 是限时免费模型，上游稳定返回 `HTTP 429:6000`（限流）。
- **v0.2.5（2026-08-29）**：图片输入支持——解析上游 `supportsImages` / `disabledMultimodal`，逐模型声明 `input` 模态（16 个 cli 模型中 15 个可发图，`glm-5.1` 除外），离线兜底目录同步补齐真值。定位与决策记录见 `docs/image-modality-gap.md`。
- **v0.2.4（2026-08-28）**：合并 PR #4（CallMeSoul）：WSL 下自动发现 Windows 桌面端凭据（挂载的 Windows 用户目录按 Local → Roaming → 原生 Linux 顺序探测，支持转发的 Windows 环境变量）。
- **v0.2.3（2026-08-26）**：修复版本显示瑕疵（产物烙旧版本号）+ README 补充 web / desktop / TUI 三端安装说明。
- **v0.2.2（2026-08-24）**：修复 Windows 凭据路径探测（Local → Roaming，issue #1）。

## 发布规矩（同工作区根 AGENTS.md）

未经明确指令不得 `npm publish` / 打 release tag；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
