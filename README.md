# DSH WorkBuddy Connect


[English](./README.en.md) | 中文


将 WorkBuddy 桌面 App 中包含的各种模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3 、Hy3等）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用。

国内版 **WorkBuddy** 与国际版 **WorkBuddy AI** 同时支持（国际版自 **v0.5.0** 起）：装哪个 App 就出现哪个模型分组，两个都装就两组并存，各自用自己的账号与积分。


## 功能

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **国内版与国际版并存**：国内版显示为「WorkBuddy」分组，国际版（WorkBuddy AI）显示为「WorkBuddy AI」分组。两版的模型、账号和积分互不混用。**各自只看自己那版 App 的登录状态**：只装国际版就只出现「WorkBuddy AI」，两版都装就两组都在，退出其中一版则对应分组消失。设置里也是**两张卡片**，分别展示各自的账号与余额。

![WorkBuddy AI 模型出现在 DSH 模型选择器中](assets/5.png)


- **图片输入**：大部分模型支持发图，在对话里直接粘贴或拖入图片即可（GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）；少数只支持文字的模型（如 GLM-5.1）会明确提示不支持。


- **推理档位**：WorkBuddy 明确声明的档位会直接显示，例如 GLM-5.3 和 GLM-5.3-Flash 可选 low / high / max。对于部分没有声明可选档位的模型，Web 和 Desktop 可在模型选择器中点击「推理等级」手动检测；检测会发送少量请求，可能消耗积分。未检测或没有可用档位的模型仍使用 WorkBuddy 的默认档位。

- **余额速览**：选中 WorkBuddy / WorkBuddy AI 的模型时，输入框底部会在模型选择器旁显示一行当前账号的剩余积分（如 `WB.3,401（积分）`、国际版 `WB AI.3,401（积分）`）。积分不自动轮询（每次状态读取都会真实查询计费），挂载读取一次后可点击旁边的 ↻ 手动刷新。


- **信息查看与检测**：设置 → 插件 → 对应卡片可查看账号、令牌有效期、剩余积分和模型优惠（DSH `0.1.6+` 上入口在左侧栏「插件」面板，见下方版本对应一节）；也可以手动刷新模型列表，并在卡片上看到当前列表来自上游还是内置兜底。对于可检测模型，也可以在这里手动检测推理档位。

- **模型显隐**：WorkBuddy 与 WorkBuddy AI 都可以在对应卡片的「上下文窗口」标签里勾选要在模型选择器中显示的模型。隐藏配置**按登录账号分别保存**：切换账号自动切换各自的配置，切回后恢复；新账号和新上架的模型默认显示。隐藏只影响选择器里的可选性，**正在使用该模型的已有会话不受影响**。

![上下文窗口列表里的模型显隐（DSH 0.1.6+ 插件配置页）](assets/6.png)

同一份界面在 DSH 0.1.5 的设置卡片中原样生效：

![DSH 0.1.5 设置卡片中的模型显隐](assets/7.png)

- **企业账号积分**：国内版企业账号（`enterpriseId` 非空）走企业专用计费接口读取周期额度，卡片显示「企业额度」与周期重置时间。

- **费率比例**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到。倍率只是显示，不影响实际请求。


- **徽章展示**：促销徽章（限时免费、夜间折扣）直接跟在模型名后面（如 `Hy4 preview · x0.00 · 限时免费`），选模型时一眼可见；设置卡片里也会汇总当前有优惠的模型。以 WorkBuddy 服务端的数据为准，每次启动 DSH 时同步。国际版的促销来自服务端的 `modelPromotions`（含生效时段）：促销过期后徽章会撤销；由于服务端把折后价直接写在模型的倍率字段里，原价无法还原，此时该模型的倍率会显示为「价格未知 — 刷新后更新」，而不是继续显示折扣价或「免费」。

![设置卡片显示插件](assets/2.png)

