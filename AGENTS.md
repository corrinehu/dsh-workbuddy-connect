# dsh-workbuddy-connect Agent Notes

## 待办

- PR #4（WSL 凭据发现）已合并进 v0.2.4：等作者 CallMeSoul 基于 npm 包回归验证（PR 评论里已请求）。
- 多账户支持（本地工作树，未发版）：真机 DSH（web/desktop/TUI）尚未回归——`settings-integration.spec` 覆盖了 apply 装配，但动态 provider 注册（`workbuddy:<key>` 多 provider 并存）需在真实模型选择器里确认分组显示。

## 多账户支持（2026-09-03，本地工作树）

目标：多个 WorkBuddy 账号共存、按需切换，实现不间断使用。设计（用户选定）：**模型列表按账号分组 + 插件自管多账户（快照式导入）**。

- **快照模型**：桌面 App 同时只有一个登录态，插件不凭空登号。用户在桌面登录 A → CLI `import a` 把当前登录态快照进 `$DSH_HOME/.workbuddy-auth/<key>.json`（version 1 own 格式，同单账户副本）；桌面切登 B → `import b`。每个 key 一个独立 `WorkBuddyCredentialStore`（`WorkBuddyAccountManager.storeFor`），刷新互相独立。
- **账户隔离红线**：账户 store 的 `desktopPath` 指向 sentinel 不存在路径（`.workbuddy-auth/.no-desktop`），**永不回落探测真实桌面文件**——否则桌面后续换登别的账号会泄漏进所有已导入账户（冒烟实测踩过）。
- **provider 分组**：`Config.accounts`（string[]）非空时，每个 key 注册独立 provider `workbuddy:<key>`（displayName `WorkBuddy · <key>`），baseUrl 编码账号 `/v1/<key>`；`accounts` 为空保持单账户 legacy（provider `workbuddy`）完全不变。
- **shim 路由**：`/v1/<key>/chat/completions`（multi）/ `/v1/chat/completions`（legacy），shim 按 `instanceof` 区分 `WorkBuddyCredentialStore | WorkBuddyAccountManager`；`/v1/<key>/models` 同目录。
- **CLI**：`accounts`（列表，--json 可用）、`import <key> [label] [--force]`（快照当前桌面登录，默认拒绝覆盖已有 key）、`remove <key>`。
- **顺手修的三个原版 bug**（均被新测试暴露）：
  1. `parseOwnDocument` 复用 `parseWorkBuddyAuth` 读 `auth['expiresAt']`，而 own 格式写的是 `expiresAtMs` → own 回读过期时间恒 0 → 单账户模式下 `needsRefresh` 恒真、**每个请求都打一次 refresh 端点**，且刷新副本永远竞争不过未过期桌面文件。改为专用驼峰解析。
  2. 同路径下 uid/nickname/enterpriseId 在 own 往返后丢失 → 账户快照模式无桌面兜底，请求会退化成 `X-No-User-Id: 1`。专用解析同时修复。
  3. `saveOwn` 不建父目录 → 首次写 `.workbuddy-auth/<key>.json` 时锁文件 ENOENT。加 `mkdir -p`。
- **测试**：`tests/multi-account.spec.ts`（manager 发现/导入/隔离/解析/删除/seedOwn）+ `tests/shim-multi-account.spec.ts`（keyed 路由、未知 key 401、manager 拒 bare path）。全部用临时 `DSH_HOME`，不碰真机凭据。
- **已知取舍**：label 仅在 import 成功提示里回显，不持久化（own 格式没这字段，避免 version 升级）；新导入的账号要出现在模型选择器需重启 DSH（provider 在 apply 时注册，无运行时热注册/目录监听）。

## 最近发布

- **v0.2.6（2026-09-02）**：PR #9（winliyou）回移费率显示与思考强度 + 跟进调整。**思考强度改为「仅声明集」（#9 跟进）**：#9 对无 `supportedEfforts` 声明的旧形模型（`{effort, summary}` 形态，11 个）回退到完整 pi-ai 梯度，含 `minimal`——但 `minimal` 既不在其实测清单（low/medium/high/xhigh/max，且只实测了 auto 一个模型）也不在上游 effort 词汇表；App 端对旧形模型本身区别对待（GLM-5.2 有思考控件、MiniMax-M3 / Kimi-K2.6 没有），可选集是客户端私有知识；workbuddy2api 亦按声明门控、出集降级而非透传。故调整为「仅声明集」：有 `supportedEfforts` 的 4 个模型（hy4-preview / hy3-x / glm-5.3 / glm-5.3-flash）按声明暴露档位，其余模型不暴露思考控件、请求不带 `reasoning_effort`，上游用自己的默认档（与 #9 之前行为一致）。后续若抓包确认客户端对旧形模型实际发送的值，再按证据逐模型放开。

