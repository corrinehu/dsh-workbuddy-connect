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
 * the attribution possible at all — `turn/end` carries the turn number that
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
 * Nothing here persists. The ledger lives for one host process, which is the
 * same lifetime as the transcript it feeds, and the browser keeps its own copy
 * of the document anyway — a restart replays history without any of these
 * numbers, which is the correct outcome: the credits were already spent, and
 * inventing an attribution for an old turn would be a lie.
 */

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
 */
function accountKey(identity: {
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
 * Per-turn balance accounting behind the transcript footer.
 *
 * One instance serves the whole bundle: the CN and international routes share
 * it because accounts are kept apart by {@link accountKey} rather than by
 * separate ledgers, and either variant may be the first to see a credential.
 */
export class CreditLedger {
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
   * Record that a session left a turn.
   *
   * The figure is usually already recorded: the trailing read races this event
   * and, in practice, arrives after it — so attribution is what prices the
   * turn, not this. What this does is open the closing window that lets that
   * late read claim the turn, and disarm the claim on the next `turn/start`.
   */
  turnEnded(sessionId: string, turn: number): void {
    if (!Number.isFinite(turn)) return
    const current = this.open.get(sessionId)
    if (current !== undefined && current.turn === turn) this.open.delete(sessionId)
    this.lastClosed.set(sessionId, { turn, at: Date.now() })
    // Arm the one-shot claim, unless this turn already has a figure. A turn that
    // has been priced stays priced: re-arming would let the next read inside the
    // window replace a real number, which is the bug this gate exists to stop.
    if (!this.turns.get(sessionId)?.has(turn)) this.unclaimed.add(`${sessionId}\u0000${turn}`)
  }

  /**
   * The most recently closed turn per session, with when it closed.
   *
   * The timestamp is what lets a late trailing read be told apart from a hand
   * on the ↻; see {@link CLOSE_WINDOW_MS}.
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
    const account = accountKey(identity)
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
    return { spent, from: previous.total, to: total, at }
  }

  /**
   * The newest turns of one session that have a figure, oldest first.
   *
   * @param sessionId - the session whose transcript is asking.
   * @param limit - how many of the newest turns to return.
   */
  turnSpends(sessionId: string, limit = TURN_HISTORY_LIMIT): readonly { turn: number; spent: number; at: number }[] {
    const known = this.turns.get(sessionId)
    if (known === undefined) return []
    const entries = [...known.entries()]
    return entries
      .slice(Math.max(0, entries.length - limit))
      .map(([turn, spend]) => ({ turn, spent: spend.spent, at: spend.at }))
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
   *    round-trip; a hand on the ↻ takes seconds of human time. Two seconds
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
    let known = this.turns.get(sessionId)
    if (known === undefined) {
      known = new Map()
      this.turns.set(sessionId, known)
    }
    // Claiming it here is what makes gate 2 hold for every later read.
    this.unclaimed.delete(`${sessionId}\u0000${turn}`)
    known.delete(turn)
    known.set(turn, spend)
    while (known.size > TURN_HISTORY_LIMIT) {
      const oldest = known.keys().next()
      if (oldest.done === true) break
      known.delete(oldest.value)
      this.unclaimed.delete(`${sessionId}\u0000${oldest.value}`)
    }
    return true
  }
}
