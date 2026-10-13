/**
 * The footer's view of the shared balance store (#99).
 *
 * Split into its own module because of *when* it may run. `apply()` executes on
 * the plugin's setup path — outside any React render — so it cannot call a hook
 * itself; it may only hand the store to something that will. This factory is
 * that hand-off: it builds the hook and touches no React API at setup time, and
 * the hook it returns is called by the footer component during its own render,
 * which is the one place `useSyncExternalStore` is legal.
 *
 * Keeping it separate from `TurnSpendTail.tsx` also keeps the storage question
 * ("what has been measured, and is anyone listening for changes?") apart from
 * the presentation question ("which turn is this, and what should it say?").
 * The factory is reusable for any other surface that needs to observe the same
 * documents — the composer badge reads its own state directly, but a future
 * seat would want exactly this subscription.
 */

import { useSyncExternalStore } from 'react'
import type { WorkBuddyWebStatus } from '../status-paths.ts'
import type { TurnSpendStore } from './turn-spend-store.ts'

/** A hook returning the newest published status document, or `undefined`. */
export type TurnSpendHook = () => WorkBuddyWebStatus | undefined

/**
 * Bind one store into a hook that re-reads it when the store publishes.
 *
 * The three arguments to `useSyncExternalStore` are all derived from the store
 * itself rather than closed over per-call state, so the returned function keeps
 * a stable identity across renders — React re-subscribes whenever `subscribe`
 * changes, and a fresh closure per render would drop and re-add the listener on
 * every paint.
 *
 * The server snapshot is the same getter as the client one. That is deliberate:
 * this bundle renders only in the browser, and a store snapshot is a plain value
 * with no I/O behind it, so hydrating with a different answer would be a lie
 * with no benefit.
 *
 * @param store - the shared store the probe control publishes into.
 */
export function createTurnSpendHook(store: TurnSpendStore): TurnSpendHook {
  const subscribe = (listener: () => void): (() => void) => store.subscribe(listener)
  const getSnapshot = (): WorkBuddyWebStatus | undefined => store.document()
  return () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
