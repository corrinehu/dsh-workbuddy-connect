# dsh-workbuddy-connect Agent Notes

## 待办

- PR #4（WSL 凭据发现）已合并进 v0.2.4：等作者 CallMeSoul 基于 npm 包回归验证（PR 评论里已请求）。
- 0.3.0 发布时：`adapt/dsh-0.1.2` 分支合回 main（**push 前必须请用户批准**），并把本地 main 上未推的 db412fd（push 规矩）一并带上。
- TUI 验证：等 `@deepseek-harness-tui/dsh-tui` 发布 0.1.2 适配版（修复已合并其仓库 #703，未发版）后，tui profile 验证 0.3.0。
- web profile 还原：其他第三方插件适配 0.1.2 后，从 `package.json.bak-bundles-full` 恢复完整 bundle 列表。
- 桌面 App 本机升级 2.0.5（已适配 0.1.2-rc.1；升级会使 `dsh-desktop-patches` 补丁失效，需重跑脚本——见工作区根 AGENTS.md）。

## 最近发布

- **0.3.0 测试环境（2026-09-04，未发布）**：
  - **代码在哪**：适配相关改动全在本地分支 `adapt/dsh-0.1.2`。之前误推过 main 一次，已回退，远端 main 还是 0.1.1 兼容版。发布时把分支合回去（push 前照例先问用户）。
  - **升级 runtime 的坑**：`dsh-runtime` 换版本号后必须删掉 `node_modules` 和 `pnpm-lock.yaml` 重装。只改 package.json 会新旧包混装，启动时报一堆官方插件的 import 错误。
  - **web profile 现状**：第三方插件没适配新核心的会拖死启动，bundle 已裁到只剩官方核心 + 本插件，完整清单备份在 `package.json.bak-bundles-full`。已知两个雷：agent-teams 和 task-board（后者藏在 web-ui-all 聚合包里，patch 里要禁的 id 是 `web-ui-task-board`，不是包名）。
  - **TUI**：终端界面插件 beta.4 还不支持 rc.1，装本插件后启动崩（`events is not iterable`）。禁用本插件就能启动——触发器是我们，根因是它。等它发适配版。
  - **版本对应**（已写进 README）：0.3.0 配 dsh `0.1.2-rc.1`+；0.2.6 配 `0.1.1-rc.2`。装错了哪个方向都起不来。

- **徽章和费率都拼在模型名上（f4aa396，未发布）**：0.1.2 的模型下拉不再显示 description（查过产物，一处都不渲染了），所以倍率和徽章只能跟名字走，如 `GLM-5.2 · x0.79 · 夜间折扣`。之前「description 放徽章」的做法作废。

- **README 改版（未发布）**：装了版本对应表；TUI 一段按「实测现象 → 原因 → 建议」写；功能列表全部改成人话，标题用户定稿（徽章展示、费率比例）。

- **探测备忘（2026-09-04）**：catalog 里带徽章的只有 hy3、hy4-preview（限时免费）和 glm-5.2（夜间折扣），换什么 UA 都一样；App 里 DeepSeek 系的夜间折扣、GLM-5.3 系的订阅优先是客户端自己画的，接口里没有。App 截图还证实了快速/均衡/极致 = x0.21/x0.65/x1.20、MAX 开关存在，以后抓包照这个对。

- **适配 DSH 0.1.2-rc.1（2026-09-03，未发布，将随 0.3.0）**：0.1.2 线两处破坏性变更（issue #10）——① `dsh-settings` 移除 `installSettingsSection` / `settingsNamespace`：改为 `ctx.inject(['settings'], …)` 后调用服务的 `installSection`，namespace 直接用字符串常量 `'workbuddy' as SettingsNamespace`；② `@deepseek-ai/dsh-client-runtime` 包被移除：client 改注入 `@deepseek-ai/dsh-client-ui-renderer`，`ClientContext` 类型改用 cordis 的 `Context`。peer/devDeps 全线升 `^0.1.2-rc.1`（cordis `^4.0.2`、schemastery `^3.18.2`、pi-ai `^0.84.2`——dsh-llm-pi-ai 0.1.2 已把 pi-ai 转为直接依赖 ^0.84.2）。**本版本起不再兼容 0.1.1 线**。适配参照 winliyou alpha 分支（其适配目标为 0.1.2-alpha.3），未做双线运行时兼容：client inject 清单无法按核心版本条件化。

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

未经明确指令不得 `npm publish` / 打 release tag；**push 到远端（含普通 main 推送）必须先经用户同意，本地 commit 可自主**；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
