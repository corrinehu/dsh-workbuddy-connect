/**
 * Pool-aware credential resolution: the seam that lets the provider use a pool
 * without changing how it asks for a credential.
 *
 * The plugin's provider, shim, and status card all read credentials through one
 * small surface — `current()`, `resolve()`, `status()`, `logout()`, plus the
 * desktop-file diagnostics `doctor` prints. This class implements that same
 * surface and is constructed *around* the existing single-account store, which
 * stays the fallback. That shape is deliberate:
 *
 * - **An empty pool is the old behaviour, exactly.** Every call delegates to the
 *   wrapped store, so a user who never imports anything cannot observe a
 *   difference — including the error messages, which still name the desktop
 *   app's auth file.
 * - **A populated pool takes precedence**, because importing accounts is an
 *   explicit act and silently preferring the desktop sign-in would make the
 *   import a no-op the user cannot see.
 * - **Rotation is driven by failure, not by a timer.** An account is retired
 *   only when the upstream says its session is dead; credit exhaustion is
 *   reported but not treated as death, because a depleted account recovers when
 *   its grant resets and permanently dropping it would empty the pool.
 *
 * @module dsh-workbuddy-connect/pool-store
 */

import { poolKeyOf, type WorkBuddyAccountPool, type WorkBuddyPoolCredential } from './account-pool.ts'
import type { WorkBuddyAuthStatus, WorkBuddyCredential } from './auth.ts'
import type { DesktopAuthFormat } from './desktop-credential-protection.ts'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'

/**
 * How long a credential is considered usable before its expiry.
 *
 * Matches the single-account store's margin: refresh early enough that an
 * in-flight request cannot cross the boundary, but not so early that a healthy
 * token is churned on every read.
 */
export const REFRESH_MARGIN_MS = 300_000

/**
 * The credential surface a pool resolver wraps.
 *
 * Declared structurally rather than as `WorkBuddyCredentialStore` so a test (or
 * a future store) can stand in without subclassing, and so the resolver never
 * depends on private members it does not use.
 */
export interface WorkBuddyCredentialSource {
  current(): Promise<WorkBuddyCredential | undefined>
  resolve(): Promise<WorkBuddyCredential>
  status(): Promise<WorkBuddyAuthStatus>
  logout(): Promise<void>
  setDesktopPath(path: string | undefined): void
  desktopAuthPath(): string | undefined
  ownAuthPath(): string
  desktopAuthFormat(): Promise<DesktopAuthFormat>
  resolvedDesktopAuthPath(): Promise<string | undefined>
  desktopFilePresent(): Promise<boolean>
  /**
   * Optional: report that the upstream rejected a credential as dead, so a pool
   * can stop offering it.
   *
   * Optional because the single-account store has nothing to rotate to — it
   * simply has no opinion, and a caller must not have to care which
   * implementation it holds. The shim calls it only after the upstream has
   * classified a failure as `session_dead`, which is the one signal that means
   * "this credential will keep failing until a human acts".
   */
  reportDead?(credential: WorkBuddyCredential, reason?: string): boolean
}

/** Constructor options for {@link WorkBuddyPoolCredentialResolver}. */
export interface WorkBuddyPoolResolverOptions {
  pool: WorkBuddyAccountPool
  fallback: WorkBuddyCredentialSource
  /** Performs the upstream token refresh for one pooled account. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default {@link REFRESH_MARGIN_MS}. */
  refreshMarginMs?: number
}

/** Non-enumerable marker field carrying the pool key on a returned credential. */
const POOL_KEY_FIELD = '__workbuddyPoolKey'

/**
 * Attach a pool key to a credential without adding an enumerable field.
 *
 * The credential object flows into `fetch`, header builders, and the status
 * document. An extra enumerable field would leak into anything that serializes
 * it, so the key rides along non-enumerably — readable by this module, invisible
 * everywhere else.
 */
