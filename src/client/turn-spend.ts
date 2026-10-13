/**
 * The one place that decides whether a status document reports a per-turn
 * spend, and how it reads (#99).
 *
 * Shared on purpose. Two surfaces render this number — the composer's credit
 * badge and the entry on the assistant message's action row — and if each
 * carried its own copy of the guards, a fix or a tightening applied to one
 * would silently leave the other showing a figure the first had rejected. The
 * rules are subtle enough (absence versus zero, the negative guard, the
 * `creditsError` interaction) that a single implementation is the only way the
 * two can be trusted to agree.
 */

import type { WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'

/**
 * The formatted `−N` for one status document, or `undefined` for nothing.
 *
 * Absent versus zero is load-bearing. `turnSpend` missing means the host had no
 * comparable pair — a first read, a failed read, an unlimited account, or an
 * account change — and the delta is hidden rather than shown as `−0`. A
 * present `spent: 0` is a real answer (a promo model, or a reply already
 * charged) and renders, because hiding it would make an identical-looking
 * absence mean two different things.
 *
 * A document naming a credit error has no trustworthy balance, so it has no
 * trustworthy delta either — even in the malformed case where it also carries
 * a `credits` section. The delta is derived from balances, so it is only as
 * good as the read behind them.
 *
 * A negative `spent` cannot come from the host (a rise is recorded as a fresh
 * baseline instead), but the guard stays: an arithmetic slip upstream must
 * render nothing rather than a credit refund the user never received.
 */
export function turnSpendAmount(
  status: WorkBuddyWebStatus | undefined,
  t: WorkBuddyPluginCardInjected['t'],
): string | undefined {
  if (status === undefined || status.status !== 'signed-in') return undefined
  if (status.creditsError !== undefined) return undefined
  const spend = status.turnSpend
  if (spend === undefined) return undefined
  if (typeof spend.spent !== 'number' || !Number.isFinite(spend.spent) || spend.spent < 0) return undefined
  return t('composerTurnSpend', {
    amount: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(spend.spent),
  })
}
