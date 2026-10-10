# DSH WorkBuddy Connect

English | [中文](./README.md)

Brings every model in the WorkBuddy desktop app (GLM-5.3, GLM-5.2, DeepSeek-V4-Pro, DeepSeek-V4-Flash, Kimi-K3, MiniMax-M3, Hy3, and more) straight into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — zero configuration in the DSH chat.

Both the CN **WorkBuddy** and the international **WorkBuddy AI** apps are supported (international support since **v0.5.0**): whichever one you have installed shows up as its own model group, and having both installed shows both, each with its own account and credit.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **CN and international side by side**: the CN app appears as the **WorkBuddy** group and the international one as **WorkBuddy AI**. Their models, accounts, and credit never mix. **Each group follows only its own app's sign-in**: install just the international app and only WorkBuddy AI appears; install both and both groups appear; sign out of one and that group goes away. Settings likewise shows **one card per version**, each with its own account and balance.

![WorkBuddy AI models in the DSH model picker](assets/5.png)

- **Image input**: most models accept images — paste or drop one straight into the conversation (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1) clearly say so.

- **Reasoning levels**: levels explicitly declared by WorkBuddy appear directly — for example, GLM-5.3 and GLM-5.3-Flash offer low / high / max. For some models that do not declare selectable levels, Web and Desktop provide a **Reasoning levels** control in the model picker for a manual check. It sends a few requests and may consume credit. Models without a check result or selectable levels continue to use WorkBuddy's default.

- **Balance at a glance**: when a WorkBuddy / WorkBuddy AI model is selected, the composer shows the account's remaining credit next to the model selector (e.g. `WB.3,401 credits`, `WB AI.3,401 credits` on the international app). Credit is not polled automatically (every status read performs a real billing query): one read on mount, then refresh on demand with the ↻ beside it.

- **Status and detection**: Settings → Plugins → the matching card shows the account, token validity, remaining credit, and model offers (on DSH `0.1.6+` the entry lives in the left sidebar Plugins panel — see the version table below). It also lets you refresh the model list manually and shows whether the current list came from the upstream or from the built-in fallback, and provides manual reasoning-level detection for eligible models.

- **Model visibility**: both WorkBuddy and WorkBuddy AI cards (Context window tab) let you check which models appear in the model picker. Hidden lists are **saved per signed-in account**: switching accounts switches to that account's own list, switching back restores it; new accounts and newly added models are visible by default. Hiding only affects pickability — **existing chats using a hidden model keep working**.

![Model visibility in the context-window list (DSH 0.1.6+ plugin configuration page)](assets/6.png)

The same UI works unchanged inside the DSH 0.1.5 settings cards:

![Model visibility in a DSH 0.1.5 settings card](assets/7.png)

- **Enterprise credit**: on the CN product, enterprise accounts (non-empty `enterpriseId`) read their cycle quota from the enterprise billing endpoint, and the card shows an "enterprise quota" row with the cycle reset time.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown. The rate is display-only and never affects requests.

- **Promo badges**: promo badges (`限时免费`, `夜间折扣`) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model; the status card also collects currently-discounted models. Per the WorkBuddy service data, synced each time DSH starts. The international version's promotions come from the service's `modelPromotions` (which carry an effective window). Once a promotion lapses its badge is withdrawn; because the service writes the discounted value into the model's own rate field, the original price cannot be reconstructed, so that model then reports "price unavailable — refresh to update" rather than repeating the discounted rate or claiming the model is free.

![Settings card showing the plugin](assets/2.png)

The expanded card has three tabs: **Status** shows the account, token validity, total credit, catalog source, and reasoning-level detection; **Context** lists each model's context window (where the international version offers a larger declared window, the "Use the largest declared context window" switch lives here — it is **on by default**, so DSH sizes context compression to the largest window the upstream declares; turn it off to follow the upstream default instead, and the preference persists across restarts); **Details** shows per-package credit and model offers. The CN and international versions each get their own card, showing their own account's information.

![Settings card showing account and remaining credit](assets/3.png)

## Why reasoning levels work this way

Information about WorkBuddy models' reasoning levels is currently split between upstream API responses and private UI logic in the client, while the model catalog changes quickly. If the plugin filled in one uniform set of levels for every model without an upstream declaration, it would need to keep chasing unpublished product logic with no stable contract.

![Reasoning-level detection in the composer](assets/4.png)

Testing also found that some models accept the `reasoning_effort` parameter while ignoring unknown values and falling back to their default behavior. A successful request alone therefore does not prove that a level is actually usable.