卡片展开后分为「状态 / 上下文 / 明细」三个标签：状态页展示账号、令牌有效期、合计积分、模型列表来源与推理档位检测；上下文页列出各模型的上下文窗口。国际版在上游声明了更大可选窗口时，可在这里切换「使用上游声明的最大上下文窗口」；该开关**默认开启**，DSH 会按上游声明的最大窗口安排上下文压缩；想改用上游的默认窗口就在这里关掉，偏好会持久化，重启后保持。明细页展示各套餐余量与模型优惠。国内版与国际版各有一张自己的卡片，各显示自己账号的信息。

![设置卡片显示账号与剩余积分](assets/3.png)

## 推理档位为什么这样设计

WorkBuddy 中模型的推理档位信息目前分散在上游接口与客户端自身的私有 UI 逻辑中，且模型目录变化很快。若插件根据经验为所有未声明模型补齐统一档位，就需要持续追赶这些未公开、没有稳定契约的产品逻辑。

![设置档位](assets/4.png)


实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为；一次请求返回成功，并不能证明某个档位真实可用。

因此，对于没有声明档位的模型，Web 和 Desktop 采用用户主动授权触发、动态获取档位的方式：先确认上游会校验该参数，再逐项确认哪些规范档位被接受。检测会发送少量请求，可能消耗积分；结果只表示当前上游接受该档位，不承诺它一定改变推理效果、速度或积分消耗。

## 安装

前置：已安装并登录 WorkBuddy 桌面 App。插件复用 App 的登录状态，账号切换自动跟随；装了国际版 WorkBuddy AI 的同样适用，两版互不影响。

**版本对应（重要）**：自 **`0.6.0`** 起，同一个插件版本横跨两代 DSH 核心，安装时无需再逐版本对照；更早的已发布版本仍与核心一一对应，不可混用——不匹配的组合会导致 DSH 启动失败。**自 `0.7.0` 起插件仅面向 `0.2.0` 内核，`0.1.x` 用户请停留在 `0.6.5`**：

