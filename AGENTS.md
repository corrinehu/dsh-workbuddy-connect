# dsh-workbuddy-connect Agent Notes

## 待办

- PR #4（WSL 凭据发现）已合并进 v0.2.4：等作者 CallMeSoul 基于 npm 包回归验证（PR 评论里已请求）。

## 最近发布

- **v0.2.4（2026-08-28）**：合并 PR #4（CallMeSoul）：WSL 下自动发现 Windows 桌面端凭据（挂载的 Windows 用户目录按 Local → Roaming → 原生 Linux 顺序探测，支持转发的 Windows 环境变量）。
- **v0.2.3（2026-08-26）**：修复版本显示瑕疵（产物烙旧版本号）+ README 补充 web / desktop / TUI 三端安装说明。
- **v0.2.2（2026-08-24）**：修复 Windows 凭据路径探测（Local → Roaming，issue #1）。

## 发布规矩（同工作区根 AGENTS.md）

未经明确指令不得 `npm publish` / 打 release tag；发布前 `pnpm run check` 全过，顺序固定：**先升版本号，再 check/构建，最后发布**。
