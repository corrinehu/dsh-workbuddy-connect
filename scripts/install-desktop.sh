#!/bin/sh
# Install dsh-workbuddy-connect (jmglsi fork, multi-account) into the DSH
# Desktop profile: add the package, register the bundle, and print the one
# remaining manual step (restart DSH Desktop). macOS/Linux only.
set -eu

REPO="github:jmglsi/dsh-workbuddy-connect"
PROFILE="$HOME/.dsh/profiles/desktop"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE" ] || fail "desktop profile not found at $PROFILE — start DSH Desktop once, then re-run this script."

# --- locate dsh CLI -----------------------------------------------------------
DSH=""
if command -v dsh >/dev/null 2>&1; then
  DSH="dsh"
elif [ -f "$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  DSH="node $HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"
else
  fail "dsh CLI not found (looked in PATH and ~/.dsh/profiles/node_modules)."
fi

# --- locate pnpm 11 (DSH's own pnpm first, then PATH, then npx) ---------------
PNPM=""
for candidate in \
  "$HOME/Library/Application Support/DSH Desktop/runtime-commands/bin/pnpm" \
  "$HOME/.dsh/runtime-commands/bin/pnpm"; do
  if [ -x "$candidate" ]; then PNPM="$candidate"; break; fi
done
if [ -z "$PNPM" ] && command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
fi
if [ -z "$PNPM" ]; then
  PNPM="npx pnpm@11"
fi

# --- install ------------------------------------------------------------------
say "==> Installing $REPO into $PROFILE"
cd "$PROFILE"
$PNPM add "$REPO" >/dev/null 2>&1 || $PNPM add "$REPO"

# --- register bundle ----------------------------------------------------------
say "==> Registering bundle in package.json"
node -e '
const fs = require("node:fs");
const path = "package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const bundles = pkg?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  console.error("error: package.json has no dsh.profile.bundles array — register \"dsh-workbuddy-connect\" manually.");
  process.exit(1);
}
if (!bundles.includes("dsh-workbuddy-connect")) bundles.push("dsh-workbuddy-connect");
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
console.log("    bundles: " + bundles.join(", "));
'

say ""
say "Done. Restart DSH Desktop, then check the model picker for the"
say "WorkBuddy group. For multiple accounts see the README (import + accounts)."
