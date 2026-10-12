/**
 * The transcript footer's per-turn credit figure (#99).
 *
 * Where the figure lives, and why here. The composer's badge shows one rolling
 * delta for whatever the last balance read bracketed; it cannot show what any
 * *particular* reply cost, because it is one number that the next turn
 * overwrites. A reply's own cost only has somewhere to live if it is keyed by
 * the reply, and `conversation.chat.turnTail` is the only mount point that both
 * (a) renders once per completed turn, inside that turn's own subtree, and
 * (b) hands over the turn number — `TurnTailOwnerProps.turn` is exactly the
 * number the host ledger files its figures under. That pairing is what lets the
 * two halves agree on "turn 7" without either one translating anything, and it
 * is why this file needs no turn-lookup heuristics, no messageId→turn search,
 * and no "is this the newest reply" test.
 *
 * Where the figure comes from. The probe control owns the balance read — it
 * has the ↻ button and the turn subscription — and publishes each document it
 * receives into {@link TurnSpendStore}. This component only reads. It never
 * fetches, so mounting one instance per completed turn costs no billing traffic
 * no matter how long the transcript is; a hundred footers share the one document
 * that the last read produced.
 *
 * What it renders, and what it refuses to. A turn with a figure renders it. A
 * turn without one renders nothing — not a zero. The host omits a turn from the
 * list when it has no comparable pair of reads (the turn was never bracketed, an
 * account switched, a top-up reset the baseline, the read failed), and painting
 * a `−0` there would claim a reply was free when the truth is that nobody
 * measured it. A genuine zero *is* rendered, because a reply that consumed
 * nothing is a real answer worth showing, and the host distinguishes the two
 * cases for exactly this reason.
 */

import type { WorkBuddyWebStatus } from '../status-paths.ts'
import type { TurnSpendStore } from './turn-spend-store.ts'

/** Owner currency the slot hands this entry: the turn whose footer this is. */
export interface TurnTailOwnerProps {
  /**
   * The completed turn. Despite the name in the owner's declaration this is
   * NOT a number: the owner passes the whole projected turn record — observed
   * live as `{ turn: 31, start, end, steps, status, data }` — so the figure
   * this entry needs is `turn.turn`. That inner number is the same one the
   * host's `turn/start` and `turn/end` carry, which is what lines the two
   * halves up without either translating anything.
   *
   * The union admits a bare number too: the owner's own type says
   * `TurnLocation`, which is not exported in a form a plugin can name, and
   * pinning this to the record shape alone would break silently if a host
   * version ever passed the number directly. Reading both costs one branch.
   */
  turn: { turn: number } | number
}

/** What this bundle's slot entry injects alongside the owner's props. */
export interface TurnSpendTailInjected {
  /** The shared store the probe control publishes balance documents into. */
  turnSpend: TurnSpendStore
  /** Localizes the figure, e.g. `−0.42`. */
  t: (key: string, options?: Record<string, unknown>) => string
}

/**
 * The figure for one turn, or `undefined` when there is nothing honest to show.
 *
 * Split out from the component so the two surfaces that show a credit number —
 * this footer and the composer's badge — share one definition of when a number
 * exists. They read different fields (this one looks up a turn, the badge reads
 * the rolling delta) but they must agree on the refusals: a signed-out account,
 * a failed read, an unlimited account, and a missing or impossible figure all
 * mean "render nothing" in both places. Two independent copies of that reasoning
 * would drift, and the drift would look like a bug in whichever one moved.
 */
export function turnSpendAmountFor(
  document: WorkBuddyWebStatus | undefined,
  turn: number,
  t: TurnSpendTailInjected['t'],
): string | undefined {
  if (document === undefined || document.status !== 'signed-in') return undefined
  // A failed balance read means the document's other figures are also stale;
  // the host re-sends the last good `turns` list on such a read, and showing it
  // beside a *newer* reply would misattribute an older turn's cost.
  if (document.creditsError !== undefined) return undefined
  const entry = document.turns?.find(candidate => candidate.turn === turn)
  if (entry === undefined) return undefined
  if (!Number.isFinite(entry.spent) || entry.spent < 0) return undefined
  return t('composerTurnSpend', {
    amount: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(entry.spent),
  })
}

/**
 * Style for the figure itself — identical wherever it ends up.
 *
 * Smaller and dimmer than the reply it annotates: it is a footnote to the turn,
 * not part of the answer. Tabular figures keep the width steady as the number
 * changes, so a transcript of figures does not jitter on each read.
 *
 * Size and colour both come from the same custom properties the clock beside it
 * uses, read out of the host's own `.xD_KDq_timeEnd` rule:
 *
 *   font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)
 *   color: inherit  (the group sets --dsw-alias-label-tertiary)
 *
 * Pinning a literal size here instead is what made the figure sit a size off
 * from the clock. `inherit` also picks up the 13px/1px fallbacks the host
 * defines, so an unpatched or older host still lines up.
 */
const figureStyle = {
  fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
} as const

/**
 * Style for the figure's own row.
 *
 * Right-aligned so the figure reads as belonging to the action row beneath the
 * reply rather than to the reply's own text. The row is `MessageIconActions`,
 * whose right-hand group — token panel plus clock — is a component-internal
 * span that exposes no slot, so a plugin contribution cannot land inside it and
 * sits on the line above instead.
 */
const spendStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  ...figureStyle,
} as const

/**
 * The number inside whatever the owner passed as the turn.
 *
 * Exists because the owner's declaration (`TurnLocation`) is not a number even
 * though its name suggests one, and because a plugin cannot import the real
 * type to say so. Accepting both shapes keeps the entry working across a host
 * that switches, and returning `undefined` for anything else is what turns a
 * future currency change into a missing figure instead of a wrong one.
 */
export function turnNumberOf(turn: { turn: number } | number): number | undefined {
  const value = typeof turn === 'number' ? turn : turn?.turn
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * One completed turn's credit figure, or nothing.
 *
 * Rendered into the slot's own node. Mounting one instance per completed turn
 * costs no billing traffic: every instance reads the shared store, and the store
 * holds the one document the last balance read produced.
 */
export function TurnSpendTail(props: TurnTailOwnerProps & {
  useTurnSpend: () => WorkBuddyWebStatus | undefined
  t: TurnSpendTailInjected['t']
}) {
  const { turn, useTurnSpend, t } = props
  const document = useTurnSpend()

  // The owner hands over a turn record, not a number; the number inside it is
  // the ledger's own key. Rejecting anything else means a host that changes the
  // currency again degrades to "no figure" rather than to a wrong figure.
  const turnNumber = turnNumberOf(turn)
  const amount = turnNumber === undefined ? undefined : turnSpendAmountFor(document, turnNumber, t)

  if (amount === undefined) return null
  return (
    <div style={spendStyle}>
      <span style={figureStyle} title={t('composerTurnSpendTooltip')}>{amount}</span>
    </div>
  )
}