For models without declared levels, Web and Desktop instead use user-authorized, on-demand detection: it first confirms that the upstream validates the parameter, then checks which standard levels it accepts. The check sends a few requests and may consume credit. Its result means only that the upstream currently accepts that level; it does not promise a particular change in reasoning quality, speed, or credit use.

## Install

Prerequisite: the WorkBuddy desktop app is installed and signed in. The plugin reuses the app's sign-in state and follows account switches automatically; the same applies to the international WorkBuddy AI app, and the two do not affect each other.

**Match the plugin version to your DSH core** — from **`0.6.0`** on, one plugin version spans both core generations, removing the per-version pairing; earlier releases still pair one-to-one, and a mismatched combination fails to start DSH. **From `0.7.0` the plugin targets `0.2.0` cores only; `0.1.x` users should stay on `0.6.5`**:

| Plugin | Required DSH core | Desktop app |
|---|---|---|
| **0.7.2** | **supports `0.2.0-rc.2` only** (`0.2.0-rc.1` users should stay on `0.7.0`), and moves `@earendil-works/pi-ai` from a **peer to a regular dependency the plugin ships** (pinned to `0.87.1`): the plugin no longer relies on the copy at the profile's top level, so another package's older copy (e.g. `0.82.x`) cannot shadow it and load the wrong version ([#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)). **On a normal, correct install** it resolves the copy it installed; what resolves still depends on the installer and the profile layout, and the plugin warns at load if a mismatch is found. Also fixes rejected CN `Off` / `Default` requests ([#87](https://github.com/corrinehu/dsh-workbuddy-connect/issues/87)) and Windows uninstall-record encoding ([#88](https://github.com/corrinehu/dsh-workbuddy-connect/issues/88)). | desktop builds bundling the `0.2.0-rc.2` core (preview / nightly) |
| **0.7.1 (historical)** | supports `0.2.0-rc.2` only, and narrows the `@earendil-works/pi-ai` peer from `^0.85.1 \|\| ^0.87.1` to **`^0.87.1`**: pnpm profiles upgraded in place from `0.6.x` no longer keep a stale `pi-ai@0.85.1` that still satisfies the range and re-creates the two-generation mixing of [#69](https://github.com/corrinehu/dsh-workbuddy-connect/issues/69) ([#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74)). **The in-place upgrade from `0.6.5` is verified**: after editing `package.json` and running `pnpm install`, the plugin resolves `pi-ai@0.87.1` with no overrides; the old dual-arm behavior of `0.7.0` admitting `0.85.1` was reproduced as the control. This release still used pi-ai as a **peer**, i.e. the profile's top-level copy — a limitation fixed in `0.7.2` | desktop builds bundling the `0.2.0-rc.2` core (preview / nightly) |
| **0.7.0 (the 0.2.0-era debut)** | **supports `0.2.0-rc.1` / `0.2.0-rc.2` only** (`0.1.5` / `0.1.6` / `0.1.7` are no longer covered — those users should stay on `0.6.5`), verified on a real `0.2.0-rc.2` host (web: loading, both CN and international catalogs, encrypted credentials, status routes all fine). This is the release that adapts to DSH `0.2.0`'s settings-service rework — `0.2.0` replaced the service with a Config-derived form facade that no longer installs sections, so earlier releases lose their settings there. **`0.7.1` drops `rc.1`** | desktop builds bundling the `0.2.0` core (preview / nightly) |
| **0.6.0 (dual-UI adaptive)** | `0.1.5-rc.1` / `rc.2` / `rc.3`; the `0.1.6-alpha` line (incl. `alpha.1` / `alpha.2`) and `0.1.6` stable; verified against `0.1.7-alpha.1` (`0.1.7` stable is inside the range too). **Subsequent `0.1.x` prereleases (e.g. `0.1.8-alpha.x`) DO fall inside the `^0.1.7-alpha.1` arm** — the host's compatibility check resolves peer ranges with includePrerelease semantics (our earlier "not covered" claim was wrong; corrected here); prereleases crossing into `0.2.0` are the ones that need an explicit peer-range extension | `2.0.7`+ works today; desktop builds bundling `0.1.6+` will work too |
| **0.6.5 (final release of the `0.1.x` line)** | adds `0.2.0-rc.1` on top of the `0.6.0` surface (`0.1.5` / `0.1.6` / `0.1.7` / `0.2.0-rc.1`), verified on a real `0.2.0-rc.1` host (web: loading, catalogs, encrypted credentials, chat & image round-trips all fine). Releases up to and including `0.6.4` do not carry that range and are skipped wholesale by DSH `0.2.0-rc.1` (see [#63](https://github.com/corrinehu/dsh-workbuddy-connect/issues/63)) | desktop builds bundling `0.1.x` cores (incl. the released `2.0.7`+ line); `0.2.0-rc.1` works too (verified on web; desktop not yet verified) |
| **0.3.2 – 0.5.4** (international support since `0.5.0`) | the `0.1.5-rc.1` line only (no `0.1.6+`; see [#41](https://github.com/corrinehu/dsh-workbuddy-connect/issues/41)) | `2.0.7`+ (bundled core `0.1.5-rc.1`) |
| **0.3.0 – 0.3.1** | `0.1.2-rc.1` | `2.0.5` |
| **0.2.6** | `0.1.1-rc.2` (older line) | `2.0.3` / `2.0.4` |

- **`0.6.0` does not require upgrading to DSH `0.1.6` just to install WorkBuddy Connect**: the plugin adapts to whichever configuration surface the host actually provides at load time — `0.1.5` and `0.1.6+` each get their own UI, independently.
- **DSH `0.2.0` reworked the settings service**: from `0.2.0` it is a Config-derived form facade exposing only `.volatile()` fields, with no section-installation API. The plugin adapts to what the host actually offers: on `0.1.5` / `0.1.6` both sections install as before (so `authFile` / `authFileAI` stay readable from `settings.yaml` and the TUI `/settings`), while on `0.1.7`+ / `0.2.0` it degrades to a settings-less provider — models, the picker, model visibility, and the context rows all keep working; only the "use the upstream's declared maximum context window" preference stops being persistable, and the card renders no switch it could not save.
- **Where the cards live depends on the DSH version** — each generation has its own place:

  ```text
  DSH 0.1.5 + this plugin
  ├─ Settings → Models
  │   └─ no WorkBuddy rows ← unified with 0.1.6+ (only plugins ≤0.5.4 still showed those old
  │                            configurable-provider rows)
  ├─ Settings → Plugins
  │   ├─ DSH WorkBuddy Connect      ✅ config card (CN)
  │   └─ DSH WorkBuddy AI Connect   ✅ config card (international)
  └─ chat model picker
      └─ WorkBuddy / WorkBuddy AI groups ✅

  DSH 0.1.6+ + this plugin
  ├─ Settings → Models
  │   └─ no WorkBuddy rows          ← intentional, consistent across both generations
  ├─ Settings → Built-in Plugins
  │   └─ workbuddy-connect          ← read-only inventory (runtime status), no config entry
  ├─ main UI → Plugins → workbuddy-connect → View
  │   ├─ DSH WorkBuddy Connect      ✅ new config entry (CN)
  │   └─ DSH WorkBuddy AI Connect   ✅ new config entry (international)
  └─ chat model picker
      └─ WorkBuddy / WorkBuddy AI groups ✅
  ```

- From `0.6.0` on, the Models settings page no longer shows the non-editable WorkBuddy / WorkBuddy AI cards (consistent across both core generations); the model picker, `/model`, and chat calls are unaffected.
- On DSH `0.2.0-rc.2`, install `0.7.2`: `dsh plugin --profile web add dsh-workbuddy-connect@0.7.2`; on `0.2.0-rc.1`, stay on `0.7.0`: `dsh plugin --profile web add dsh-workbuddy-connect@0.7.0`
- pnpm profiles upgraded in place from `0.6.x` (with a manually installed `pi-ai@0.85.1`): on `0.7.1` the peer range no longer admits `0.85.1`, so `pnpm install` moves the plugin onto the host's `0.87.1`; the temporary `overrides: {'@earendil-works/pi-ai': 0.87.1}` from [#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74) can be removed
- **Do not upgrade the profile-level `@earendil-works/pi-ai` to 1.x**: this plugin and the `0.2.0-rc.2` DSH core both require `^0.87.1` (from `0.7.2` the plugin ships its own copy, see `dependencies` in `package.json`; `0.7.1` and earlier declared it under `peerDependencies`). Upgrading to 1.x may make the plugin load an incompatible version and leave different pi-ai versions coexisting in the install tree. **Some third-party plugin managers (e.g. `@linxin666/dsh-client-ui-plugin-manager@0.4.5`) decide "updates" from third-party packages and `dsh.engines.dsh` alone, without checking peer constraints**, so they may list `pi-ai` as updatable — do not act on that prompt (see [#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86))
- Before upgrading `0.7.1` → `0.7.2`, confirm the host core is `0.2.0-rc.2` (`0.7.2` supports `rc.2` only; users still on `rc.1` should stay on `0.7.0`). Now that the plugin ships pi-ai itself, any `overrides: {'@earendil-works/pi-ai': 0.87.1}` added to the profile for [#74](https://github.com/corrinehu/dsh-workbuddy-connect/issues/74) / [#82](https://github.com/corrinehu/dsh-workbuddy-connect/issues/82) should **not be removed blindly** — if other plugins still rely on it to resolve the right version, dropping it may affect them; check that those plugins and DSH itself all resolve correctly before cleaning up, and keep it when unsure (it no longer conflicts with this plugin)
- Still on DSH `0.1.5` / `0.1.6` / `0.1.7`? Stay on `0.6.5`: `dsh plugin --profile web add dsh-workbuddy-connect@0.6.5`
- Still on DSH `0.1.2-rc.1`? Stay on `0.3.1`: `dsh plugin --profile web add dsh-workbuddy-connect@0.3.1`
- Still on DSH `0.1.1-rc.2`? Stay on the older release: `dsh plugin --profile web add dsh-workbuddy-connect@0.2.6`
- Pick the desktop plugin version by the **bundled core**: desktop builds bundling `0.1.x` cores (incl. the released `2.0.7`+ line) should use `dsh-workbuddy-connect@0.6.5`; desktop builds bundling the `0.2.0-rc.2` core should use `0.7.2`, and those bundling `0.2.0-rc.1` should use `0.7.0` (preview / nightly); `2.0.5` and earlier apps (bundled `0.1.2-rc.1`) should stay on `0.3.1`

The plugin runs under all three DSH interfaces: **Web**, **Desktop**, and **TUI**.

**Recommended: hand the install to an Agent.** No manual commands needed — paste the brief below verbatim to your AI assistant (the built-in DSH agent, Claude Code, Codex, Cursor, …) and let it pick the right mechanism, the right version, and verify the result for your environment:

```markdown
Please install the DSH (DeepSeek Harness) plugin dsh-workbuddy-connect for me and verify it afterwards.

Constraints and facts:
- The plugin version must match the DSH core. Check the core version first — mind the source:
  for Web / TUI read the standalone CLI's `dsh --version`; for the Desktop app you must confirm
  its **bundled DSH core version** (the desktop app's About page) — never substitute the standalone
  CLI's version for the desktop app's core.
  Core `0.2.0-rc.2` -> install `0.7.2`; core `0.2.0-rc.1` -> pin `0.7.0`; cores `0.1.5`-`0.1.7` -> pin `0.6.5`;
  older cores follow the version table in the README at
  https://github.com/corrinehu/dsh-workbuddy-connect.
- The interface I use is: (tell the Agent one of: Web / Desktop app / TUI)
- Web: run `dsh plugin --profile web add dsh-workbuddy-connect` (append `@<version>` to pin).
- TUI: run `dsh plugin --profile dsh-tui add dsh-workbuddy-connect`; that profile requires pnpm 11.
- Desktop app: the `desktop` profile is managed exclusively by the Electron app — any
  `dsh plugin --profile desktop ...` command is rejected by the CLI with
  `profile "desktop" is managed exclusively by the Electron application`.
  Preferred: guide me through the desktop app's built-in plugin manager. If going through the file
  route instead, every step matters: (1) confirm the profile directory the desktop app actually
  uses (default `~/.dsh/profiles/desktop`, on Windows `%USERPROFILE%\.dsh\profiles\desktop` —
  verify against reality); (2) have me fully quit the desktop app; (3) back up `package.json` and
  `pnpm-lock.yaml` in that directory; (4) add `"dsh-workbuddy-connect": "<version>"` to
  dependencies; (5) install in that directory with the pnpm matching the profile (prefer the pnpm
  bundled with the desktop app; a mismatched one may fail with store errors — switch versions per
  the error message and retry); (6) relaunch the desktop app.
- Verification: after restarting the interface, the model picker should show the
  "WorkBuddy / WorkBuddy AI" groups — with only the CN or only the international app installed,
  verify just the corresponding group. Groups and credit being visible only proves the plugin
  loaded and the catalog and account were read; pick one model from the group and finish a short
  conversation — a normal reply is what counts as a working integration.
```

<details>
<summary>Manual install (command line, Web / TUI only)</summary>

```sh
# Web (recommended; ships prebuilt artifacts)
dsh plugin --profile web add dsh-workbuddy-connect
dsh web

# or install the Web version from the GitHub source
dsh plugin --profile web add github:corrinehu/dsh-workbuddy-connect
dsh web

# TUI (terminal UI)
dsh plugin --profile dsh-tui add dsh-workbuddy-connect
dsh --profile dsh-tui
```

The Desktop app does not install via the command line: the `desktop` profile is managed exclusively by the Electron app and the CLI rejects it outright (`profile "desktop" is managed exclusively by the Electron application`). Use the desktop app's built-in plugin manager instead.

</details>

> **TUI users, check the version pairing**: the terminal UI package (`@deepseek-harness-tui/dsh-tui`) must be **`0.10.0-beta.5` or newer** — older versions fail at startup with `events is not iterable` when this plugin is installed. Update the shell first (via its built-in update command or a fresh install), then add this plugin; the newest release is a beta, and a stable one will work the same way.

> Manual reasoning-level detection is currently available only on Web and Desktop; TUI does not provide a detection action.

> Note: the `dsh-tui` profile requires pnpm 11 to install packages (a different pnpm on PATH fails with `ERR_PNPM_UNEXPECTED_STORE` — use `npx pnpm@11`).

After installing, switch to a WorkBuddy model in the model picker of the interface you chose. On Web and Desktop, the settings card shows the account, token validity, and remaining credit, can refresh the model list manually, and can check eligible models for reasoning levels; the CN and international versions each have their own card. On TUI, configure `authFile` in `/settings` (or `authFileAI` for the international version).

## CLI

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available). The `desktop` profile is managed exclusively by the desktop app, so the CLI (including `exec`) does not work against it.

Both commands target the CN version by default; add `--provider workbuddy-ai` for the international one:

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` removes only that version's plugin-owned credential copy. It leaves the desktop app's own sign-in alone and does not promise the model group will disappear (the app's credential file still supplies one).

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profiles (as of 0.3.2 this requires `0.1.5-rc.1`+ and Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` (or `WORKBUDDY_AI_AUTH_FILE` for the international version) at the actual file.
- **Encrypted desktop credential helper discovery**: both the CN and international versions (whose credentials are encrypted since 5.6.2) use their own verified default path and app discovery on macOS; on Windows the CN version first checks `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` and then the WorkBuddy uninstall registry records, while the international version has no verified default install location and checks the registry records only. Each product locates and runs only its own app identity (bundle id / registry name / executable name), so neither can pick the other's app; both apps currently happening to share one at-rest key on a machine is an upstream coincidence the plugin does not rely on — if the keys diverge, the diagnosis is reported rather than a wrong open attempted. If automatic discovery still fails, set the product's variable — `WORKBUDDY_ELECTRON_BIN` for CN, `WORKBUDDY_AI_ELECTRON_BIN` for international (separate since 0.6.4; if you previously pointed `WORKBUDDY_ELECTRON_BIN` at the international app, switch to the new variable and clear the old one) — then fully quit and restart DSH (the variable is read when the plugin is constructed); on Windows, sign out and back in first if possible (explorer caches the old environment block). Linux has no built-in auto-discovery; the card offers Agent Assist when needed, while an explicit environment path remains supported.
- **The international version's model catalog comes from the app's own interface**: the service splits it by User-Agent, which is a private implementation detail that a server-side change can break. When that happens the plugin degrades to this account's last successful catalog and then to its built-in roster, showing the source (live / saved / built-in), the fetch time, and the failure reason on the card — but long-term compatibility is not guaranteed. The CN version's catalog uses the same interface as the official CLI and is unaffected.
- **International-version environments not yet covered**: on Windows / WSL / Linux no reliable source for the international app's version has been located yet, so the saved value or the built-in default is used. On macOS, real-shim checks covered complete GPT-family replies, tool calls, and continued turns.
- **Behaviour change with no credentials**: a version whose app was never signed in — and that left no plugin-owned copy — no longer shows a model group. The CN version used to display a built-in fallback list, but every model on it failed when selected.
- **The enterprise credit path currently covers the CN product only**: the international enterprise billing interface is unverified, so those accounts still read through the personal endpoint pending measurement. The enterprise branch could not be tested locally (the development machine holds a personal account); it was implemented from the official app's interface contract, and reports from enterprise users are welcome.
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
