# DSH WorkBuddy Connect

English | [中文](./README.md)

Brings every model in the WorkBuddy desktop app (GLM-5.3, GLM-5.2, DeepSeek-V4-Pro, DeepSeek-V4-Flash, Kimi-K3, MiniMax-M3, Hy3, and more) straight into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — zero configuration in the DSH chat.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **Image input**: image messages are admitted per the upstream's per-model capability flag — most models (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, etc.) accept pasted or dragged-in images, while text-only models (e.g. GLM-5.1) keep a clear refusal.

- **Thinking effort**: the model picker exposes the per-model effort levels the upstream declares (e.g. GLM-5.3 offers low / high / xhigh, GLM-5.3-Flash low / high / max), forwarded as `reasoning_effort` on the wire.

- **Limited-time free at a glance**: the status card marks models that are currently free / limited-time free / on a night discount (following the upstream `credits` and `tags` live).

- **Rate ratio at a glance**: every model in the selection list carries its credits multiplier on the name (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`), in both the `/model` popup and the composer seat; the status card adds a localized rate line too. The rate is display-only — requests always use the model id.

- **Info at a glance**: Settings → Plugins → DSH WorkBuddy Connect card

![Settings card showing the plugin](assets/2.png)

Expand the card to see the account, token validity, and remaining credit.

![Settings card showing account and remaining credit](assets/3.png)

## Install

Prerequisite: the WorkBuddy desktop app is installed and signed in (the plugin reuses the app's sign-in state and follows account switches automatically).

The plugin runs under all three DSH interfaces: **Web**, **Desktop**, and **TUI**. Pick the install command that matches the profile you use.

```sh
# Web (recommended; ships prebuilt artifacts)
dsh plugin --profile web add dsh-workbuddy-connect
dsh web

# or install the Web version from the GitHub source
dsh plugin --profile web add github:corrinehu/dsh-workbuddy-connect
dsh web
```

```sh
# Desktop (the DSH Desktop app)
dsh plugin --profile desktop add dsh-workbuddy-connect
dsh --profile desktop
```

```sh
# TUI (terminal UI)
dsh plugin --profile dsh-tui add dsh-workbuddy-connect
dsh --profile dsh-tui
```

> Note: the `dsh-tui` profile requires pnpm 11 to install packages (a different pnpm on PATH fails with `ERR_PNPM_UNEXPECTED_STORE` — use `npx pnpm@11`); verified on dsh `0.1.1-rc.2`.

After installing, switch to a WorkBuddy model in the model picker of the interface you chose. On Web, the settings card (Settings → Plugins → DSH WorkBuddy Connect) shows the account, token validity, and remaining credit; on TUI, configure `authFile` in `/settings`.

## CLI

`dsh plugin --profile <web|desktop|dsh-tui> exec dsh-workbuddy-connect status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available).

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profile (`0.1.1-rc.2`+, Node 22+). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` at the actual file.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
