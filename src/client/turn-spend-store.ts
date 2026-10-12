/**
 * The browser-side home of the per-turn credit delta (#99).
 *
 * The delta has to be readable from TWO places that share no React ancestry:
 * the composer's probe control (which owns the balance today) and the entry
 * this bundle registers into the assistant message's action row, near the
 * built-in token-usage pill. A slot entry is rendered by the slot owner, not by
 * the component that registered it, so the action row cannot receive the
 * balance through props — the two surfaces have to meet somewhere else, and
 * this store is that meeting point.
 *
 * Why a store rather than a second fetch: `WorkBuddy`'s status route is not a
 * cheap local read. Every GET queries billing upstream (see the probe
 * control's mount comment), so a second reader polling the same route would
 * double the billing traffic the plugin already apologises for — and the two
 * readers would race, each overwriting the host ledger's "previous read" with
 * its own. One store, one read per trigger, both surfaces watching.
 *
 * The store is deliberately flat: it holds the newest status document for each
 * session path it has been asked about, and it never reads on its own. The
 * balance is read by the probe control — the surface that owns the ↻ and the
 * turn subscription — and pushed here; this store only distributes.
 */

import type { WorkBuddyWebStatus } from '../status-paths.ts'

/**
 * The slice of the status document the delta display needs.
 *
 * A union rather than `document | undefined`, so a reader must say what it
 * does before a read lands instead of treating "not loaded" as "no spend".
 */
export type TurnSpendView =
  | { status: 'loading' }
  | { status: 'ready'; document: WorkBuddyWebStatus }

/** One subscriber, notified when any session's document changes. */
type Listener = () => void

/**
 * Publish the newest status document per session. Read-only for consumers.
 *
 * The snapshot identity is stable between writes — `getSnapshot` returns the
 * same object until `publish` replaces it — because React's
 * `useSyncExternalStore` compares snapshots by identity and would loop forever
 * on a freshly built object per call.
 */
export class TurnSpendStore {
  /**
   * Newest document per status path.
   *
   * Keyed by the route rather than by session id: the route identifies the
   * variant as well as the account, so the Chinese and international cards can
   * never read each other's balance through this map.
   */
  private readonly documents = new Map<string, WorkBuddyWebStatus>()

  private readonly listeners = new Set<Listener>()

  /**
   * The one snapshot object callers may hold.
   *
   * Rebuilt only by `publish`, so every `getSnapshot` between writes returns
   * the identical reference and `useSyncExternalStore` settles.
   */
  private snapshot: TurnSpendView = { status: 'loading' }

  /** Record a fresh document for one status route and wake every subscriber. */
  publish(path: string, document: WorkBuddyWebStatus): void {
    this.documents.set(path, document)
    this.rebuild()
  }

  /**
   * Forget one route's document, e.g. after a read that failed.
   *
   * Hiding rather than keeping the old number is the point: the host answers
   * the same stale `turnSpend` after a failed read (it only advances when a
   * read succeeds), so a kept document would present last turn's cost as this
   * one's.
   */
  clear(path: string): void {
    if (!this.documents.delete(path)) return
    this.rebuild()
  }

  /** Subscribe to document changes; returns the unsubscriber. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current snapshot. Identity is stable between writes. */
  getSnapshot(): TurnSpendView {
    return this.snapshot
  }

  /**
   * The newest status document known for any route, or `undefined` before the
   * first read lands.
   *
   * This is what a transcript footer wants: every footer in the visible page
   * asks the same question ("what has been measured?") and picks its own turn
   * out of the answer. Reading the document rather than a pre-extracted number
   * keeps the store free of any opinion about which turn is interesting, and
   * keeps the per-turn lookup next to the component that knows its turn.
   */
  document(): WorkBuddyWebStatus | undefined {
    return this.snapshot.status === 'ready' ? this.snapshot.document : undefined
  }

  private rebuild(): void {
    // `publish` carries the newest document, so the most recent route wins when
    // several are known. That is the right tie-break here: only one variant is
    // signed in for a given model selection, and the selected variant is the
    // one whose probe control is mounted and therefore reading.
    const latest = [...this.documents.values()].at(-1)
    this.snapshot = latest === undefined
      ? { status: 'loading' }
      : { status: 'ready', document: latest }
    for (const listener of this.listeners) listener()
  }
}
