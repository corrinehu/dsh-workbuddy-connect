/**
 * Per-turn credit accounting for the transcript footer (#99).
 *
 * WorkBuddy bills a subscription quota, so there is no per-token price to
 * multiply out (see `NO_COST` in the adapter) — the only honest answer to
 * "what did that reply cost?" is the difference between two real balance
 * reads. This module keeps exactly that difference, and it keeps it *per
 * turn*, so a finished reply can go on showing its own cost after later
 * replies have been priced.
 *
 * Why per turn rather than one rolling delta: the transcript footer renders
 * once per completed turn and keeps rendering. A single "latest delta" slot
 * would leave every earlier reply blank, because the number would have been
 * overwritten by the next turn's read. The session event stream is what makes
 * the attribution possible at all —`turn/end` carries the turn number that
 * the chat transcript also keys its footer node by (`String(event.data.turn)`
 * in `turnTailDefinition`), so the two halves agree on what "turn 7" means
 * without either one translating anything.
 *
 * Why the reads stay where they are: every status read performs a live billing
 * query, so the ledger must not poll. The browser half already re-reads the
 * route on mount, on the ↻ click, and at each turn boundary; this ledger
 * observes those reads and attributes the drop to the turn that boundary just
 * closed. The one thing it needs from the host is *which* turn just closed.
 *
 * The turn boundary and the read it triggers race, and measured on this machine
 * the read loses by about 4.6s — so attribution cannot require an open turn, or
 * nothing would ever be priced. It claims the recently closed turn instead,
 * through two gates ({@link CLOSE_WINDOW_MS} and the one-shot claim in
 * {@link CreditLedger.attribute}) that together keep a hand-pressed ↻ from
 * repricing a turn with the idle interval's zero.
 *
 * A balance that *rose* is never reported as negative spend: a top-up, a
 * package reset, or an expiry rolling over all raise the number without a
 * corresponding reply, and a negative "cost" would be nonsense. The rise is
 * recorded as a fresh baseline instead (see {@link CreditLedger.observe}).
 *
 * Nothing here persists *in memory* across a host restart, but the figures do:
 * see {@link CreditLedgerOptions.statePath}. The transcript keeps rendering after
 * a restart, so a ledger that forgot everything would blank every figure on
 * screen — the credits are already spent and the numbers were already measured,
 * so re-deriving them is impossible and dropping them is a visible regression.
 * Persisting the measured pairs is what lets history survive.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Basename of the plugin-owned ledger under `$DSH_HOME`.
 *
 * Named for the plugin rather than the account, because one file holds every
 * account and every session the host has priced.
 */
const WORKBUDDY_CREDIT_LEDGER_FILENAME = 'workbuddy-credit-ledger.json'

/** One recorded balance read. */
interface CreditObservation {
  /** Epoch milliseconds of the read. */
  at: number
  /** The credential this read belongs to, so two accounts never mix. */
  account: string
  /** The account's total remaining credit, or `undefined` when unlimited. */
  total: number | undefined
}

/**
 * The drop between the two balance reads that bracket one turn.
 *
 * `0` is a real answer — a reply that consumed nothing (a promo model, or a
 * package that had already been charged). Absence is not an answer at all:
 * a first read, a failed read, an unlimited account, or a change of account
 * all leave a turn without a figure, and the footer renders nothing rather
 * than a zero it cannot stand behind.
 */
export interface CreditSpend {
  /** Credit consumed across this turn. Non-negative. */
  spent: number
  /** The balance before that consumption. */
  from: number
  /** The balance now. */
  to: number
  /** When the later of the two reads happened. */
  at: number
  /**
   * How `spent` was arrived at.
   *
   * `'reported'` is the upstream's own per-call `usage.credit`, summed over
   * every call the turn made. It is exact to two decimals and needs no balance
   * read, so it is preferred whenever it arrives.
   *
   * `'balance'` is the drop between two billing reads. It is a whole-number
   * approximation — the balance is an integer, so three calls costing 0.11 each
   * register as a single unit — and it cannot speak for the first turn of a
   * process, nor tell a turn's own spend from anything else charged to the same
   * account meanwhile. It is the fallback for turns whose stream was cut before
   * the upstream reported anything.
   *
   * The distinction travels to the browser so the tooltip can say which figure
   * it is showing; a number whose provenance is hidden is a number that cannot
   * be checked.
   */
  source: 'reported' | 'balance'
}