| 插件版本 | 要求的 DSH 核心 | 桌面 App |
|---|---|---|
| **0.7.2** | **仅支持 `0.2.0-rc.2`**（`0.2.0-rc.1` 用户请停留在 `0.7.0`），并把 `@earendil-works/pi-ai` 从 **peer 依赖改为插件自带的普通依赖**（精确 `0.87.1`）：插件不再依赖 profile 顶层那一份 pi-ai，避免被其他包留下的旧拷贝（如 `0.82.x`）遮蔽而加载到错误版本（[#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)）。**在正常、正确的安装下**插件会优先解析自己安装的那份；解析结果仍取决于具体 installer 与 profile 布局，异常时插件会在加载时给出告警。同时修复国内版 `Off` / `Default` 档位请求被拒（[#87](https://github.com/corrinehu/dsh-workbuddy-connect/issues/87)）与 Windows 卸载记录编码（[#88](https://github.com/corrinehu/dsh-workbuddy-connect/issues/88)）。 | 内置 `0.2.0-rc.2` 内核的桌面版（预览 / nightly） |
| **0.7.1（历史版本）** | 仅支持 `0.2.0-rc.2`，并把 `@earendil-works/pi-ai` peer 从 `^0.85.1 \|\| ^0.87.1` 收窄为 **`^0.87.1`**：从 `0.6.x` 原地升级的 pnpm profile 不再因旧 `pi-ai@0.85.1` 仍在范围内而被保留、复现 [#69](https://github.com/corrinehu/dsh-workbuddy-connect/issues/69) 的两代混用（[#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74)）。**从 `0.6.5` 原地升级已实测**：编辑 `package.json` 后 `pnpm install`，插件即解析到 `pi-ai@0.87.1`，无需任何 override；同时在 `0.7.0` 上复现了双臂范围放行 `0.85.1` 的原行为作为对照。该版仍以 **peer** 方式使用 profile 顶层的 pi-ai —— 这一局限在 `0.7.2` 已修复 | 内置 `0.2.0-rc.2` 内核的桌面版（预览 / nightly） |
| **0.7.0（0.2.0 世代首发）** | **仅支持 `0.2.0-rc.1` / `0.2.0-rc.2`**（`0.1.5` / `0.1.6` / `0.1.7` 不再支持，用户请停留在 `0.6.5`），已在 `0.2.0-rc.2` 真机实测（web 端：加载、国内版与国际版目录、加密凭据、状态路由正常）。这是适配 DSH `0.2.0` 设置服务改造的版本——`0.2.0` 把设置服务换成了 Config 表单门面，移除了旧的 `installSection` 接口，早期版本在上面会丢失设置项。**`0.7.1` 起不再支持 `rc.1`** | 内置 `0.2.0` 内核的桌面版（预览 / nightly） |
| **0.6.0（双界面自适应）** | `0.1.5-rc.1` / `rc.2` / `rc.3`；`0.1.6-alpha` 系列（含 `alpha.1` / `alpha.2`）与 `0.1.6` 正式版；已实测 `0.1.7-alpha.1`（`0.1.7` 正式版同样在范围内）。**后续 `0.1.x` prerelease（如 `0.1.8-alpha.x`）同样落在 `^0.1.7-alpha.1` 区间内**——宿主兼容判定按 includePrerelease 语义解析 peer range（早先「不自动覆盖」的说法有误，已更正）；跨入 `0.2.0` 的 prerelease 才需要插件显式扩展 peer range | `2.0.7`+ 可直接使用；搭载 `0.1.6+` 核心的桌面版发布后同样适用 |
| **0.6.5（`0.1.x` 线最终版）** | 在 `0.6.0` 的支持面上追加 `0.2.0-rc.1`（`0.1.5` / `0.1.6` / `0.1.7` / `0.2.0-rc.1`），已在 `0.2.0-rc.1` 真机实测（web 端：加载、目录、加密凭据、对话与图片往返正常）。已发布的 `0.6.4` 及更早版本不含该区间，在 DSH `0.2.0-rc.1` 上会被宿主整体跳过（见 [#63](https://github.com/corrinehu/dsh-workbuddy-connect/issues/63)） | 内置 `0.1.x` 内核的桌面版（含 `2.0.7` 起的已发布正式版）；`0.2.0-rc.1` 亦可（web 已实测，桌面版待实测） |
| **0.3.2 – 0.5.4**（国际版支持自 `0.5.0`） | `0.1.5-rc.1` 系列（不支持 `0.1.6+`，见 [#41](https://github.com/corrinehu/dsh-workbuddy-connect/issues/41)） | `2.0.7`+（内置核心已跟进 `0.1.5-rc.1`） |
| **0.3.0 – 0.3.1** | `0.1.2-rc.1` | `2.0.5` |
| **0.2.6** | `0.1.1-rc.2`（旧线） | `2.0.3` / `2.0.4` |

- **计划中的 `0.6.0` 不要求为了安装 WorkBuddy Connect 强制升级到 DSH `0.1.6`**：插件在加载时按宿主实际提供的配置入口自适应，`0.1.5` 与 `0.1.6+` 各自走各自的界面，互不干扰。
- **DSH `0.2.0` 的设置服务改造**：`0.2.0` 起设置服务改为 Config 派生的表单门面（只暴露 `.volatile()` 字段），不再提供安装设置分区的接口。插件按宿主实际能力自适应：在 `0.1.5` / `0.1.6` 上照旧安装两个分区（`authFile` / `authFileAI` 等仍可从 `settings.yaml` 与 TUI `/settings` 读写），在 `0.1.7`+ / `0.2.0` 上降级为无设置项的 provider——模型、选择器、模型显隐与上下文窗口照常工作，只是「使用上游声明的最大上下文窗口」这一偏好不再可持久化，卡片也不会渲染无法保存的开关。
- **配置入口随 DSH 版本不同**，两代各就各位：

  ```text
  DSH 0.1.5 + 本插件
  ├─ 设置 → 模型
  │   └─ 不显示 WorkBuddy 两行 ← 与 0.1.6+ 统一（≤0.5.4 旧版插件才显示那两行旧 configurable-provider 条目）
  ├─ 设置 → 插件
  │   ├─ DSH WorkBuddy Connect      ✅ 配置卡片（国内版）
  │   └─ DSH WorkBuddy AI Connect   ✅ 配置卡片（国际版）
  └─ 聊天模型选择器
      └─ WorkBuddy / WorkBuddy AI 分组 ✅

  DSH 0.1.6+ + 本插件
  ├─ 设置 → 模型
  │   └─ 不显示 WorkBuddy 两行      ← 有意如此，两代行为统一
  ├─ 设置 → 内置插件
  │   └─ workbuddy-connect          ← 只读清单（运行状态），无配置入口，别找错地方
  ├─ 主界面 → 插件 → workbuddy-connect → 查看
  │   ├─ DSH WorkBuddy Connect      ✅ 新配置入口（国内版）
  │   └─ DSH WorkBuddy AI Connect   ✅ 新配置入口（国际版）
  └─ 聊天模型选择器
      └─ WorkBuddy / WorkBuddy AI 分组 ✅
  ```

- 自 `0.6.0` 起，Models 设置页不再显示 WorkBuddy / WorkBuddy AI 的不可编辑卡片（两代核心行为一致）；模型选择器、`/model` 与对话调用不受影响。
- DSH `0.2.0-rc.2` 的用户，安装 `0.7.2` 即可：`dsh plugin --profile web add dsh-workbuddy-connect@0.7.2`；还在 `0.2.0-rc.1` 的用户请停留在 `0.7.0`：`dsh plugin --profile web add dsh-workbuddy-connect@0.7.0`
- 从 `0.6.x` 原地升级的 pnpm profile（曾手动装过 `pi-ai@0.85.1`）：升级到 `0.7.1` 后 peer 范围不再接受 `0.85.1`，`pnpm install` 会把插件解析到宿主同代的 `0.87.1`；此前按 [#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74) 临时加过的 `overrides: {'@earendil-works/pi-ai': 0.87.1}` 可以删掉了
- **不要把 profile 级的 `@earendil-works/pi-ai` 升到 1.x**：本插件与 `0.2.0-rc.2` 这一代 DSH 内核都要求 `^0.87.1`（`0.7.2` 起由插件自带，见 `package.json` 的 `dependencies`；`0.7.1` 及更早为 `peerDependencies`）。升到 1.x 可能导致插件加载不兼容版本，并造成不同版本的 pi-ai 在安装树中并存。**部分第三方插件管理器（如 `@linxin666/dsh-client-ui-plugin-manager@0.4.5`）的「检查更新」只看第三方包与 `dsh.engines.dsh`，不校验 peer 约束**，因此可能把 `pi-ai` 列为「可更新」——这个提示不能照做（见 [#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86)）
- 从 `0.7.1` 升到 `0.7.2` 前请先确认宿主内核为 `0.2.0-rc.2`（`0.7.2` 只支持 `rc.2`，仍在 `rc.1` 的用户请停留在 `0.7.0`）。`pi-ai` 改由插件自带后，此前按 [#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74) / [#82](https://github.com/corrinehu/dsh-workbuddy-connect/issues/82) 在 profile 里加过的 `overrides: {'@earendil-works/pi-ai': 0.87.1}` **不要盲目删除**——若其他插件仍依赖它才能解析到正确版本，删除可能让它们受影响；确认其他插件与 DSH 自身解析均正常后再考虑清理，不确定时保留即可（与本插件已不冲突）
- 还在用 DSH `0.1.5` / `0.1.6` / `0.1.7` 的用户，请停留在 `0.6.5`：`dsh plugin --profile web add dsh-workbuddy-connect@0.6.5`
- 还在用 DSH `0.1.2-rc.1` 的用户，请停留在 `0.3.1`：`dsh plugin --profile web add dsh-workbuddy-connect@0.3.1`
- 还在用 DSH `0.1.1-rc.2` 的用户，请停留在 `0.2.6`：`dsh plugin --profile web add dsh-workbuddy-connect@0.2.6`
- 桌面版按**内置核心**选择插件版本：内置 `0.1.x` 内核的桌面版（含 `2.0.7` 起的已发布正式版）用 `dsh-workbuddy-connect@0.6.5`；内置 `0.2.0-rc.2` 内核的桌面版用 `0.7.2`，内置 `0.2.0-rc.1` 内核的用 `0.7.0`（预览 / nightly）；`2.0.5` 及更早（内置 `0.1.2-rc.1`）请继续使用 `0.3.1`

插件在三种 DSH 界面下均可运行：**Web**、**Desktop**、**TUI**。

**推荐：把安装交给 Agent**。不用自己敲命令——把下面这段引导原样发给你的 AI 助手（DSH 内置 Agent、Claude Code、Codex、Cursor 等均可），它会按你的实际环境选对方式、装对版本并完成验证：

```markdown
请帮我安装 DSH（DeepSeek Harness）插件 dsh-workbuddy-connect，并在装完后验证。

约束与信息：
- 插件版本必须与 DSH 内核匹配。先确认内核版本——注意区分来源：Web / TUI 看独立 CLI 的
  `dsh --version`；Desktop 桌面版必须确认其**内置 DSH 核心版本**（桌面 App 的「关于」页），
  不要拿独立 CLI 的版本代替桌面 App 的内核做判断。
  内核 `0.2.0-rc.2` → 装 `0.7.2`；内核 `0.2.0-rc.1` → 固定 `0.7.0`；内核 `0.1.5`–`0.1.7` → 固定 `0.6.5`；
  更早内核见 https://github.com/corrinehu/dsh-workbuddy-connect README 的版本对应表。
- 我使用的界面是：（发给 Agent 时注明 Web / Desktop 桌面版 / TUI 之一）
- Web：执行 `dsh plugin --profile web add dsh-workbuddy-connect`（需要指定版本就加 `@版本号`）。
- TUI：执行 `dsh plugin --profile dsh-tui add dsh-workbuddy-connect`；该 profile 需用 pnpm 11 安装。
- Desktop 桌面版：`desktop` profile 由桌面 App 独占管理，任何 `dsh plugin --profile desktop ...`
  命令都会被 CLI 直接拒绝（报 `profile "desktop" is managed exclusively by the Electron application`）。
  首选做法：引导我在桌面 App 内置的插件管理界面安装。若改走文件方式，步骤必须完整：
  ① 先确认桌面 App 实际使用的 profile 目录（默认 `~/.dsh/profiles/desktop`，Windows 为
  `%USERPROFILE%\.dsh\profiles\desktop`，以实际为准）；② 让我完全退出桌面 App；
  ③ 备份该目录下的 `package.json` 与 `pnpm-lock.yaml`；④ 在 dependencies 中加入
  `"dsh-workbuddy-connect": "<版本>"`；⑤ 用与该 profile 匹配的 pnpm 在该目录执行安装
  （优先使用桌面 App 自带的 pnpm；用错版本可能报 store 相关错误，按报错提示换版本重试）；
  ⑥ 重启桌面 App。
- 验证：重启对应界面后，模型选择器里应出现「WorkBuddy / WorkBuddy AI」分组——只装国内版或
  只装国际版时，只需验证对应的那一组。分组与积分可见只说明插件加载、目录与账号读取正常；
  请再从中选一个模型完成一次简短对话，能正常回复才算接入成功。
```

<details>
<summary>手动安装（命令行，仅 Web / TUI）</summary>

```sh
# Web（推荐，自带预构建产物）
dsh plugin --profile web add dsh-workbuddy-connect
dsh web

# 或从 GitHub 源码安装 Web 版
dsh plugin --profile web add github:corrinehu/dsh-workbuddy-connect
dsh web

# TUI（终端界面）
dsh plugin --profile dsh-tui add dsh-workbuddy-connect
dsh --profile dsh-tui
```

Desktop 桌面版不走命令行：`desktop` profile 由桌面 App 独占管理，CLI 一律拒绝（`profile "desktop" is managed exclusively by the Electron application`），请在桌面 App 内置的插件管理里安装。

</details>

> **TUI 用户请注意版本搭配**：终端界面插件 `@deepseek-harness-tui/dsh-tui` 需要 **`0.10.0-beta.5` 及以上**（更早的版本装了本插件会启动失败，报 `events is not iterable`）。请先用 TUI 自带的更新方式把壳升到 beta.5 及以上，再安装本插件；当前最新的是 beta 版，正式版发布后同样可用。

> 推理档位的手动检测入口目前仅提供给 Web 和 Desktop；TUI 不提供检测操作。

> 提示：`dsh-tui` profile 需用 pnpm 11 安装（PATH 里是其他版本会报 `ERR_PNPM_UNEXPECTED_STORE`，用 `npx pnpm@11` 即可）。

安装后，在对应界面的模型选择器里切换到 WorkBuddy 模型即可使用。Web 和 Desktop 下，设置卡片可查看账号信息、令牌有效期与剩余积分，手动刷新模型列表，并手动检测符合条件模型的推理档位；国内版与国际版各有自己的卡片。TUI 下可在 `/settings` 里配置 `authFile`（国际版为 `authFileAI`）。

## 命令行

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`：登录状态与剩余积分（`--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理凭据）。`desktop` profile 由桌面 App 独占管理，CLI（含 `exec`）一律不可用。

默认操作国内版；加 `--provider workbuddy-ai` 操作国际版：

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` 只删除该版插件自留的凭据副本，不动桌面 App 自己的登录，也不承诺一定让模型分组消失（App 的凭据文件仍在时依然生效）。

## 已知限制

- 在 macOS 的 DSH Web / Desktop / TUI 下验证通过（0.3.2 起要求 `0.1.5-rc.1`+、Node 22+；TUI 需终端界面插件 `0.10.0-beta.5` 及以上，见安装章节说明）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE`（国际版为 `WORKBUDDY_AI_AUTH_FILE`）指定实际位置。
- **加密桌面凭据的解密程序定位**：国内版与国际版（WorkBuddy AI 的凭据自 5.6.2 起同样加密）在 macOS 使用各自的默认路径与 App 发现；Windows 上国内版先检查 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` 再查卸载注册表记录，国际版没有已验证的默认安装位置、仅查注册表记录。两个产品只按各自的 App 身份（bundle id / 注册表名 / 可执行文件名）定位与执行解密程序，不会互相误选；同机两个 App 当前恰好共用同一把静态保护密钥，这属于上游实现的巧合，插件不依赖它，密钥分叉后会如实报诊断而不是误读。若自动定位仍不可用，可按产品设置环境变量：国内版 `WORKBUDDY_ELECTRON_BIN`、国际版 `WORKBUDDY_AI_ELECTRON_BIN`（两变量自 0.6.4 起分离；此前把 `WORKBUDDY_ELECTRON_BIN` 指向过国际版 App 的用户请改用新变量并清理旧值），设置后需完全退出并重启 DSH（插件在构造时读取该变量）；Windows 上建议注销重登后再启动（explorer 会缓存旧的环境块）。Linux 没有内置自动定位；失败时卡片提供 Agent Assist，显式环境变量仍可用。
- **国际版的模型目录来自 App 界面接口**：服务端按 User-Agent 分流下发，属私有实现，上游改动可能使其失效。届时插件按「本账号上次成功目录 → 内置目录」降级，并在卡片上标明来源（实时 / 已保存 / 内置）、更新时间与失败原因，但不能保证长期兼容。国内版目录走官方 CLI 同款接口，不受此影响。
- **国际版仍未覆盖的环境**：Windows / WSL / Linux 下国际版 App 的版本读取尚未找到可靠来源，会退回最近保存的版本或内置值。macOS 上已通过真实 shim 验证 GPT 系完整回复、工具调用与续轮。
- **无凭据时的行为变化**：某版 App 从未登录、也没留下插件自留副本时，该版模型分组不再显示。此前国内版会显示一份内置兜底列表，但那些模型选了必然报错。
- **企业账号积分目前仅覆盖国内版**：国际版企业账号的计费接口尚未验证，仍按个人版接口读取；待有实测结论后再扩展。企业账号分支在本机无法自测（开发机为个人账号），依据官方 App 的接口契约实现，欢迎企业账号用户反馈实测结果。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。

## 许可证

[MIT](./LICENSE)
