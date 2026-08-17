# dsh-workbuddy-connect

Call the models in your WorkBuddy desktop app from [DSH](https://github.com/deepseek-ai/deepseek-harness); they follow the app state automatically. No API key needed.

English | [中文](./README.md)

## Features

- **Models out of the box**: every model available to your WorkBuddy account (DeepSeek-V4-Pro, GLM-5.2, Kimi-K3, MiniMax-M3, the Auto router, …) appears in the DSH model picker under the WorkBuddy group, synced with your account entitlements.
- **No API key, no sign-in setup**: the plugin reuses the WorkBuddy desktop app's signed-in state, renews tokens automatically, and follows account switches in the app instantly.
- **A native DSH experience**: streaming, tool calls, compaction, and approvals all come from DSH — the plugin only supplies the model route; remaining credit is visible anytime in the settings card.

## Install

Prerequisite: the WorkBuddy desktop app is installed and signed in at least once.

```sh
dsh plugin --profile <name> add github:corrinehu/dsh-workbuddy-connect
dsh web
```

## Usage

- After installing, pick a model from the WorkBuddy group in the chat model picker and start talking.
- **Settings → Plugins → Plugin configuration**: expand the "WorkBuddy Connect" card to see the current account, token validity, and per-package remaining credit, with a manual refresh button.
- CLI: `dsh plugin --profile <name> exec dsh-workbuddy-connect status` reports sign-in state and remaining credit (add `--json` for machine-readable output; `doctor` and `logout` are also available).

## Known limitations

- Tested on macOS with the DSH Web profile only; the default credential paths on Windows / Linux are unverified — point the `WORKBUDDY_AUTH_FILE` environment variable at the actual location if needed.
- Relies on WorkBuddy client interfaces (not a public API), so the plugin may need updates as WorkBuddy changes. Verified on DSH `0.1.0-rc.6`, Node 22+.

## Development

```sh
pnpm install
pnpm run check        # typecheck + vitest + build
```

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy / CodeBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy / CodeBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH bundle and pi-ai provider registration.

## License

[MIT](./LICENSE)