/** What the ledger knows about one session's open turn. */
interface OpenTurn {
  /** The turn whose reads are currently being bracketed. */
  turn: number
  /** The account key in effect when the turn opened, so a switch is detectable. */
  account: string | undefined
}

/**
 * Identify an account without carrying its credential around.
 *
 * The nickname is what the card shows, but it is not stable enough to key on
 * (a rename would silently look like a second account and reset the ledger),
 * so the domain plus the uid-ish fields are the identity, falling back to the
 * nickname only when nothing else distinguishes the credential.
 *
 * Exported so the tests can address a stored baseline by the same key the
 * ledger writes, rather than by reimplementing the rule and drifting from it.
 */
export function accountKeyFor(identity: {
  nickname?: string
  domain?: string
  uid?: string
  enterpriseId?: string
}): string {
  const domain = identity.domain ?? ''
  const uid = identity.uid ?? identity.enterpriseId ?? ''
  if (uid !== '' || domain !== '') return `${domain}\u0000${uid}`
  return identity.nickname ?? ''
}

/**
 * How many turns of history one session keeps.
 *
 * The transcript footer only ever asks about a turn it is currently rendering,
 * and the browser holds the whole page of documents it has fetched anyway, so
 * this bound exists to stop an open tab from growing the host ledger without
 * limit. Sixty turns is several screens of transcript — far more than a footer
 * can be asked for after a reconnect, because the browser's own document cache
 * is rebuilt from the route on every read.
 */
const TURN_HISTORY_LIMIT = 60

/**
 * Decimal places kept on a `'reported'` figure.
 *
 * The upstream quotes credit to two decimals, so two places carry every digit
 * it actually states and nothing below them is a measurement.
 *
 * They are not noise-free, though: the figure is a sum of one `usage.credit`
 * per HTTP call, and a turn that made three calls adds three of them. Binary
 * floating point cannot represent 0.01 exactly, so the sum drifts into the
 * representation's own error — `1.5499999999999998` where the arithmetic meant
 * `1.55`. Rounding at the point of measurement keeps a drift that means
 * nothing out of the file, the tooltip, and any later arithmetic over either.
 *
 * Rounding is safe precisely because the digits it drops cannot come from the
 * upstream: two decimal places is its whole vocabulary, so a third digit is
 * always an artifact of how the plugin added them up, never a value it was
 * told. Applied on both sides of the file — see {@link CreditLedger.record}
 * and {@link CreditLedger.load} — so existing ledgers heal on the next read
 * rather than needing to be rewritten by hand.
 */
const SPENT_DECIMALS = 2

/**
 * Round a credit figure to the precision the upstream actually states.
 *
 * `Number(x.toFixed(n))` rather than a multiply-and-divide: `Math.round` on a
 * scaled float reintroduces exactly the representation error being removed
 * (`155.00000000000003` rounds up past the integer it should land on), while
 * `toFixed` works from the decimal expansion and is correct at these
 * magnitudes. The re-parse drops the string `toFixed` returns back to a
 * number, since the ledger stores numbers and serialises them as JSON.
 */
function roundSpent(spent: number): number {
  if (!Number.isFinite(spent)) return spent
  return Number(spent.toFixed(SPENT_DECIMALS))
}

/**
 * How long after `turn/end` a read may still be attributed to that turn.
 *
 * A turn's closing read is a billing query the browser makes when the turn
 * ends, and it can land either side of the `turn/end` event. Measured on this
 * machine it lands about 4.6s after, so the ledger has to keep claiming the
 * turn for a moment after it closes. That lag is the whole reason this constant
 * exists.
 *
 * Without a window, *every* later read claimed the last closed turn, because
 * nothing distinguished a trailing read from a user pressing ↻ minutes
 * afterwards. A manual refresh is the case that shows the damage: it happens to
 * report the drop between two idle reads — usually zero — and it overwrote the
 * turn's real figure with that zero. The transcript appeared to "reset" its
 * numbers every time the balance was refreshed by hand.
 *
 * Two seconds is deliberately tight. A trailing read costs milliseconds of
 * scheduling plus one billing round-trip; a hand on the ↻ costs seconds of
 * human time. The earlier 30s value was chosen to be "generous for a slow
 * round-trip" and was measured to let a refresh through, which is the very bug
 * it was meant to prevent. The exact value is not load-bearing, because a turn
 * can only be claimed once — see {@link CreditLedger.attribute}.
 */
