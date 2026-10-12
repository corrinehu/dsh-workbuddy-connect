# Per-turn credit spend beside the turn timestamp

Closes #99.

## Why

The composer's credit badge shows one rolling delta: whatever the last balance
read happened to bracket. It cannot show what a *particular* reply cost, because
it is a single number that the next read overwrites. A reply's own cost only has
somewhere to live if it is keyed by the reply.

WorkBuddy bills a subscription quota — there is no per-token price to multiply
out (`NO_COST` in `lib/index.js` exists for exactly this reason), so the only
honest measurement is the difference between two balance reads. That makes
"what did turn 7 cost" a bookkeeping question: keep the balance before and after
each turn, and subtract.

## What it does

- Reads the balance once more when a turn ends, so a figure appears without
  anyone pressing ↻
- Files that difference under the turn number, keeping the last 60 per session
- Renders the result in `conversation.chat.turnTail`, which is the only mount
  point that both renders once per completed turn and hands over the turn number

## Design notes

**Two independent gates before a reading becomes a turn's cost.** The first is
having a turn to attribute to: the reading must land while a turn is open, or
within 30s of one closing — the closing read can arrive on either side of
`turn/end`, so both orders have to be accepted. Without this gate a manual ↻
against an idle session would file its (usually zero) delta against the last
turn and erase the real figure. The second is direction: a balance that went up
is a top-up or a new cycle, so it resets the baseline instead of reporting a
negative cost.

**A missing figure is not a zero.** The host omits a turn when it has no
comparable pair of reads — never bracketed, account switched, baseline reset,
read failed — and the client renders nothing for those. Painting `−0` would
claim a reply was free when the truth is that nobody measured it. A genuine zero
*is* rendered, because a reply that consumed nothing is a real answer.

**The host keeps one baseline per account, not a rolling window.** An earlier
version held the last 8 observations in a ring. That looked right against a
single steady reader, but the GUI has several — a remount, a second probe, the
CN and international variants each read independently — and one turn's pair of
reads could be separated by enough others that its baseline was evicted. The
symptom was a figure that appeared and vanished depending on how chatty the
reader happened to be. A map keyed by account has no eviction to get wrong.

**Cost.** No billing traffic per footer: every instance reads the shared store,
and the store holds the one document the last read produced. A hundred footers
cost one read.

## Testing

- `npx tsc -p tsconfig.json --noEmit` and `-p tsconfig.client.json --noEmit`: clean
- `npx vitest run`: 688 passed / 26 failed — identical to the baseline before
  this change. The 26 are pre-existing and environment-specific on Windows
  (electron discovery walks macOS paths, WSL-keyed auth setup, permission-bit
  and registry assumptions); none touch this code.
- `tests/client-fallback.spec.ts`, which drives the real `apply()` outside React,
  updated for the new registration and passing

## Where the figure sits

`conversation.chat.turnTail` renders on the line above the action row, right
aligned. It cannot land *inside* that row: the right-hand group — token panel
plus clock — is a component-internal span in `MessageIconActions` with no slot,
so a plugin cannot contribute there. If the host ever exposes a seat in that
group, this entry can move into it without changing anything else.

## No new dependencies

`package.json`, `tsdown.config.ts` and `pnpm-lock.yaml` are untouched.
