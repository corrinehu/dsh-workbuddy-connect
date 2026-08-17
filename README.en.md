# WorkBuddy Connect

Use your WorkBuddy (Tencent CodeBuddy) subscription models directly inside [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

English | [中文](./README.md)

## What it does

- Registers the `workbuddy` model provider: the model picker gains a **WorkBuddy** group listing the CLI models available to your account (`auto`, `deepseek-v4-pro`, `glm-5.2`, `kimi-k3-1`, `minimax-m3`, …).
- **Reuses the WorkBuddy desktop app's sign-in**: the plugin reads the desktop app's credential file read-only; there is no separate OAuth flow inside DSH and no API key.
- A loopback endpoint bound to `127.0.0.1` only translates OpenAI-compatible requests into the WorkBuddy upstream's quirks (forced streaming, `tool_choice` object-to-string, CLI-shaped headers). The model catalog refreshes from the upstream at startup.
- Streaming, tool calls, compaction, and permission gates remain Harness-owned; this plugin only supplies the model route.

```
DSH (pi-ai adapter) ──OpenAI format──▶ 127.0.0.1 loopback shim ──translate──▶ copilot.tencent.com /v2/chat/completions
                                          │
                                          ├─ Credentials: reads the WorkBuddy desktop app's file (read-only), refreshes automatically before expiry
                                          └─ Models: GET /console/enterprises/personal/models (cli group)
```

## Install

Prerequisite: the WorkBuddy desktop app is installed and signed in at least once (on macOS the credential lives at `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`).

```sh
dsh plugin --profile <name> add link:/path/to/dsh-workbuddy-connect
dsh --profile <name> --dump-config     # should show the llm-workbuddy layer
dsh web                                # model picker → WorkBuddy group
```

## Configuration

The `cordis.patch.yml` layer needs zero configuration. Optional field:

```yaml
- id: llm-workbuddy
  config:
    authFile: /path/to/workbuddy-desktop.info   # override the desktop credential path (or set WORKBUDDY_AUTH_FILE)
```

## CLI

```sh
dsh plugin --profile <name> exec dsh-workbuddy-connect status --json   # sign-in state + remaining credit
dsh plugin --profile <name> exec dsh-workbuddy-connect doctor --json   # secret-free diagnostics
dsh plugin --profile <name> exec dsh-workbuddy-connect logout          # remove the plugin-owned credential copy
```

## Settings UI

- **Settings → Models**: WorkBuddy appears as a provider card (edit `authFile` here; changes apply live).
- **Settings → Plugins → Plugin configuration**: the expandable "WorkBuddy Connect" card shows the current account, access-token expiry, and per-package remaining credit (auto-refresh every 60 s while expanded, manual refresh available). Data comes from the plugin's loopback status route `/plugins/dsh-workbuddy-connect/status`, which answers same-machine browsers only and never returns token material.

## Credentials and refresh policy

- The desktop app's credential file is **read-only; never written**.
- Five minutes before the access token expires, the plugin calls the official refresh endpoint and stores the result in its own copy at `$DSH_HOME/.workbuddy-auth.json` (mode 0600, atomic writes).
- The effective credential is whichever of the two sources expires later, so a refresh by either side takes effect immediately; switching accounts in the desktop app is followed automatically.
- Note: the refresh token is shared with the desktop app. In the rare case both sides refresh at the same instant, one side may be invalidated; signing in once more in the WorkBuddy app restores it.
- Upstream failures are classified: insufficient credit (HTTP 402), rate limit (429), dead session (401 + 12153 → sign in again in the app).

## Known limitations

- Currently tested on macOS with the DSH Web profile only. The default desktop-credential paths on Windows / Linux are unverified; if the file is not found, point `authFile` or the `WORKBUDDY_AUTH_FILE` environment variable at the actual path (`doctor` diagnoses it).
- Models are declared text-only (the upstream discloses no modality information; under-claiming beats a mid-turn failure). `glm-5v-turbo` vision input is not carried through.
- The upstream protocol is reverse-engineered (wire-compatible with [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api), MIT) and may break as WorkBuddy iterates.
- The loopback shim listens on `127.0.0.1` only.
- Verified combination: DSH plugin API `0.1.0-rc.6`, `@earendil-works/pi-ai` `0.82.1`, Node `^22.19.0 || >=24`.

## Development

```sh
pnpm install
pnpm run check        # typecheck + vitest + build
```

The test suite is fully offline (no real credentials, no upstream calls).

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