const CLOSE_WINDOW_MS = 2_000

/**
 * How long after a `turn/end` a reported figure still counts as that turn's own.
 *
 * Distinct from {@link CLOSE_WINDOW_MS} and deliberately shorter. That one
 * governs whether a *balance read* may claim a closed turn, and has to outlast
 * the host's own follow-up read, which lands about half a second after the
 * close but is scheduled by the browser. This one governs whether a *reported
 * figure* is the closed turn's tail, where the same half-second applies — but
 * the competing case is the next turn's first figure, which arrives about two
 * seconds before that turn's `turn/start`, and would be stolen by a window wide
 * enough to look generous. One second clears the tail by 500ms and the next
 * turn's head by a full second.
 */
const TAIL_WINDOW_MS = 1_000

/**
 * How many sessions of history the persisted file keeps.
 *
 * The file is rewritten on every priced turn, so it has to stay small; the
 * transcript only ever renders one session at a time, and a browser that has
 * scrolled back to an old session re-reads that session's turns from here.
 * Bounded by most-recently-priced session, not by age, because an idle session
 * stays a legitimate target for a footer that is still on screen.
 */
const PERSISTED_SESSION_LIMIT = 20

/**
 * What {@link CreditLedger} writes to disk.
 *
 * Only measured facts are stored — a balance and a per-turn drop — never a
 * re-derivation, because nothing else about the past is knowable: the reads
 * that produced a figure are gone, so a stored figure is the only copy.
 */
interface LedgerSnapshot {
  /** Format marker, so a future change can refuse a file it does not understand. */
  version: 1
  /** Newest balance per account, keyed by {@link accountKey}. */
  baselines: Record<string, CreditObservation>
  /**
   * Priced turns per session, newest last.
   *
   * The bracketing balances travel with the drop. They are only ever read by
   * the footer's tooltip, so they could be dropped and the visible figure would
   * not change — but a restored turn that reported `from: <spent>, to: 0` would
   * put two numbers on screen that were never measured, and a tooltip quietly
   * stating the wrong balances is worse than one stating none.
   */
  sessions: Record<string, { turn: number; spent: number; from: number; to: number; at: number; source: 'reported' | 'balance' }[]>
}

/**
 * Accept a stored baseline only if every field is the shape this build wrote.
 *
 * The file is host-owned state, so it is trusted *by convention* but not by
 * construction — an old build, a partial write, or a hand edit can put anything
 * in it, and a `NaN` total that reached {@link measure} would produce a `NaN`
 * spend that renders as "?-NaN —" in every footer.
 */
function isObservation(value: unknown): value is { at: number; total: number | undefined } {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { at?: unknown; total?: unknown }
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return false
  if (candidate.total === undefined) return true
  return typeof candidate.total === 'number' && Number.isFinite(candidate.total)
}

/** Accept a stored figure only if it is a number the footer can render. */
function isTurnEntry(
  value: unknown,
): value is { turn: number; spent: number; from: number; to: number; at: number; source: 'reported' | 'balance' } {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as {
    turn?: unknown
    spent?: unknown
    from?: unknown
    to?: unknown
    at?: unknown
    source?: unknown
  }
  const finite = (field: unknown): boolean => typeof field === 'number' && Number.isFinite(field)
  return (
    finite(candidate.turn) &&
    finite(candidate.from) &&
    finite(candidate.to) &&
    // `spent` is the one value the footer renders without inspecting its
    // neighbours, so it gets the validity checks the others do not need.
    typeof candidate.spent === 'number' &&
    Number.isFinite(candidate.spent) &&
    candidate.spent >= 0 &&
    finite(candidate.at) &&
    // A file written before this field existed has no `source`. Rejecting those
    // turns would blank a transcript that was readable a moment ago, so the
    // unknown case falls back to the source that was the only one back then.
    (candidate.source === undefined || candidate.source === 'reported' || candidate.source === 'balance')
  )
}

/**
 * Plugin-owned ledger path inside the Harness home.
 *
 * One file for both variants, unlike the probe records: those are keyed by
 * model id and would collide across endpoints, whereas a figure is keyed by
 * account — and an account belongs to exactly one endpoint, so the CN and
 * international ledgers can share a file without ever reading each other's
 * entries. `resolveDshHome` is the same resolution the credential and probe
 * stores use, so this file lives beside them and follows `$DSH_HOME`.
 */
