# DSH WorkBuddy Connect


[English](./README.en.md) | 中文


将 WorkBuddy 桌面 App 中包含的各种模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3 、Hy3等）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用。


## 功能

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **图片输入**：按上游逐模型声明的能力放行图片——绝大多数模型（含 GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）可直接粘贴或拖入图片；个别纯文本模型（如 GLM-5.1）按上游声明仍会明确提示不支持。


- **思考强度**：按上游每个模型声明的 `supportedEfforts` 提供思考等级选项（如 GLM-5.3 支持 low / high / xhigh，GLM-5.3-Flash 支持 low / high / max），在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发。


- **限时免费一目了然**：状态卡片会标注当前免费 / 限时免费 / 夜间折扣的模型（跟随上游 `credits` 与 `tags` 实时更新）。


- **费率比例直接可见**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与 composer 下拉都能看到；设置卡片里也补充了倍率说明。倍率只影响显示，发送请求仍使用模型 id。


- **信息查看**：设置 → 插件 → DSH WorkBuddy Connect 卡片


![设置卡片显示插件](assets/2.png)

卡片展开后，可查看账号信息、令牌有效期与剩余积分。

![设置卡片显示账号与剩余积分](assets/3.png)

## 安装

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态，账号切换自动跟随）。

> 本 fork 增加了多账号支持与新版 host（`0.1.2`）兼容。**请从 GitHub 安装本仓库**，不要装插件市场里的 `dsh-workbuddy-connect`（那是无多账号的上游旧版）。以下以 **DSH Desktop** 为例。

**方式一：一键脚本（macOS/Linux，推荐）**

```sh
curl -fsSL https://raw.githubusercontent.com/jmglsi/dsh-workbuddy-connect/main/scripts/install-desktop.sh | sh
```

脚本做三件事：把 `github:jmglsi/dsh-workbuddy-connect` 装进 `~/.dsh/profiles/desktop`、在 `package.json` 的 `dsh.profile.bundles` 里注册 bundle、提示重启 DSH Desktop。

**方式二：手动**

```sh
# 1) 安装包（dsh 不在 PATH 时用 node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js 代替 dsh）
dsh plugin --profile desktop add github:jmglsi/dsh-workbuddy-connect

# 2) 注册 bundle：编辑 ~/.dsh/profiles/desktop/package.json，
#    在 "dsh" → "profile" → "bundles" 数组末尾追加 "dsh-workbuddy-connect"
#    （如："bundles": ["@deepseek-ai/dsh-base", "...", "dsh-workbuddy-connect"]）

# 3) 重启 DSH Desktop
```

装好后，在模型选择器里即可看到 `WorkBuddy` 分组；设置 → 插件 → **DSH WorkBuddy Connect** 卡片可查看账号昵称、令牌有效期、剩余积分，每个账号行有删除按钮（两段确认）。

插件在 Web / TUI profile 下同样可用（`--profile web` / `--profile dsh-tui`，TUI 需 pnpm 11：`npx pnpm@11`）。

## 命令行

统一用 `dsh plugin --profile desktop exec dsh-workbuddy-connect <子命令>` 调用：

```sh
dsh plugin --profile desktop exec dsh-workbuddy-connect accounts   # 已导入账号列表（--json 机器可读）
dsh plugin --profile desktop exec dsh-workbuddy-connect status     # 登录状态与剩余积分
dsh plugin --profile desktop exec dsh-workbuddy-connect doctor     # 诊断
```

## 多账号（可选）

插件默认沿用桌面 App 的单一登录。要多个账号共存切换（如一个号额度耗尽换另一个），用快照式导入：

```sh
# 1. 在 WorkBuddy 桌面 App 登录账号 A，然后（key 自己起名，如 jmglsi）：
dsh plugin --profile desktop exec dsh-workbuddy-connect import a
# 2. 桌面 App 切换登录账号 B，然后：
dsh plugin --profile desktop exec dsh-workbuddy-connect import b
# 3. 查看已导入账号；remove <key> 可删除（注意：remove 只删快照，
#    记得同步从 accounts 配置里去掉该 key，卡片上的删除按钮会自动同步）
dsh plugin --profile desktop exec dsh-workbuddy-connect accounts
```

再在插件设置里把 `accounts` 配成 `["a", "b"]` 并重启 DSH，模型选择器里会出现 `WorkBuddy · a`、`WorkBuddy · b` 两组模型（快照带昵称时显示 `WorkBuddy · 昵称`），各自独立刷新令牌、互不干扰。`accounts` 有两种配法：

- 设置 → 插件 → DSH WorkBuddy Connect 卡片的 accounts 字段；
- 或 `~/.dsh/settings.yaml`：

```yaml
workbuddy:
  accounts: [a, b]
  defaultAccount: a
```

每个账号是导入时刻的快照（桌面文件只读、绝不回写），长期使用靠 refresh token 自动续期；若某账号 refresh token 失效，重新在桌面登录该账号后再 `import <key> --force` 覆盖即可。

## 已知限制

- **从旧版（单账户）升级**：升级前用旧 provider `workbuddy` 选过模型的会话，重启后恢复运行会报 `Unknown provider: workbuddy`——在该会话里重新选一次模型即可；或把 `~/.dsh/storages/session_projcache/sessions/*.json` 里 `modelSelection` 下的 `provider: "workbuddy"` 改成 `workbuddy:<key>`。
- 在 macOS 的 DSH Web / Desktop / TUI profile 下验证通过（desktop host `0.1.2-alpha.1` 真机回归）。host 兼容 `0.1.1-rc.2` 与 `0.1.2` 系：设置节安装按 host 能力自动选择 `settings.installSection`（0.1.2-rc.1+）或自由函数（更早），优惠徽章与费率拼进模型名（0.1.2 的 composer 只渲染 name）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE` 指定实际位置。
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
