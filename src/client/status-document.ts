/** Shape check for the status document, shared by the card and the composer control. */

import type { WorkBuddyWebStatus } from '../status-paths.ts'

/**
 * Whether a parsed status response really is a status document.
 *
 * A 200 is not a promise about the body: it may be empty, literal `null`, a
 * non-JSON page from a proxy, or an array. Both halves of the browser plugin
 * read the same route, so both must agree on what is valid — storing an
 * unreadable value puts something in state that the next render dereferences.
 *
 * The check is deliberately limited to the discriminator (plus `error`'s
 * `message`, which the error paragraph renders): validating optional fields
 * here would reject documents the host legitimately omits fields from.
 */
export function isWorkBuddyWebStatus(value: unknown): value is WorkBuddyWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapped = value as Record<string, unknown>
  const status = wrapped['status']
  if (status === 'signed-out' || status === 'signed-in') return true
  return status === 'error' && typeof wrapped['message'] === 'string'
}