- **回移 alpha 分支的费率显示与思考强度（PR #9）**：把 alpha 分支（5a5fac6）里除「适配 dsh 0.1.2-alpha.3」之外的功能搬回稳定线——依赖仍锁 `dsh 0.1.1-rc.2` / pi-ai `0.82.1`，客户端仍走 `@deepseek-ai/dsh-client-runtime` 的 `ClientContext`，设置段仍用 `settingsNamespace()` / `installSettingsSection()`。搬过来的四块：① 费率显示（`normalizeCredits` + `WorkBuddyPiAiAdapter` 覆写 `listModels`/`resolveModel`）；② 上游 `reasoning` / `credits` / `tags` 解析与逐模型思考强度；③ `developer` → `system` 角色改写（HTTP 400 11128）；④ 兜底目录同步到 15 个 cli 模型。已确认旧依赖同样支持：`dsh-llm-pi-ai` 0.1.1-rc.2 的 `PiAiAdapter.listModels/resolveModel` 可被覆写，pi-ai 0.82.1 有 `ModelThinkingLevel` / `ThinkingLevelMap` 且 `openai-completions.js` 转发 `reasoning_effort`（第 634 行）、发 `developer` role（第 788 行）。

- **费率显示（实现要点，随 v0.3.0-alpha.0 引入，本次回移）**：模型选择列表里每个模型名直接带积分倍率（`GLM-5.2 · x0.79`），`/model` 弹窗与 composer 下拉都可见；设置卡片「模型优惠」补上倍率行。① `normalizeCredits`（`src/upstream.ts`）把上游 `x0.79 credits` 归一成语言无关的 `x0.79`——host 侧 LLM seam 无 locale 服务，任何文案都会原样进浏览器，所以必须去掉 `credits` 单位词；② `src/adapter.ts` 子类化 `PiAiAdapter`（`WorkBuddyPiAiAdapter`）覆写 `listModels` / `resolveModel`，把费率拼进 `name`（分隔符用 ` · `，模型名本身含连字符）并同时放进 `description`——因为 DSH 的 `/model` 弹窗渲染 `description` 而 composer 的 ModelSelect 只渲染 `name`，两者都要覆盖；③ 费率只改显示字段：pi-ai 请求体用 `model.id`（`openai-completions.js` 两处 `model: model.id`），选择回传也是 id，`dsh-llm` 对 name 只校验非空字符串，已确认无按 name 的查找/比对逻辑；④ 卡片侧走浏览器 locale（`rate` 键：`{rate} 积分/次` / `{rate} credits per message`），host 只传归一化后的 `credits` 字段。

- **思考强度按模型分别处理（2026-09-01，本次回移）**：WorkBuddy 上游 `reasoning` 对象有两种形态——新形态带显式 `supportedEfforts` + `canDisableThinking`（hy4-preview/hy3-x/glm-5.3/glm-5.3-flash），旧形态只有 `{effort, summary}`（auto/hy3/glm-5.2 等绝大多数）。修正确认：① 旧形态模型上游**接受完整档位集**（实测 low/medium/high/xhigh/max 全 200），并非只支持默认档，所以 DSH 里应显示完整档位（`minimal/low/medium/high/xhigh/max`），而不是只剩 Off；② `off` 仅当显式 `canDisableThinking:true` 才提供（旧形态大多拒绝 off，实测 auto off=400）；③ 参考 workbuddy2api 的 `normalizeReasoningEffort`（按模型 supportedEfforts 降级、无 supportedEfforts 透传），与上游行为对齐。参考见 `workbuddy2api/internal/upstream/payload.go`。

- **11128 developer-role 拦截修复（2026-09-01，本次回移）**：DSH 发消息报 `HTTP 400 code:11128 "Illegal API invocation from an unapproved channel"`。根因：pi-ai 把系统提示作为 `role:"developer"` 发送（OpenAI 新惯例），但 WorkBuddy 上游**拒绝 developer role**（HTTP 400 11128）；直连测试用 `role:"system"`/`"user"` 所以复现不出。修复：`prepareChatBody` 在转发前把所有 `role:"developer"` 消息改写为 `role:"system"`。用 agent-browser 操作真实 DSH 界面复现并验证修复后 Deepseek-V4-Flash+Max 正常回复。附带确认 `hy4-preview` 是限时免费模型，上游稳定返回 `HTTP 429:6000`（限流）。

- **v0.2.5（2026-08-29）**：图片输入支持——解析上游 `supportsImages` / `disabledMultimodal`，逐模型声明 `input` 模态（16 个 cli 模型中 15 个可发图，`glm-5.1` 除外），离线兜底目录同步补齐真值。定位与决策记录见 `docs/image-modality-gap.md`。
- **v0.2.4（2026-08-28）**：合并 PR #4（CallMeSoul）：WSL 下自动发现 Windows 桌面端凭据（挂载的 Windows 用户目录按 Local → Roaming → 原生 Linux 顺序探测，支持转发的 Windows 环境变量）。
- **v0.2.3（2026-08-26）**：修复版本显示瑕疵（产物烙旧版本号）+ README 补充 web / desktop / TUI 三端安装说明。
- **v0.2.2（2026-08-24）**：修复 Windows 凭据路径探测（Local → Roaming，issue #1）。

## 发布规矩（同工作区根 AGENTS.md）

未经明确指令不得 `npm publish` / 打 release tag；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