export function workbuddyCreditLedgerPath(): string {
  return join(resolveDshHome(), WORKBUDDY_CREDIT_LEDGER_FILENAME)
}

/**
 * Per-turn balance accounting behind the transcript footer.
 *
 * One instance serves the whole bundle: the CN and international routes share
 * it because accounts are kept apart by {@link accountKey} rather than by
 * separate ledgers, and either variant may be the first to see a credential.
 */
export class CreditLedger {
  /**
   * Where the measured figures are kept between host processes.
   *
   * `undefined` disables persistence entirely, which is what the tests use.
   */
  private readonly statePath: string | undefined
  /**
   * The newest balance seen per account — the only thing a later read needs.
   *
   * Keyed by account rather than kept as a shared ring, because the reads are
   * not one stream: every browser tab, probe instance, and CN/international
   * route reads independently, so a fixed-length ring lets unrelated reads
   * evict the one baseline a turn was waiting to compare against. That looked
   * like "the figure appears sometimes" — it appeared whenever the reads
   * happened to be sparse. One slot per account cannot be evicted.
   */
  private readonly baselines = new Map<string, CreditObservation>()

  /** The turn currently open per session, set by `turn/start` and cleared by `turn/end`. */
  private readonly open = new Map<string, OpenTurn>()

  /**
   * Attributed spend per session, keyed by turn number.
   *
   * Insertion order is turn order, which is what {@link turnSpends} relies on
   * to answer "the newest N turns" without sorting.
   */
  private readonly turns = new Map<string, Map<number, CreditSpend>>()

  /** The account key last seen per session, so an account change can void the pairing. */
  private readonly sessionAccount = new Map<string, string>()

  /**
   * @param options.statePath - file to load prior figures from and save them to.
   *   Omitted by the tests, which drive the ledger directly.
   */
  constructor(options: { statePath?: string | undefined } = {}) {
    this.statePath = options.statePath
    if (this.statePath !== undefined) this.load()
  }

  /**
   * Read back the figures measured by earlier host processes.
   *
   * Every failure is swallowed on purpose. This file is a cache of numbers the
   * UI shows as decoration: a corrupt, truncated, or hand-edited file must
   * leave the ledger empty rather than take the host down, and an unreadable
   * one costs exactly what forgetting costs — the figures reappear as new
   * turns are priced. `version` is the one thing that is *not* tolerated: a
   * file written by a future format is left alone instead of being
   * half-understood, because `save` would otherwise overwrite it in the old
   * shape and lose whatever that version knew.
   */
  private load(): void {
    const path = this.statePath
    if (path === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // Missing on first run, which is the common case; unreadable or invalid
      // JSON is treated the same way.
      return
    }
    const snapshot = parsed as Partial<LedgerSnapshot> | null
    if (snapshot === null || typeof snapshot !== 'object') return
    // A newer writer owns this file; do not downgrade it.
    if (snapshot.version !== 1) return

    for (const [account, observation] of Object.entries(snapshot.baselines ?? {})) {
      if (!isObservation(observation)) continue
      this.baselines.set(account, {
        at: observation.at,
        account,
        total: observation.total,
      })
    }

    for (const [sessionId, entries] of Object.entries(snapshot.sessions ?? {})) {
      if (!Array.isArray(entries)) continue
      const turns = new Map<number, CreditSpend>()
      for (const entry of entries) {
        if (!isTurnEntry(entry)) continue
        turns.set(entry.turn, {
          // Re-rounded on the way in as well as on the way out: a ledger
          // written before this existed still holds drifted figures, and
          // healing them at read time means the fix reaches history rather
          // than only the turns recorded after the upgrade.
          spent: roundSpent(entry.spent),
          from: entry.from,
          to: entry.to,
          at: entry.at,
          source: entry.source ?? 'balance',
        })
      }
      if (turns.size > 0) this.turns.set(sessionId, turns)
    }
    this.trimSessions()
  }