export function withPoolKey(credential: WorkBuddyCredential, key: string): WorkBuddyCredential {
  Object.defineProperty(credential, POOL_KEY_FIELD, {
    value: key,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return credential
}

/** The pool key a credential carries, when it came from the pool. */
export function poolKeyOfCredential(credential: WorkBuddyCredential): string | undefined {
  const value = (credential as unknown as Record<string, unknown>)[POOL_KEY_FIELD]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A credential resolver that prefers the pool and rotates away from dead
 * sessions.
 *
 * The rotation cursor is in-memory and per-process. Persisting it would mean
 * writing on every request, and the cost of losing it across a restart is one
 * wasted attempt on a dead account before the pool advances again — not worth a
 * write path.
 */
export class WorkBuddyPoolCredentialResolver implements WorkBuddyCredentialSource {
  private readonly pool: WorkBuddyAccountPool
  private readonly fallback: WorkBuddyCredentialSource
  private readonly refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  private readonly refreshMarginMs: number
  private inflight: Promise<WorkBuddyCredential> | undefined
  private cursor = 0
  /**
   * Accounts this process will not offer, with the reason.
   *
   * Populated from two sources, both of which mean "this credential cannot be
   * used right now": an upstream call that classified the session as dead, and a
   * credential found already expired with no refresh half. The second is
   * discovered while *selecting* a credential, so even the read paths populate
   * this map — deliberately, because a pool that skipped a dead account silently
   * would report every account as usable while offering one fewer.
   *
   * In-memory and per-process by design: persisting it would mean a write on
   * every request, and losing it across a restart costs one wasted attempt before
   * the pool advances again.
   */
  private readonly retired = new Map<string, string>()

  constructor(options: WorkBuddyPoolResolverOptions) {
    this.pool = options.pool
    this.fallback = options.fallback
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? REFRESH_MARGIN_MS
  }

  /** The pool this resolver reads, for the CLI and the status card. */
  poolRef(): WorkBuddyAccountPool {
    return this.pool
  }

  /**
   * The next usable pool entry, starting at the cursor.
   *
   * Entries retired in this process are skipped; an entry whose expiry has
   * passed *and* that carries no refresh token is skipped too, since it can
   * neither be used nor renewed. A pool where every entry is unusable falls
   * through to the single-account store rather than reporting no credential.
   */
  private nextEntry(): { key: string; credential: WorkBuddyPoolCredential } | undefined {
    const entries = this.pool.usable()
    if (entries.length === 0) return undefined
    for (let offset = 0; offset < entries.length; offset += 1) {
      const index = (this.cursor + offset) % entries.length
      const entry = entries[index]!
      if (this.retired.has(entry.key)) continue
      const credential = entry.credential
      if (credential.expiresAtMs > 0 && credential.expiresAtMs <= Date.now() && credential.refreshToken === '') {
        // Expired with nothing to renew it: only a human re-login fixes this, so
        // the pool records the retirement rather than skipping the entry
        // invisibly — a silently skipped account would leave `retired` at 0 while
        // the pool quietly served one fewer credential than it holds.
        this.retired.set(entry.key, 'access token expired and no refresh token')
        continue
      }
      this.cursor = index
      return { key: entry.key, credential }
    }
    return undefined
  }

  /** Adapt one pooled credential into the provider's shape. */
  private asCredential(credential: WorkBuddyPoolCredential, key: string): WorkBuddyCredential {
    return withPoolKey({ ...credential, source: 'dsh' }, key)
  }

  /**
   * The freshest usable credential without refreshing anything.
   *
   * Pool first; the wrapped store only when the pool has nothing usable. The
   * returned credential carries its pool key on a non-enumerable property so
   * {@link resolve} can write a refresh back to the right entry without the
   * provider ever seeing a field it did not have before.
   */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const entry = this.nextEntry()
    if (entry === undefined) return await this.fallback.current()
    return this.asCredential(entry.credential, entry.key)
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   *
   * Single-flight across the whole pool, not per account: the caller is a request
   * that needs *one* working credential, so a second concurrent caller joining
   * the same refresh is correct and cheaper than a per-key map that would let two
   * refreshes race on the same entry.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const entry = this.nextEntry()
    if (entry === undefined) return await this.fallback.resolve()
    if (!this.needsRefresh(entry.credential)) return this.asCredential(entry.credential, entry.key)
    this.inflight ??= this.refreshEntry(entry).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Refresh one pool entry in place, rotating on failure. */
  private async refreshEntry(entry: { key: string; credential: WorkBuddyPoolCredential }): Promise<WorkBuddyCredential> {
    const credential = entry.credential
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return this.asCredential(credential, entry.key)
      this.retire(entry.key, 'access token expired and no refresh token')
      const next = this.nextEntry()
      if (next === undefined) return await this.fallback.resolve()
      return await this.resolve()
    }
    try {
      const outcome = await this.refresh({ ...credential, source: 'dsh' })
      const refreshed: WorkBuddyPoolCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      }
      this.pool.update(entry.key, refreshed)
      return this.asCredential(refreshed, entry.key)
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return this.asCredential(credential, entry.key)
      this.retire(entry.key, `refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      const next = this.nextEntry()
      if (next === undefined) return await this.fallback.resolve()
      return await this.resolve()
    }
  }

  /**
   * Report that the upstream rejected a credential as dead, so the pool stops
   * offering it. Callers pass the credential they just used.
   *
   * Deliberately *not* called for every 401: a 401 with a live refresh token is
   * recoverable by refreshing, and retiring on it would burn through a healthy
   * pool on a single upstream hiccup.
   */
  reportDead(credential: WorkBuddyCredential, reason: string = 'upstream reported the session as dead'): boolean {
    const key = poolKeyOfCredential(credential) ?? poolKeyOf(credential, undefined)
    if (this.pool.get(key) === undefined) return false
    this.retire(key, reason)
    return true
  }

  /** Retire one key for this process and advance past it. */
  private retire(key: string, reason: string): void {
    this.retired.set(key, reason)
    const entries = this.pool.usable()
    const index = entries.findIndex(entry => entry.key === key)
    if (index >= 0) this.cursor = (index + 1) % Math.max(entries.length, 1)
  }

  /** Keys retired in this process, for diagnostics. */
  retiredKeys(): { key: string; reason: string }[] {
    return [...this.retired.entries()].map(([key, reason]) => ({ key, reason }))
  }

  /** Clear the in-process retirement list, so retired accounts are retried. */
  resetRetired(): void {
    this.retired.clear()
    this.cursor = 0
  }

  /**
   * Sign-in summary: the pool's own counts plus the active account.
   *
   * `pool` is present only when the pool is non-empty, so a single-account
   * install's status document keeps the shape it has always had.
   */
  async status(): Promise<WorkBuddyAuthStatus & { pool?: { total: number; usable: number; retired: number; activeKey?: string } }> {
    const counts = this.pool.counts()
    const base = await this.fallback.status()
    if (counts.total === 0) return base
    const entry = this.nextEntry()
    const credential = entry?.credential
    return {
      state: entry === undefined && base.state === 'signed-out' ? 'signed-out' : 'signed-in',
      ...credential === undefined ? {} : {
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
      },
      source: entry === undefined ? base.source ?? 'dsh' : 'dsh',
      pool: {
        total: counts.total,
        usable: counts.usable,
        retired: this.retired.size,
        ...entry === undefined ? {} : { activeKey: entry.key },
      },
    }
  }

  /**
   * Sign out of the *pool's active account* by disabling it, leaving the other
   * accounts alone. The wrapped store's own logout is not called: the desktop
   * app's sign-in is not what the user asked to remove.
   */
  async logout(): Promise<void> {
    const entry = this.nextEntry()
    if (entry === undefined) {
      await this.fallback.logout()
      return
    }
    this.pool.setDisabled(entry.key, true)
    this.retire(entry.key, 'disabled by logout')
  }

  private needsRefresh(credential: WorkBuddyPoolCredential): boolean {
    if (credential.expiresAtMs <= 0) return credential.refreshToken !== ''
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  /**
   * Pass-through diagnostics.
   *
   * The provider and the CLI both call these on the credential store for
   * `doctor` and the settings card. They are delegated unchanged because the pool
   * does not change what the *desktop* file is — it only adds accounts beside it,
   * and a diagnostic that hid the desktop file's state would make a broken
   * sign-in harder to see, not easier.
   */
  setDesktopPath(path: string | undefined): void {
    this.fallback.setDesktopPath(path)
  }

  desktopAuthPath(): string | undefined {
    return this.fallback.desktopAuthPath()
  }

  ownAuthPath(): string {
    return this.fallback.ownAuthPath()
  }

  async desktopAuthFormat(): Promise<DesktopAuthFormat> {
    return await this.fallback.desktopAuthFormat()
  }

  async resolvedDesktopAuthPath(): Promise<string | undefined> {
    return await this.fallback.resolvedDesktopAuthPath()
  }

  async desktopFilePresent(): Promise<boolean> {
    return await this.fallback.desktopFilePresent()
  }
}
