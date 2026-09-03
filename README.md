# DSH WorkBuddy Connect


[English](./README.en.md) | 中文


将 WorkBuddy 桌面 App 中包含的各种模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3 、Hy3等）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用。


## 功能

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **图片输入**：大部分模型支持发图，在对话里直接粘贴或拖入图片即可（GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）；少数只支持文字的模型（如 GLM-5.1）会明确提示不支持。


- **思考强度**：模型选择器里可为支持的模型切换思考强度，例如 GLM-5.3 可选 low / high / xhigh，GLM-5.3-Flash 可选 low / high / max；没有出现选项的模型不支持调整，使用 WorkBuddy 的默认档位。


- **限时免费一目了然**：状态卡片会标注当前免费 / 限时免费 / 夜间折扣的模型（以 WorkBuddy 服务端的数据为准，每次启动 DSH 时同步）。


- **费率比例直接可见**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到。倍率只是显示，不影响实际请求。


- **信息查看**：设置 → 插件 → DSH WorkBuddy Connect 卡片


![设置卡片显示插件](assets/2.png)

卡片展开后，可查看账号信息、令牌有效期与剩余积分。

![设置卡片显示账号与剩余积分](assets/3.png)

## 安装

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态，账号切换自动跟随）。

**版本对应（重要）**：本插件与 DSH 核心版本一一对应，不可混用——不匹配的组合会导致 DSH 启动失败：

| 插件版本 | 要求的 DSH 核心 | 桌面 App |
|---|---|---|
| **0.3.0+** | `0.1.2-rc.1` 及以上 | 建议 `2.0.5`+ |
| **0.2.6** | `0.1.1-rc.2`（旧线） | `2.0.3` / `2.0.4` |

- DSH `0.1.2-rc.1` 及以上的用户，正常安装最新版即可：`dsh plugin --profile web add dsh-workbuddy-connect`
- 还在用 DSH `0.1.1-rc.2` 的用户，请安装旧版本并停留在 `0.2.6`：`dsh plugin --profile web add dsh-workbuddy-connect@0.2.6`

插件在三种 DSH 界面下均可运行：**Web**、**Desktop**、**TUI**。根据你使用的 profile 选对应命令安装。

```sh
# Web（推荐，自带预构建产物）
dsh plugin --profile web add dsh-workbuddy-connect
dsh web

# 或从 GitHub 源码安装 Web 版
dsh plugin --profile web add github:corrinehu/dsh-workbuddy-connect
dsh web
```

```sh
# Desktop（DSH Desktop 桌面版）
dsh plugin --profile desktop add dsh-workbuddy-connect
dsh --profile desktop
```

```sh
# TUI（终端界面）
dsh plugin --profile dsh-tui add dsh-workbuddy-connect
dsh --profile dsh-tui
```

> **TUI 用户请先留在 0.2.6**：终端界面插件 `@deepseek-harness-tui/dsh-tui` 目前最新版（0.10.0-beta.4）还不支持 DSH `0.1.2-rc.1`——安装本插件后启动会报 `events is not iterable` 崩溃（该问题的修复已提交，等作者发新版）。在新版发布之前，TUI 用户请继续使用 DSH `0.1.1-rc.2` 和本插件 `0.2.6`；等它发了支持新核心的版本，升级后即可使用 0.3.0。

> 提示：`dsh-tui` profile 需用 pnpm 11 安装（PATH 里是其他版本会报 `ERR_PNPM_UNEXPECTED_STORE`，用 `npx pnpm@11` 即可）。

安装后，在对应界面的模型选择器里切换到 WorkBuddy 模型即可使用；Web 下设置卡片（设置 → 插件 → DSH WorkBuddy Connect）可查看账号信息、令牌有效期与剩余积分，TUI 下可在 `/settings` 里配置 `authFile`。

## 命令行

`dsh plugin --profile <web|desktop|dsh-tui> exec dsh-workbuddy-connect status`：登录状态与剩余积分（`--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理凭据）。

## 已知限制

- 在 macOS 的 DSH Web / Desktop profile（`0.1.2-rc.1`+、Node 22+）下验证通过；TUI 待终端界面插件发布 0.1.2 适配版后验证（见安装章节说明）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE` 指定实际位置。
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
