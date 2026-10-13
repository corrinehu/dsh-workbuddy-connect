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

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { WorkBuddyWebStatus, WorkBuddyWebTurnSpendSource } from '../status-paths.ts'
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
): { amount: string; source: WorkBuddyWebTurnSpendSource } | undefined {
  if (document === undefined || document.status !== 'signed-in') return undefined
  // A failed balance read means the document's other figures are also stale;
  // the host re-sends the last good `turns` list on such a read, and showing it
  // beside a *newer* reply would misattribute an older turn's cost.
  if (document.creditsError !== undefined) return undefined
  const entry = document.turns?.find(candidate => candidate.turn === turn)
  if (entry === undefined) return undefined
  if (!Number.isFinite(entry.spent) || entry.spent < 0) return undefined
  // The source travels with the figure rather than being looked up separately,
  // so a caller cannot end up labelling the number from one turn with the
  // provenance of another, or with none at all after a guard rejects the entry.
  return {
    amount: t('composerTurnSpend', {
      amount: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(entry.spent),
    }),
    source: entry.source,
  }
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
 * Style for this entry's own place, used only when the host has no seat.
 *
 * The row is `MessageIconActions`, and its right-hand group — token panel plus
 * clock — is a component-internal span with no slot. Against a patched host the
 * figure is portalled into a placeholder spliced into that span by
 * `patch_asar.ps1`; against an unpatched one it stays here, right-aligned so it
 * still reads as belonging to the row below it rather than to the reply above.
 */
const spendStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  ...figureStyle,
} as const

/** Keeps the anchor in the tree once the figure has moved elsewhere. */
const hiddenStyle = {
  display: 'none',
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
 * One completed turn's credit figure.
 *
 * Renders beside the token panel and timestamp when the host offers a seat
 * there, and in this entry's own place otherwise. The host ships no slot inside
 * that row — its right-hand group is a component-internal span holding the token
 * panel and the clock — so the seat is a placeholder element spliced into the
 * bundle by `patch_asar.py` and marked with this attribute:
 */
const SEAT_ATTRIBUTE = 'data-workbuddy-turn-spend'

/**
 * One completed turn's credit figure, or nothing.
 *
 * A portal rather than a re-parent: React owns the element, and the placeholder
 * is ordinary DOM the patched host renders empty. The seat is located through
 * the row this entry belongs to — never by attribute alone, because a transcript
 * renders many completed turns at once and every one of them has a seat.
 *
 * Without the patch the lookup finds nothing and the figure stays in this
 * entry's own place, so the plugin keeps working against an unpatched host.
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
  const figure = turnNumber === undefined ? undefined : turnSpendAmountFor(document, turnNumber, t)

  const anchor = useRef<HTMLDivElement | null>(null)
  const [seat, setSeat] = useState<Element | null>(null)
  useEffect(() => {
    const findSeat = (): Element | null => {
      // The turn number is on the wrapping row (`data-turn-tail`), which the host
      // renders around both this entry and the action row.
      const own = anchor.current?.closest('[data-turn-tail]')
      return own?.querySelector(`[${SEAT_ATTRIBUTE}]`) ?? null
    }
    // Re-resolve on every render rather than only when the figure changes: the
    // host re-renders the action row it owns (the clock ticks, the token panel
    // repaints), and React may replace the row's children wholesale. A portal
    // into a node that has been swapped out renders nothing, and gating the
    // lookup on `amount` would leave the figure missing until the cost changed —
    // for a finished turn, never.
    if (anchor.current === null) return
    const found = findSeat()
    setSeat(previous => (previous === found ? previous : found))
  })

  if (figure === undefined) return null
  // The tooltip names how the number was arrived at, because the two sources
  // differ in what they can claim. A reported figure is the upstream's own
  // arithmetic for this turn; a balance figure is a whole-unit drop that cannot
  // tell this turn's spending from a charge made elsewhere on the account. They
  // look identical on screen, so saying which one is showing is the only thing
  // that keeps a rough number from being read as an exact one.
  const tooltip =
    figure.source === 'reported' ? t('composerTurnSpendTooltipReported') : t('composerTurnSpendTooltip')
  const rendered = <span style={figureStyle} title={tooltip}>{figure.amount}</span>
  // `anchor` stays in the tree even when the figure moves, so a later render can
  // still find the row it belongs to.
  return (
    <div ref={anchor} style={seat === null ? spendStyle : hiddenStyle}>
      {seat === null ? rendered : createPortal(rendered, seat)}
    </div>
  )
}