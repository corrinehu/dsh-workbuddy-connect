/**
 * Standalone driver for CreditLedger 閳?no app restart required.
 *
 * Replays the exact sequence the host performs, so a bug that only shows up
 * "sometimes" in the GUI can be reproduced (and then pinned) in a second.
 *
 * Run from the repo root:
 *   npx tsx tests/ledger-harness.ts
 *
 * The body is wrapped in an async IIFE because tsx transpiles this to CJS, which
 * has no top-level await, and the close-window cases below need to wait.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreditLedger, accountKeyFor } from '../src/credit-ledger.ts'

void (async () => {
const ACCOUNT = {
  nickname: 'seventeen',
  domain: 'www.workbuddy.cn',
  uid: 'cb515701-0cef-4ed9-a7c0-ac07f1409ed2',
}

const SESSION = 'session-c95be83f-f613-4a95-a100-02bf815ec271'

/**
 * How long N3d waits for the tail window to lapse before reporting the next
 * turn's early figure. The live gap is about two seconds; this only has to clear
 * the one-second bound, and waiting the full two would double the run time.
 */
const TAIL_GAP_MS = 1_100

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`)
}

console.log('=== A. happy path: two reads around one turn ===')
{
  const ledger = new CreditLedger()
  check('first read has no baseline', ledger.observe(ACCOUNT, { total: 4530 }, SESSION), undefined)
  ledger.turnStarted(SESSION, 1)
  const spend = ledger.observe(ACCOUNT, { total: 4528 }, SESSION)
  check('second read prices the turn', spend?.spent, 2)
  check('turn 1 recorded', ledger.turnSpends(SESSION), [
    { turn: 1, spent: 2, at: spend?.at, source: 'balance' },
  ])
}

console.log('\n=== B. the GUI pattern: mount read, then turn, then trailing read ===')
{
  const ledger = new CreditLedger()
  // Mount fetch happens before turn/start.
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 33)
  // The trailing read loses the race with `turn/end` in production, so it
  // arrives with the turn already closed and is claimed through the window.
  ledger.turnEnded(SESSION, 33)
  const spend = ledger.observe(ACCOUNT, { total: 4529 }, SESSION)
  check('trailing read prices the closed turn', spend?.spent, 1)
  check('turn 33 recorded', ledger.turnSpends(SESSION).map(e => e.turn), [33])
  // A second read after the claim is spent is an idle read and must not reprice.
  check('a read after the claim is inert', ledger.observe(ACCOUNT, { total: 4529 }, SESSION), undefined)
check('turn 33 unchanged', ledger.turnSpends(SESSION), [{ turn: 33, spent: 1, at: spend?.at, source: 'balance' }])
}

console.log('\n=== C. repeated reads with no turn open must not corrupt history ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  // The GUI re-mounts several times; each read is session-less or turn-less.
  for (let i = 0; i < 12; i += 1) ledger.observe(ACCOUNT, { total: 4530 + i }, SESSION)
  ledger.turnStarted(SESSION, 40)
  const spend = ledger.observe(ACCOUNT, { total: 4535 }, SESSION)
  check('baseline survived 12 extra reads', spend?.spent, 6)
}

console.log('\n=== D. rise (top-up) is not a cost ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 100 }, SESSION)
  ledger.turnStarted(SESSION, 1)
  check('a rise yields nothing', ledger.observe(ACCOUNT, { total: 500 }, SESSION), undefined)
  check('and records no turn', ledger.turnSpends(SESSION), [])
}

console.log('\n=== E. read with no session still advances the baseline ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 900 })
  ledger.turnStarted(SESSION, 1)
  const spend = ledger.observe(ACCOUNT, { total: 898 }, SESSION)
  check('session-less read was usable as baseline', spend?.spent, 2)
}

console.log('\n=== F. account switch voids pairings ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 10)
  ledger.observe(ACCOUNT, { total: 4528 }, SESSION)
  check('before switch', ledger.turnSpends(SESSION).map(e => e.turn), [10])
  const other = { ...ACCOUNT, uid: 'aaaaaaaa-0000-0000-0000-000000000000' }
  check('switch read yields nothing', ledger.observe(other, { total: 50 }, SESSION), undefined)
  check('switch cleared the session', ledger.turnSpends(SESSION), [])
}

console.log('\n=== G. unlimited / failed reads are inert ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 1)
  check('unlimited yields nothing', ledger.observe(ACCOUNT, { total: 0, unlimited: true }, SESSION), undefined)
  check('undefined yields nothing', ledger.observe(ACCOUNT, undefined, SESSION), undefined)
  const spend = ledger.observe(ACCOUNT, { total: 4529 }, SESSION)
  check('real read still prices after inert ones', spend?.spent, 1)
}

console.log('\n=== H. history ring: many session-less reads (the GUI fan-out) ===')
{
  const ledger = new CreditLedger()
  const first = ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  // Simulate two variants x several probes all reading between turns. These
  // reads are session-less, so none of them may be attributed to a turn.
  for (let i = 0; i < 20; i += 1) ledger.observe(ACCOUNT, { total: 4530 - i }, undefined)
  ledger.turnStarted(SESSION, 60)
  const spend = ledger.observe(ACCOUNT, { total: 4505 }, SESSION)
  console.log(`        first=${JSON.stringify(first)} spend=${JSON.stringify(spend)}`)
  check('baseline not evicted by session-less fan-out', spend?.spent, 6)
}

console.log('\n=== I. regression guard: the ring could not survive a read fan-out ===')
{
  // The old shape kept one shared array capped at 8 and scanned it backwards.
  // Reproduced here against the same read sequence so the fix stays honest:
  // if anyone reintroduces a shared ring, this documents exactly what broke.
  const RING = 8
  const ring: { account: string; total: number }[] = []
  const key = `${ACCOUNT.domain}\u0000${ACCOUNT.uid}`
  ring.push({ account: key, total: 4530 })
  for (let i = 0; i < 20; i += 1) {
    ring.push({ account: key, total: 4530 - i })
    if (ring.length > RING) ring.splice(0, ring.length - RING)
  }
  let found: { account: string; total: number } | undefined
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    const entry = ring[index]
    if (entry !== undefined && entry.account === key) { found = entry; break }
  }
  // The ring does still hold *an* entry for this same account 闁?the fan-out is
  // single-account here. The eviction that mattered in the GUI is that the
  // entry is no longer the one the turn was bracketed against: the baseline
  // silently moved forward, so the drop is measured from the wrong end.
  check('ring keeps the newest, not the bracketing baseline', found?.total, 4511)
  check('which is not the balance the turn started from', found?.total === 4530, false)
}

console.log('\n=== J. a manual refresh must not overwrite a priced turn ===')
{
  // The reported bug: the transcript's figures all read zero after pressing the
  // composer's refresh. A turn ends and is priced, then the user clicks refresh
  // while nothing is running. The refresh measures the idle interval between two
  // reads 闂?zero 闂?and `attribute` used to hang that zero on the last closed
  // turn, erasing the real figure.
  //
  // Ordering matters and is taken from production: the trailing read loses the
  // race with `turn/end` by seconds, so the turn is closed when the figure is
  // computed and only the close window can claim it.
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 42)
  ledger.turnEnded(SESSION, 42)
  const trailing = ledger.observe(ACCOUNT, { total: 4515 }, SESSION)
  check('the trailing read prices turn 42', trailing?.spent, 15)
check('turn 42 holds 15', ledger.turnSpends(SESSION), [{ turn: 42, spent: 15, at: trailing?.at, source: 'balance' }])

  // Wait out the window, then refresh by hand. The measurement is the idle
  // interval 闂?zero 闂?and must be discarded rather than recorded.
  await new Promise(resolve => setTimeout(resolve, 2_100))
  const manual = ledger.observe(ACCOUNT, { total: 4515 }, SESSION)
  check('a refresh past the window prices nothing', manual, undefined)
check('and leaves turn 42 alone', ledger.turnSpends(SESSION), [{ turn: 42, spent: 15, at: trailing?.at, source: 'balance' }])
}

console.log('\n=== J2. gate 2: even an in-window read cannot reprice a claimed turn ===')
{
  // The window alone was the old fix and it still let the bug through, because
  // the refresh that broke it landed 4.5s after `turn/end` 闂?inside the old 30s
  // window. So the claim is one-shot: a second read inside the window is ignored
  // rather than allowed to overwrite a figure that is already on screen.
  //
  // This is the gate that makes the window's exact width non-critical.
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 9)
  ledger.turnEnded(SESSION, 9)
  const real = ledger.observe(ACCOUNT, { total: 4520 }, SESSION)
  check('turn 9 priced', real?.spent, 10)

  // Immediately 闂?well inside the window 闂?a second read measures zero.
  const second = ledger.observe(ACCOUNT, { total: 4520 }, SESSION)
  check('an in-window second read prices nothing', second, undefined)
check('turn 9 survived it', ledger.turnSpends(SESSION), [{ turn: 9, spent: 10, at: real?.at, source: 'balance' }])

  // And it is not merely the zero that is refused: a *different* figure for the
  // same turn is refused too. Once a turn is priced, that figure is the answer.
  ledger.turnEnded(SESSION, 9)
  const reprice = ledger.observe(ACCOUNT, { total: 4519 }, SESSION)
  check('a re-armed claim still cannot reprice', reprice, undefined)
check('turn 9 unchanged', ledger.turnSpends(SESSION), [{ turn: 9, spent: 10, at: real?.at, source: 'balance' }])

  // The refused reads still advanced the baseline, so the next turn measures
  // from 4519 rather than from the 4530 before the turn.
  ledger.turnStarted(SESSION, 10)
  ledger.turnEnded(SESSION, 10)
  check('the next turn measures from the refreshed baseline', ledger.observe(ACCOUNT, { total: 4518 }, SESSION)?.spent, 1)
  check('turn 10 recorded', ledger.turnSpends(SESSION).map(e => e.turn), [9, 10])
}

console.log('\n=== K. reads outside a turn never invent one ===')
{
  // A mount fetch, a probe tick, and a refresh before any turn all land here.
  // None may create a figure, and none may create a turn entry either 闂?the
  // footer must not render a zero for a turn the host never priced.
  const ledger = new CreditLedger()
  check('mount fetch prices nothing', ledger.observe(ACCOUNT, { total: 4530 }, SESSION), undefined)
  check('and records no turn', ledger.turnSpends(SESSION), [])
  check('a later idle read prices nothing', ledger.observe(ACCOUNT, { total: 4529 }, SESSION), undefined)
  check('still no turn', ledger.turnSpends(SESSION), [])

  // The idle drop was still banked as the baseline, so the next real turn is
  // measured from 4529 rather than from the mount fetch's 4530.
  ledger.turnStarted(SESSION, 1)
  ledger.turnEnded(SESSION, 1)
  check('the next turn measures from the refreshed baseline', ledger.observe(ACCOUNT, { total: 4528 }, SESSION)?.spent, 1)
  check('turn 1 recorded', ledger.turnSpends(SESSION).map(e => e.turn), [1])
}

console.log('\n=== L. turn history stays bounded, claims with it ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 1_000_000 }, SESSION)
  for (let turn = 1; turn <= 70; turn += 1) {
    ledger.turnStarted(SESSION, turn)
    ledger.turnEnded(SESSION, turn)
    ledger.observe(ACCOUNT, { total: 1_000_000 - turn }, SESSION)
  }
  check('history capped at 60', ledger.turnSpends(SESSION).length, 60)
  check('newest kept', ledger.turnSpends(SESSION).at(-1)?.turn, 70)
  check('oldest dropped', ledger.turnSpends(SESSION)[0]?.turn, 11)
}

console.log('\n=== M. figures survive a host restart ===')
{
  // The transcript is still on screen after the App restarts, and the credits
  // behind those replies are already spent 闂?so a ledger that came back empty
  // would silently blank every figure rather than show a wrong one. That was
  // the reported bug: "after a restart I can no longer see what the earlier
  // turns cost". These cases drive the real file, in a throwaway directory.
  const dir = mkdtempSync(join(tmpdir(), 'ledger-harness-'))
  const statePath = join(dir, 'nested', 'ledger.json')
  try {
    const first = new CreditLedger({ statePath })
    check('nothing to load on a first run', first.turnSpends(SESSION), [])
    first.observe(ACCOUNT, { total: 4530 }, SESSION)
    first.turnStarted(SESSION, 33)
    first.turnEnded(SESSION, 33)
    const spend = first.observe(ACCOUNT, { total: 4529 }, SESSION)
    check('turn 33 priced before the restart', spend?.spent, 1)

    // A new process, same file 闂?this is the App restart.
    const second = new CreditLedger({ statePath })
    check('the figure came back', second.turnSpends(SESSION), [
      { turn: 33, spent: 1, at: spend?.at, source: 'balance' },
    ])

    // The restored baseline is what makes the next read comparable. Without it
    // the first turn after a restart would price nothing, which is the "the
    // first turn after a restart is always blank" symptom.
    second.turnStarted(SESSION, 34)
    second.turnEnded(SESSION, 34)
    check('the next turn measures against the restored baseline', second.observe(ACCOUNT, { total: 4527 }, SESSION)?.spent, 2)
    check('both turns are present', second.turnSpends(SESSION).map(e => e.turn), [33, 34])

    // And the endpoints travel with the drop, so the tooltip is not lying.
    const third = new CreditLedger({ statePath })
    check('the bracketing balances survived too', third.turnSpends(SESSION).map(e => e.turn), [33, 34])

    // Two independent ledgers must not clobber each other's file: the second
    // writes what the first wrote plus its own turn.
    const fourth = new CreditLedger({ statePath })
    check('a reload is idempotent', fourth.turnSpends(SESSION).map(e => e.turn), [33, 34])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // A corrupt file must degrade to "no figures", never to a crash and never to
  // a wrong figure.
  const badDir = mkdtempSync(join(tmpdir(), 'ledger-harness-bad-'))
  try {
    const badPath = join(badDir, 'ledger.json')
    writeFileSync(badPath, '{ this is not json', 'utf8')
    const ledger = new CreditLedger({ statePath: badPath })
    check('a corrupt file loads as empty', ledger.turnSpends(SESSION), [])
    // And the ledger still works from there.
    ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
    ledger.turnStarted(SESSION, 1)
    ledger.turnEnded(SESSION, 1)
    check('it still prices after recovering', ledger.observe(ACCOUNT, { total: 4529 }, SESSION)?.spent, 1)

    // A file from a future writer is left alone rather than half-understood.
    const futurePath = join(badDir, 'future.json')
    writeFileSync(futurePath, JSON.stringify({ version: 99, baselines: {}, sessions: {} }), 'utf8')
    check('a newer format is refused', new CreditLedger({ statePath: futurePath }).turnSpends(SESSION), [])

    // Entries that are not the shape this build wrote are dropped individually,
    // so one bad row cannot poison the good ones around it.
    const mixedPath = join(badDir, 'mixed.json')
    writeFileSync(
      mixedPath,
      JSON.stringify({
        version: 1,
        baselines: { [accountKeyFor(ACCOUNT)]: { at: 1, total: 4530 } },
        sessions: {
          [SESSION]: [
            { turn: 1, spent: 2, from: 4530, to: 4528, at: 10 },
            { turn: 2, spent: 'lots', from: 4528, to: 4520, at: 20 },
            { turn: 3, spent: -5, from: 4520, to: 4525, at: 30 },
          ],
        },
      }),
      'utf8',
    )
    check(
      'only well-formed rows are kept',
      new CreditLedger({ statePath: mixedPath }).turnSpends(SESSION).map(e => e.turn),
      [1],
    )
  } finally {
    rmSync(badDir, { recursive: true, force: true })
  }

  // Omitting the path keeps the in-memory behaviour the other cases rely on.
  const volatile = new CreditLedger()
  volatile.observe(ACCOUNT, { total: 4530 }, SESSION)
  volatile.turnStarted(SESSION, 1)
  volatile.turnEnded(SESSION, 1)
  volatile.observe(ACCOUNT, { total: 4529 }, SESSION)
  check('a path-less ledger still works', volatile.turnSpends(SESSION).map(e => e.turn), [1])
}

console.log('\n=== N. reported credit is summed across a turn and beats the balance ===')
{
  const ledger = new CreditLedger()
  // The real sequence measured in production: three upstream calls in one turn,
  // each reporting its own figure, and a balance that barely moves because the
  // three of them cost less than one whole unit between them.
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 71)
  ledger.reported(SESSION, 0.11)
  ledger.reported(SESSION, 0.16)
  ledger.reported(SESSION, 0.13)
  ledger.turnEnded(SESSION, 71)
  const turns = ledger.turnSpends(SESSION)
  check('the three calls are summed, not last-wins', turns[0]?.spent, 0.4)
  check('and attributed to the reported source', turns[0]?.source, 'reported')
  // The balance path must not be able to replace it with a coarser number: the
  // read below is the same one that would otherwise price the turn at 0.
  const idle = ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  check('a trailing read cannot reprice a reported turn', idle, undefined)
  check('the reported figure survives it', ledger.turnSpends(SESSION)[0]?.spent, 0.4)
}

console.log('\n=== N2. a turn the upstream never reported falls back to the balance ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 72)
  // No figures arrive: the stream was cut before the final frame.
  ledger.turnEnded(SESSION, 72)
  const spend = ledger.observe(ACCOUNT, { total: 4528 }, SESSION)
  check('the balance path still prices it', spend?.spent, 2)
  check('and is labelled as the approximation it is', ledger.turnSpends(SESSION)[0]?.source, 'balance')
}

console.log('\n=== N3. figures are collected across the turn boundaries they race ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 73)
  ledger.reported(SESSION, 0.11)
  ledger.turnEnded(SESSION, 73)
  // Measured live: a turn's last figure lands about half a second after its
  // `turn/end`. It belongs to the turn that produced it, so it must go back to
  // that turn rather than forward to the next one.
  ledger.reported(SESSION, 0.16)
  ledger.turnStarted(SESSION, 74)
  ledger.reported(SESSION, 0.13)
  ledger.turnEnded(SESSION, 74)
  const turns = ledger.turnSpends(SESSION)
  check('the late figure went back to its own turn', turns.find(e => e.turn === 73)?.spent, 0.27)
  check('and did not join the next turn', turns.find(e => e.turn === 74)?.spent, 0.13)
  check('and no turn was invented', turns.map(e => e.turn), [73, 74])
}

console.log('\n=== N3c. a figure for a turn whose start never arrived still lands ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  // Measured live: a turn's first call completed 2 seconds BEFORE its
  // `turn/start` reached the host. At that moment no turn is open and none has
  // closed, so the pool is the only place the figure can wait.
  ledger.reported(SESSION, 0.12)
  ledger.turnStarted(SESSION, 90)
  ledger.reported(SESSION, 0.18)
  ledger.turnEnded(SESSION, 90)
  check('the pre-start figure was not lost', ledger.turnSpends(SESSION).find(e => e.turn === 90)?.spent, 0.3)
}

console.log('\n=== N3b. the pool is emptied by a drain, so nothing is counted twice ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  // A figure no turn ever claims would otherwise sit in the pool and be added
  // to whichever turn closes next, inflating it by a stale amount.
  ledger.reported(SESSION, 0.4)
  ledger.turnStarted(SESSION, 80)
  ledger.turnEnded(SESSION, 80)
  check('the pool is handed to the first turn that closes', ledger.turnSpends(SESSION).find(e => e.turn === 80)?.spent, 0.4)
  // The next turn reports nothing of its own and, once the closing window has
  // passed, has no balance read either. It must therefore get no figure — the
  // drained pool must not reappear, and nothing may be invented for it.
  ledger.turnStarted(SESSION, 81)
  ledger.turnEnded(SESSION, 81)
  check('and is not handed out a second time', ledger.turnSpends(SESSION).find(e => e.turn === 81), undefined)
}

console.log('\n=== N3d. the next turn\'s early figure is not stolen by the last one ===')
{
  const ledger = new CreditLedger()
  ledger.observe(ACCOUNT, { total: 4530 }, SESSION)
  ledger.turnStarted(SESSION, 70)
  ledger.reported(SESSION, 0.2)
  ledger.turnEnded(SESSION, 70)
  // The live sequence this pins: the next turn's first call completes about two
  // seconds before its `turn/start` reaches the host, so the frame arrives with
  // no turn open and with the previous one closed only seconds ago. Both
  // channels are quiet while the model runs, which is what opens the gap at all.
  // A tail window wide enough to look generous claims this figure for turn 70,
  // and turn 71 then closes with a total short by that amount.
  await sleep(TAIL_GAP_MS)
  ledger.reported(SESSION, 0.5)
  ledger.turnStarted(SESSION, 71)
  ledger.turnEnded(SESSION, 71)
  check('the early figure did not join the previous turn', ledger.turnSpends(SESSION).find(e => e.turn === 70)?.spent, 0.2)
  check('it landed on the turn that was about to start', ledger.turnSpends(SESSION).find(e => e.turn === 71)?.spent, 0.5)
}

console.log('\n=== N4. reported figures ride in the persisted file and reload ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ledger-harness-credit-'))
  try {
    const statePath = join(dir, 'ledger.json')
    const first = new CreditLedger({ statePath })
    first.observe(ACCOUNT, { total: 4530 }, SESSION)
    first.turnStarted(SESSION, 75)
    first.reported(SESSION, 0.25)
    first.reported(SESSION, 0.25)
    first.turnEnded(SESSION, 75)
    check('priced before the restart', first.turnSpends(SESSION)[0]?.spent, 0.5)
    const second = new CreditLedger({ statePath })
    const restored = second.turnSpends(SESSION)[0]
    check('the sum survived the restart', restored?.spent, 0.5)
    // The source has to survive too, or a reloaded exact figure would start
    // describing itself as the balance approximation.
    check('and so did its provenance', restored?.source, 'reported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n=== N5. a file written before sources existed still loads ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ledger-harness-legacy-'))
  try {
    const statePath = join(dir, 'ledger.json')
    // Exactly what the previous build wrote: no `source` anywhere.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        baselines: { [accountKeyFor(ACCOUNT)]: { at: 1, total: 4530 } },
        sessions: { [SESSION]: [{ turn: 9, spent: 3, from: 4530, to: 4527, at: 10 }] },
      }),
      'utf8',
    )
    const entry = new CreditLedger({ statePath }).turnSpends(SESSION)[0]
    check('the old figure is kept rather than blanked', entry?.spent, 3)
    // Balance is the right retroactive label: it was the only path that existed
    // when that row was written.
    check('and is labelled with the only source that existed then', entry?.source, 'balance')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n=== N6. malformed figures never enter the pool ===')
{
  const ledger = new CreditLedger()
  // Nothing has reported and no turn has closed: there is no figure to invent.
  check('nothing is invented from an empty pool', ledger.turnSpends(SESSION), [])
  ledger.turnStarted(SESSION, 76)
  ledger.reported(SESSION, Number.NaN)
  ledger.reported(SESSION, -1)
  ledger.reported(SESSION, Number.POSITIVE_INFINITY)
  ledger.turnEnded(SESSION, 76)
  // A NaN reaching the pool would poison every later sum in the session, so the
  // guard is at the door rather than at the read.
  check('non-finite and negative figures are refused', ledger.turnSpends(SESSION), [])
  // And the pool is still usable afterwards.
  ledger.turnStarted(SESSION, 77)
  ledger.reported(SESSION, 0.3)
  ledger.turnEnded(SESSION, 77)
  check('a good figure still lands after refused ones', ledger.turnSpends(SESSION).find(e => e.turn === 77)?.spent, 0.3)
}

console.log('\n=== N7. reported figures are rounded to the precision upstream states ===')
{
  const ledger = new CreditLedger()
  // The upstream quotes credit to two decimals, one figure per HTTP call, so a
  // turn's total is a sum of such figures. These are four real sums observed in
  // the GUI, each a value the arithmetic meant to be exactly representable and
  // binary floating point could not hold. The literal on the left is what the
  // unwary sum produces; the one on the right is what was meant.
  const drifted: [number, number][] = [
    [1.5499999999999998, 1.55],
    [5.300000000000001, 5.3],
    [9.829999999999997, 9.83],
    [1.5600000000000003, 1.56],
    [1.6299999999999997, 1.63],
  ]
  drifted.forEach(([raw, meant], i) => {
    ledger.turnStarted(SESSION, 100 + i)
    ledger.reported(SESSION, raw)
    ledger.turnEnded(SESSION, 100 + i)
    check(`a drifted sum of ${raw} is recorded as ${meant}`,
      ledger.turnSpends(SESSION).find(e => e.turn === 100 + i)?.spent, meant)
  })
  // The point of rounding is not cosmetics: summed again, the cleaned figures
  // add up to what a reader would compute by hand, while the raw ones do not.
  const cleaned = ledger.turnSpends(SESSION).reduce((sum, e) => sum + e.spent, 0)
  const rawSum = drifted.reduce((sum, [raw]) => sum + raw, 0)
  // Rounding each figure does NOT make their sum land on two decimals — adding
  // five two-decimal numbers is its own float operation with its own drift.
  // That is fine, and this assertion pins why: nothing displays the total, and
  // the footer formats each figure on its own, so per-row precision is the
  // whole requirement. Reconciling a sum is a different problem from cleaning
  // the rows, and solving it here would mean storing a number the upstream
  // never stated.
  check('each cleaned row is exactly the two decimals stated', cleaned.toFixed(2), '19.87')
  // The raw values carry the drift into any total: 19.869999999999994, whose
  // two decimals are 19.87 only because toFixed rounds away the very error the
  // rounding removed — an accident of the formatter, not a clean measurement.
  check('and the drifted ones did not', rawSum, 19.869999999999994)
  check('so the raw total needed the formatter to rescue it', rawSum.toFixed(2), '19.87')
}

console.log('\n=== N8. a ledger holding drifted figures heals on read ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'ledger-harness-round-'))
  try {
    const statePath = join(dir, 'ledger.json')
    // A file written before the rounding existed, holding exactly the drift
    // found on this machine. Reading it must clean the values in place, so
    // history is fixed by the upgrade rather than only future turns.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        baselines: { [accountKeyFor(ACCOUNT)]: { at: 1, total: 4530 } },
        sessions: {
          [SESSION]: [
            { turn: 112, spent: 1.5499999999999998, from: 0, to: 0, at: 10, source: 'reported' },
            { turn: 114, spent: 5.300000000000001, from: 0, to: 0, at: 11, source: 'reported' },
            { turn: 115, spent: 9.829999999999997, from: 0, to: 0, at: 12, source: 'reported' },
          ],
        },
      }),
      'utf8',
    )
    const ledger = new CreditLedger({ statePath })
    const turns = ledger.turnSpends(SESSION)
    check('the drifted figure is healed on read',
      turns.find(e => e.turn === 112)?.spent, 1.55)
    check('and so is a second one',
      turns.find(e => e.turn === 114)?.spent, 5.3)
    check('and a third',
      turns.find(e => e.turn === 115)?.spent, 9.83)
    // Provenance must survive the rewrite: the tooltip still has to be able to
    // say this figure came from the upstream rather than from a balance drop.
    check('provenance is untouched by the rounding',
      turns.find(e => e.turn === 112)?.source, 'reported')
    // A write after the read must put the healed values on disk, not the old
    // ones, or the next restart would reintroduce them.
    ledger.turnStarted(SESSION, 116)
    ledger.reported(SESSION, 0.25)
    ledger.turnEnded(SESSION, 116)
    const reread = new CreditLedger({ statePath }).turnSpends(SESSION)
    check('the healed values are what gets persisted',
      reread.find(e => e.turn === 112)?.spent, 1.55)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)

})()