  /**
   * Write the measured figures out, so a restart does not blank the transcript.
   *
   * Called after anything that changes a persisted figure. Deliberately not
   * debounced or batched: the writes are one small file, they happen at most a
   * few times per turn, and a buffered write that a crash discards would lose
   * exactly the number this exists to keep. Failures are swallowed for the same
   * reason as in {@link load} — persistence is a nicety, not a dependency.
   */
  private save(): void {
    const path = this.statePath
    if (path === undefined) return
    const baselines: LedgerSnapshot['baselines'] = {}
    for (const [account, observation] of this.baselines) {
      baselines[account] = {
        at: observation.at,
        account: observation.account,
        total: observation.total,
      }
    }
    const sessions: LedgerSnapshot['sessions'] = {}
    for (const [sessionId, turns] of this.turns) {
      sessions[sessionId] = [...turns].map(([turn, spend]) => ({
        turn,
        spent: spend.spent,
        from: spend.from,
        to: spend.to,
        at: spend.at,
        source: spend.source,
      }))
    }
    const snapshot: LedgerSnapshot = { version: 1, baselines, sessions }
    try {
      mkdirSync(dirname(path), { recursive: true })
      // Write-then-rename: a crash mid-write leaves the previous good file
      // rather than a truncated one, and the rename is atomic on one volume.
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify(snapshot), 'utf8')
      renameSync(temporary, path)
    } catch {
      // A read-only or missing state directory must not break accounting.
    }
  }

  /**
   * Drop the least recently priced sessions once the file would grow unbounded.
   *
   * Ordered by each session's newest figure, not by insertion: a long-idle
   * session whose footer is still on screen is a better thing to keep than a
   * session that has been priced twice and then abandoned.
   */
  private trimSessions(): void {
    if (this.turns.size <= PERSISTED_SESSION_LIMIT) return
    const newest = (sessionId: string): number => {
      let latest = 0
      for (const spend of this.turns.get(sessionId)?.values() ?? []) {
        if (spend.at > latest) latest = spend.at
      }
      return latest
    }
    const oldest = [...this.turns.keys()].sort((a, b) => newest(a) - newest(b))
    const excess = this.turns.size - PERSISTED_SESSION_LIMIT
    for (const sessionId of oldest.slice(0, excess)) {
      this.turns.delete(sessionId)
    }
  }

  /**
   * Record that a session entered a turn.
   *
   * Called from the host's `session/event` listener. A `turn/start` that
   * arrives while another turn is already open replaces it: DSH does not
   * interleave turns within one session, and treating the newer one as
   * authoritative is what keeps a missed `turn/end` (a cancelled turn, a
   * dropped connection) from stranding every later read on a stale turn.
   */
  turnStarted(sessionId: string, turn: number): void {
    if (!Number.isFinite(turn)) return
    this.open.set(sessionId, { turn, account: this.sessionAccount.get(sessionId) })
  }

  /**
   * Record that a session left a turn, pricing it from whatever was reported.
   *
   * This is where a turn's figure is decided. The upstream's per-call credits
   * have been accumulating in {@link reportedSpend} since the last drain, and
   * the whole pool is handed to this turn: measured live, a turn's figures
   * arrive from 2 seconds before its `turn/start` to after its `turn/end`, so
   * only draining at the close can collect them all. A turn that reported
   * nothing leaves the pool empty and falls through to the balance path, which
   * {@link attribute} applies through the closing window this opens.
   *
   * Nothing is left in the pool afterwards, so the next turn starts clean and a
   * figure cannot be counted twice.
   */
  turnEnded(sessionId: string, turn: number): void {
    if (!Number.isFinite(turn)) return
    const current = this.open.get(sessionId)
    if (current !== undefined && current.turn === turn) this.open.delete(sessionId)
    this.lastClosed.set(sessionId, { turn, at: Date.now() })
    // A turn the upstream reported figures for is priced from those, exactly,
    // and the balance path must not overwrite them: its whole-unit figure would
    // round 0.40 down to 0. Recording it here also leaves the turn unclaimable,
    // so no later read can substitute a coarser number for a precise one.
    const pending = this.reportedSpend.get(sessionId)
    if (pending !== undefined) {
      this.reportedSpend.delete(sessionId)
      this.record(sessionId, turn, { spent: pending, from: 0, to: 0, at: Date.now(), source: 'reported' })
      return
    }
    // Arm the one-shot claim, unless this turn already has a figure. A turn that
    // has been priced stays priced: re-arming would let the next read inside the
    // window replace a real number, which is the bug this gate exists to stop.
    if (!this.turns.get(sessionId)?.has(turn)) this.unclaimed.add(`${sessionId}\u0000${turn}`)
  }

  /**
   * The most recently closed turn per session, with when it closed.
   *
   * The timestamp is what lets a late trailing read be told apart from a hand
   * on the — see {@link CLOSE_WINDOW_MS}.
   */
  private readonly lastClosed = new Map<string, { turn: number; at: number }>()

  /**
   * Closed turns that have not been priced yet, keyed `session\u0000turn`.
   *
   * This is the second gate in {@link attribute}: a turn is claimable exactly
   * once, so no read — however soon after the turn it arrives — can replace a
   * figure that is already on screen. It is a set of keys rather than a flag on
   * `lastClosed` because a very slow read can land after the *next* turn has
   * already closed, and that read must still not touch the older turn.
   *
   * Bounded by the same pruning as the transcript history: keys for turns that
   * have been evicted from {@link turns} are dropped with them, so one session
   * cannot grow this without limit.
   */
  private readonly unclaimed = new Set<string>()

  /**
   * Record one balance read and attribute the drop it reveals to the session's
   * current turn.
   *
   * @param identity - fields identifying the account the balance belongs to.
   * @param credits - the fresh answer, or `undefined` when the read failed or
   *   the account is unlimited — neither yields a comparable number.
   * @param sessionId - the session this read was made for, when the caller
   *   knows it. Without one the read still advances the baseline (so the next
   *   read has something to compare against) but attributes no figure, because
   *   there is no turn to hang it on.
   */
  observe(
    identity: { nickname?: string; domain?: string; uid?: string; enterpriseId?: string },
    credits: { total: number; unlimited?: true } | undefined,
    sessionId?: string,
  ): CreditSpend | undefined {
    if (credits === undefined || credits.unlimited === true || !Number.isFinite(credits.total)) {
      return undefined
    }
    const account = accountKeyFor(identity)
    const at = Date.now()
    const previous = this.baselines.get(account)
    // The baseline is replaced *before* the drop is measured, so a rejected
    // read — a rise, or the first read of a process — still leaves the newest
    // balance on record. That is what makes the next read comparable, and it is
    // why a restart costs exactly one reading rather than two.
    this.baselines.set(account, { at, account, total: credits.total })
    if (sessionId !== undefined) {
      const known = this.sessionAccount.get(sessionId)
      // An account switch invalidates every pairing this session held: the drop
      // from one account's balance to another's is not consumption.
      if (known !== undefined && known !== account) {
        this.open.delete(sessionId)
        this.turns.delete(sessionId)
        this.lastClosed.delete(sessionId)
        // Keys are `session\u0000turn`, and `\u0000` is not a turn character, so
        // this prefix cannot match another session's keys.
        const prefix = `${sessionId}\u0000`
        for (const key of this.unclaimed) {
          if (key.startsWith(prefix)) this.unclaimed.delete(key)
        }
      }
      this.sessionAccount.set(sessionId, account)
    }
    const spend = this.measure(previous, credits.total, at)
    // Persisted even when the read prices no turn: the advanced baseline above
    // is what makes the *next* read comparable, so losing it on restart would
    // cost a reading twice over. Saving here also means the file is written by
    // the reads that actually carry new balance information, rather than by
    // every turn boundary whether or not anything was measured.
    this.save()
    if (spend === undefined) return undefined
    // A read that no turn can claim still advanced the baseline above, but it
    // reports nothing: an unattributable drop is not a turn's cost, and handing
    // it back would put the idle interval's zero under the composer badge.
    if (sessionId !== undefined) return this.attribute(sessionId, spend) ? spend : undefined
    return spend
  }

  /**
   * Price one read against an earlier observation.
   *
   * Split out from {@link observe} so the arithmetic holds no state: the
   * baseline arrives from the account history, not from a field, which is what
   * lets the caller decide when a read is comparable at all.
   *
   * @returns the drop, or `undefined` when there is no baseline to compare
   *   against, or the balance rose — a top-up, reset, or expiry rollover is not
   *   negative consumption, and reporting it as one would corrupt every figure
   *   that followed.
   */
  private measure(previous: CreditObservation | undefined, total: number, at: number): CreditSpend | undefined {
    if (previous === undefined || previous.total === undefined) return undefined
    const spent = previous.total - total
    if (spent < 0) return undefined
    return { spent, from: previous.total, to: total, at, source: 'balance' }
  }

  /**
   * Add one upstream-reported `usage.credit` to the session's pending pool.
   *
   * Called from the shim for every completed upstream call, with the session
   * the call belonged to read off the request's `x-session-id`. The upstream
   * reports a figure per **HTTP call**, not per turn — one turn that calls a
   * tool three times reports three figures — so this accumulates, and the turn
   * is priced only when it ends.
   *
   * Deliberately not keyed on the open turn. The figures and the turn events
   * travel by different paths — one through the shim's own HTTP endpoint, the
   * other through the session event stream — and they race in both directions:
   * measured live, a turn's first call completed 2 seconds *before* its
   * `turn/start` arrived, and one turn's last figure landed after `turn/end`.
   * Keying on the open turn dropped the first figure of every turn and, when a
   * stale turn was still open, added a figure to the wrong turn (observed as a
   * total of 1.5499999999999998 spanning two turns).
   *
   * A single pool per session, drained on close. No attempt is made to decide
   * here which turn a figure belongs to, because nothing available at this
   * moment can decide it: the figures and the turn events travel by different
   * paths — one through the shim's own HTTP endpoint, the other through the
   * session event stream — and they race in **both** directions. Measured live,
   * a turn's first call completed 2 seconds before its `turn/start` arrived, and
   * its last figure landed half a second after its `turn/end`.
   *
   * Two earlier attempts keyed the figure on turn state and both misattributed:
   * keying on the open turn dropped the first figure of every turn and, when a
   * stale turn was still open, added figures to the wrong one (a turn total of
   * 1.5499999999999998 spanning two turns); then, having the `reported` path
   * reach back to the most recently closed turn inside the closing window, the
   * *early* figure of the next turn was claimed by the previous one instead of
   * waiting for its own. Every figure arriving while no turn is open has the
   * same shape whether it is early for the next turn or late for the last, so
   * any test that separates them is a guess.
   *
   * The pool needs no such test: it collects, and {@link turnEnded} hands
   * everything to the turn that just closed. A figure that arrives before its
   * turn starts is waiting when the turn closes; one that arrives after is
   * attributed to the turn it belongs to by the close that follows it, which is
   * exact in every ordering the two channels can produce, and errs at most by
   * one turn's worth of timing when a turn produces a figure after the *next*
   * turn has already started.
   *
   * @param sessionId - the session the call belonged to.
   * @param credit - the call's `usage.credit`. Ignored unless it is a finite,
   *   non-negative number: a malformed frame must not poison a turn's total,
   *   and a negative figure is not a cost.
   */
  reported(sessionId: string, credit: number): void {
    if (!Number.isFinite(credit) || credit < 0) return
    // A figure arriving hard on the heels of a `turn/end` is that turn's last
    // call reporting late: measured live, the tail frame lands about half a
    // second after the close. A figure arriving later than that is the *next*
    // turn's first call reporting early — measured live, two seconds before its
    // `turn/start`. The two extremes are half a second and two seconds, so a
    // one-second bound separates them with margin on both sides, and the frame
    // is handed back to the turn it so clearly belongs to instead of sitting in
    // the pool to be drained by the following turn.
    const closed = this.lastClosed.get(sessionId)
    if (this.open.get(sessionId) === undefined
      && closed !== undefined
      && Date.now() - closed.at <= TAIL_WINDOW_MS) {
      const spend = this.turns.get(sessionId)?.get(closed.turn)
      // Added to a turn the pool already priced from figures, so a late frame
      // completes its own turn rather than inflating the next. A turn priced
      // from the balance, by contrast, is left alone: its figure is a whole
      // number read from an integer balance, and mixing the two scales in one
      // number would be worse than either.
      const base = spend !== undefined && spend.source === 'reported' ? spend.spent : 0
      if (base === 0 && spend !== undefined) return
      this.record(sessionId, closed.turn, {
        spent: base + credit,
        from: 0,
        to: 0,
        at: Date.now(),
        source: 'reported',
      })
      return
    }
    const pending = this.reportedSpend.get(sessionId) ?? 0
    this.reportedSpend.set(sessionId, pending + credit)
  }

  /**
   * Figures seen since the last {@link turnEnded} for one session.
   *
   * Not the open turn, and not per turn: a number, because attribution happens
   * when a turn closes rather than when a figure arrives.
   */
  private readonly reportedSpend = new Map<string, number>()

  /**
   * The newest turns of one session that have a figure, oldest first.
   *
   * @param sessionId - the session whose transcript is asking.
   * @param limit - how many of the newest turns to return.
   */
  turnSpends(
    sessionId: string,
    limit = TURN_HISTORY_LIMIT,
  ): readonly { turn: number; spent: number; at: number; source: 'reported' | 'balance' }[] {
    const known = this.turns.get(sessionId)
    if (known === undefined) return []
    const entries = [...known.entries()]
    return entries
      .slice(Math.max(0, entries.length - limit))
      .map(([turn, spend]) => ({ turn, spent: spend.spent, at: spend.at, source: spend.source }))
  }

  /**
   * Hang one measured drop on the session's turn.
   *
   * The turn is the open one when a turn is running, otherwise the one that just
   * closed — because the trailing read and `turn/end` race, and the read loses.
   * Measured on this machine the read lands about 4.6s after the event, so a
   * closed turn must stay claimable; requiring an open turn would price nothing
   * at all.
   *
   * Two gates keep that from becoming the bug it once was, where a manual
   * refresh repriced the last turn with the idle interval's zero:
   *
   * 1. The close must be recent ({@link CLOSE_WINDOW_MS}). A trailing read
   *    follows the event by milliseconds of scheduling plus one billing
   *    round-trip; a hand on the — takes seconds of human time. Two seconds
   *    separates them without cutting off a slow round-trip.
   * 2. A turn may be claimed exactly once. The claim is deleted from
   *    `unclaimed` the moment it is priced, so even a read that slips inside
   *    the window cannot overwrite a figure that is already there. This is the
   *    gate that makes the window's exact value non-critical: too wide and a
   *    refresh is merely ignored, never destructive.
   *
   * Such a read still advances the baseline, so the next turn compares against
   * it rather than against a stale balance from before the refresh.
   *
   * @returns whether the figure was actually recorded. The caller reports the
   *   drop only when it was, so the composer badge cannot display a cost that
   *   the transcript refused to attribute to any turn — a read that priced
   *   nothing would otherwise still show an idle interval's zero as if it
   *   belonged to the turn that just ended.
   */
  private attribute(sessionId: string, spend: CreditSpend): boolean {
    const opened = this.open.get(sessionId)?.turn
    let turn = opened
    if (turn === undefined) {
      const closed = this.lastClosed.get(sessionId)
      if (closed === undefined || spend.at - closed.at > CLOSE_WINDOW_MS) return false
      // Gate 2: the closed turn is only claimable until its first figure lands.
      if (!this.unclaimed.has(`${sessionId}\u0000${closed.turn}`)) return false
      turn = closed.turn
    }
    this.record(sessionId, turn, spend)
    return true
  }

  /**
   * Store one turn's figure, keeping the per-session map ordered and bounded.
   *
   * Shared by both pricing paths so a turn's history behaves identically
   * whichever source priced it: the maps a reader sees, the eviction that
   * bounds them, and the persistence that carries them across a restart are the
   * same operations either way.
   *
   * Re-inserting on write is what keeps iteration order equal to turn order —
   * a `Map` preserves insertion order, not key order, so a turn priced out of
   * sequence would otherwise sit at the end and be evicted as if it were the
   * newest.
   */
  private record(sessionId: string, turn: number, spend: CreditSpend): void {
    let known = this.turns.get(sessionId)
    if (known === undefined) {
      known = new Map()
      this.turns.set(sessionId, known)
    }
    // The one write path, so rounding here covers every producer of a figure —
    // the reported pool, a late tail frame, and the balance path alike —
    // without each having to remember to do it.
    const rounded: CreditSpend = { ...spend, spent: roundSpent(spend.spent) }
    // Claiming it here is what makes gate 2 hold for every later read.
    this.unclaimed.delete(`${sessionId}\u0000${turn}`)
    known.delete(turn)
    known.set(turn, rounded)
    while (known.size > TURN_HISTORY_LIMIT) {
      const oldest = known.keys().next()
      if (oldest.done === true) break
      known.delete(oldest.value)
      this.unclaimed.delete(`${sessionId}\u0000${oldest.value}`)
    }
    this.trimSessions()
    this.save()
  }
}
