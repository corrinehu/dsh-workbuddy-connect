# dsh-workbuddy-connect

在 [DSH](https://github.com/deepseek-ai/deepseek-harness) 中调用 WorkBuddy 桌面 App 中的模型，自动跟随 App 状态，无需 API Key。

[English](./README.en.md) | 中文

## 功能

- **开箱即用的模型接入**：WorkBuddy 账号的可用模型（DeepSeek-V4-Pro、GLM-5.2、Kimi-K3、MiniMax-M3、Auto 智能路由等）直接出现在 DSH 模型选择器的 WorkBuddy 分组，模型列表随账号权限自动同步。
- **免 API Key、免登录配置**：沿用 WorkBuddy 桌面 App 的登录状态，令牌自动续期，App 内切换账号即时生效。
- **原生 DSH 体验**：流式输出、工具调用、上下文压缩、权限审批均由 DSH 提供，插件只负责模型通道；剩余积分可在设置卡片中随时查看。

## 安装

前置：已安装并登录过 WorkBuddy 桌面 App。

```sh
dsh plugin --profile <name> add github:corrinehu/dsh-workbuddy-connect
dsh web
```

## 使用

- 安装后，在对话的模型选择器中选择 WorkBuddy 分组的模型即可开始使用。
- **设置 → 插件 → 插件配置**：展开「WorkBuddy Connect」卡片，可查看当前登录账号、令牌有效期与各套餐剩余积分，支持手动刷新。
- 命令行：`dsh plugin --profile <name> exec dsh-workbuddy-connect status` 查看登录状态与剩余积分（加 `--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理）。

## 已知边界

- 当前仅在 macOS 与 DSH Web profile 下测试通过；Windows / Linux 的凭据默认路径未经验证，必要时可通过环境变量 `WORKBUDDY_AUTH_FILE` 指定实际位置。
- 暂不支持向模型发送图片。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整；验证环境为 DSH `0.1.0-rc.6`、Node 22+。

## 开发

```sh
pnpm install
pnpm run check        # typecheck + vitest + build
```

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅供使用者自己的 WorkBuddy 账号在本机调用，请勿用于任何商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy / CodeBuddy 的服务条款；由使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy / CodeBuddy、DeepSeek 均无关联，也未获得其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH bundle 与 pi-ai provider 注册的参照。

## 许可证

[MIT](./LICENSE)
