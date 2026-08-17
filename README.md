# WorkBuddy Connect

在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 里直接使用 WorkBuddy（腾讯 CodeBuddy）订阅的模型额度。

[English](./README.en.md) | 中文

## 它做什么

- 注册 `workbuddy` 模型 provider：模型选择器里会出现 **WorkBuddy** 分组，列出账号可用的 CLI 模型（`auto`、`deepseek-v4-pro`、`glm-5.2`、`kimi-k3-1`、`minimax-m3` 等）。
- **复用桌面版 WorkBuddy App 的登录**：只读桌面 App 的凭据文件，不在 DSH 里重新走 OAuth。
- 插件内部起一个只绑定 `127.0.0.1` 的转换端点，把 OpenAI 兼容请求翻译成 WorkBuddy 上游的怪癖（强制流式、`tool_choice` 对象转字符串、CLI 伪装请求头），模型列表启动时从上游动态刷新。
- 流式输出、工具调用、上下文压缩、权限审批等能力全部由 DSH 自己拥有，本插件只提供模型通道。

```
DSH (pi-ai adapter) ──OpenAI 格式──▶ 127.0.0.1 回环 shim ──翻译──▶ copilot.tencent.com /v2/chat/completions
                                          │
                                          ├─ 凭据：读 WorkBuddy 桌面 App 文件（只读），过期前自动 refresh
                                          └─ 模型：GET /console/enterprises/personal/models（cli 组）
```

## 安装

前置：已安装并登录过 WorkBuddy 桌面 App（macOS 凭据位于 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`）。

```sh
dsh plugin --profile <name> add link:/Users/corrinehu/Documents/DSH/creat-dsh-plugin/dsh-workbuddy-connect
dsh --profile <name> --dump-config     # 应看到 llm-workbuddy 层
dsh web                                # 模型选择器 → WorkBuddy 分组
```

## 配置

`cordis.patch.yml` 层默认零配置。可选字段：

```yaml
- id: llm-workbuddy
  config:
    authFile: /path/to/workbuddy-desktop.info   # 覆盖默认桌面凭据路径（也可用环境变量 WORKBUDDY_AUTH_FILE）
```

## CLI

```sh
dsh plugin --profile <name> exec dsh-workbuddy-connect status --json   # 登录状态 + 剩余积分
dsh plugin --profile <name> exec dsh-workbuddy-connect doctor --json   # 无密钥诊断
dsh plugin --profile <name> exec dsh-workbuddy-connect logout          # 删除插件自己的凭据副本
```

## 设置界面

- **设置 → 模型**：WorkBuddy 以 provider 卡片出现（可在此改 `authFile`，改动即时生效）。
- **设置 → 插件 → 插件配置**：可展开的「WorkBuddy Connect」卡片，展示当前登录账号、访问令牌过期时间和各套餐剩余积分（每 60 秒自动刷新，也可手动刷新）。数据来自插件的回环状态接口 `/plugins/dsh-workbuddy-connect/status`，只接受本机浏览器来源，响应不含任何 token。

## 凭据与刷新策略

- 桌面 App 的凭据文件**只读，永不写入**。
- access token 到期前 5 分钟，插件调用官方 refresh 端点刷新，结果写入 `$DSH_HOME/.workbuddy-auth.json`（权限 0600，原子写）。
- 生效凭据 = 桌面文件与插件副本中**过期时间较晚**者，任意一侧刷新都立即生效。
- 注意：refresh token 是和桌面 App 共享的。极少情况下（恰好同时刷新）一侧会失效，重新打开一次 WorkBuddy App 登录即可恢复。
- 上游错误分类：积分不足（HTTP 402）/ 限流（429）/ 会话失效（401+12153，需重新打开 App 登录）。

## 已知边界

- 当前仅在 macOS 与 DSH Web profile 测试通过；Windows / Linux 的桌面凭据默认路径未经验证，找不到文件时用 `authFile` 或环境变量 `WORKBUDDY_AUTH_FILE` 指定实际路径（`doctor` 可诊断）。
- 模型按 text-only 申报（上游接口不返回模态信息，宁可少报不让请求挂中途）；`glm-5v-turbo` 的视觉能力暂不透传图片。
- 上游接口为逆向所得（协议与 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）一致），随上游变化可能失效；WorkBuddy 处于快速迭代期。
- 回环 shim 只监听 `127.0.0.1`，不对外。
- 兼容组合：DSH 插件 API `0.1.0-rc.6`、`@earendil-works/pi-ai` `0.82.1`、Node `^22.19.0 || >=24`。

## 开发

```sh
pnpm install
pnpm run check        # typecheck + vitest + build
```

测试完全离线（不碰真实凭据与上游）。

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
