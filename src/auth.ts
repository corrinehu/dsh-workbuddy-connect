/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under
 * `$DSH_HOME` holds token refreshes so the desktop file is never written.
 * The effective credential is whichever of the two expires later, so a
 * refresh by either side wins.
 *
 * @module dsh-workbuddy-connect/auth
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Directory under the Harness home holding one plugin-owned copy per account. */
export const WORKBUDDY_AUTH_DIRNAME = '.workbuddy-auth'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME)
}

/** Directory holding one plugin-owned credential copy per managed account. */
export function workbuddyAccountDir(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_DIRNAME)
}

/** Plugin-owned copy path for one named account inside the account directory. */
export function ownAccountPath(key: string): string {
  return join(workbuddyAccountDir(), `${encodeURIComponent(key)}.json`)
}

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
 * those same Windows locations through its mounted Windows profile before the
 * native Linux location.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...DESKTOP_AUTH_RELATIVE_PATH)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
  return credential
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  // The owned copy is the plugin's own wire format (WorkBuddyCredential with
  // camelCase `expiresAtMs`), NOT the desktop document shape — parsing it
  // through parseWorkBuddyAuth would read `expiresAt` (absent) and zero the
  // expiry, forcing a needless upstream refresh on every single request.
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin
 * (or already expired), keep the refreshed credential in the plugin-owned
 * copy, and never write the desktop app's file. A failed refresh still
 * returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? workbuddyOwnAuthPath()
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates()
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        `workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app`
        + ` (expected ${desktop} or WORKBUDDY_AUTH_FILE), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  /**
   * Take ownership of an already-resolved credential by writing it to the
   * plugin-owned copy verbatim (no upstream refresh). Used by the multi-account
   * manager to snapshot a desktop sign-in under a stable account key; the
   * desktop file is never written.
   */
  async seedOwn(credential: WorkBuddyCredential): Promise<void> {
    const seeded: WorkBuddyCredential = { ...credential, source: 'dsh' }
    await this.saveOwn(seeded)
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await mkdir(dirname(this.ownPath), { recursive: true })
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        return parseWorkBuddyAuth(await readFile(desktopPath, 'utf8'))
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      return undefined
    }
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}

/**
 * Multi-account registry. The plugin reuses the WorkBuddy desktop app's
 * single sign-in, but a user may want several accounts available at once (for
 * uninterrupted switching). Because the desktop app keeps only one sign-in,
 * each account is a *snapshot*: the user signs in on the desktop, then imports
 * the live sign-in under a stable key; the manager stores the refreshed copy
 * under `$DSH_HOME/.workbuddy-auth/<key>.json` and never writes the desktop
 * file. Each key maps to its own {@link WorkBuddyCredentialStore}, so token
 * refresh stays independent per account.
 *
 * @module dsh-workbuddy-connect/auth
 */

/** One managed account's discovery metadata (no token material). */
export interface WorkBuddyAccountInfo {
  /** Stable account key (the on-disk filename stem). */
  key: string
  /** Optional human label shown in the UI; defaults to the nickname/uid. */
  label?: string
  /** Where the stored copy came from. */
  source: 'desktop' | 'dsh'
}

/** A managed account plus its live sign-in summary. */
export interface WorkBuddyAccountStatus extends WorkBuddyAccountInfo {
  state: 'signed-in' | 'signed-out'
  nickname?: string
  domain?: string
  expiresAtMs?: number
  refreshExpiresAtMs?: number
}

/** Options for {@link WorkBuddyAccountManager}. */
export interface WorkBuddyAccountManagerOptions {
  /** Performs the upstream token refresh for any owned store. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Optional explicit desktop auth-file path; falls back to platform defaults. */
  desktopPath?: string
  /** Refresh this long before expiry; default five minutes. */
  refreshMarginMs?: number
}

/**
 * Discover, import, list, resolve, and remove managed WorkBuddy accounts.
 *
 * Discovery is filesystem-based: every `*.json` directly inside
 * {@link workbuddyAccountDir} whose `version` matches the own format is an
 * account. Accounts are never enumerated from the desktop app, which holds at
 * most one sign-in.
 */
export class WorkBuddyAccountManager {
  private readonly refresh: WorkBuddyAccountManagerOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly desktopPathOverride: string | undefined
  private readonly stores = new Map<string, WorkBuddyCredentialStore>()

  constructor(options: WorkBuddyAccountManagerOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.desktopPathOverride = options.desktopPath
  }

  /** Read-only store for one account; lazily constructed and cached. */
  storeFor(key: string): WorkBuddyCredentialStore {
    let store = this.stores.get(key)
    if (store === undefined) {
      store = new WorkBuddyCredentialStore({
        // An imported account is a pure snapshot: its store must never fall
        // back to probing the live desktop file, or a later desktop re-login
        // to a different account would leak into every stored account. The
        // sentinel path below never exists, so only the owned copy (plus its
        // refreshes) is consulted.
        desktopPath: join(workbuddyAccountDir(), '.no-desktop'),
        ownPath: ownAccountPath(key),
        refresh: this.refresh,
        refreshMarginMs: this.refreshMarginMs,
      })
      this.stores.set(key, store)
    }
    return store
  }

  /** The desktop credential store, for reading/importing the live sign-in. */
  desktopStore(): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      ...this.desktopPathOverride === undefined ? {} : { desktopPath: this.desktopPathOverride },
      ownPath: join(workbuddyAccountDir(), '.desktop-import.tmp'),
      refresh: this.refresh,
      refreshMarginMs: this.refreshMarginMs,
    })
  }

  /** List discovered account keys (filename stems) from the account directory. */
  async listAccounts(): Promise<string[]> {
    const dir = workbuddyAccountDir()
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch (error: unknown) {
      if (isENOENT(error)) return []
      throw error
    }
    const keys: string[] = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const key = decodeURIComponent(name.slice(0, -'.json'.length))
      keys.push(key)
    }
    return keys
  }

  private accountInfo(key: string): WorkBuddyAccountInfo {
    return { key, source: 'dsh' }
  }

  /**
   * Snapshot the live desktop sign-in under `key`. Reads the desktop file
   * (read-only), writes the plugin-owned copy under that key, and returns the
   * resulting account info. Refuses to overwrite a key that already exists
   * unless `force` is set, so an accidental re-import does not clobber.
   */
  async importFromDesktop(key: string, options?: { label?: string; force?: boolean }): Promise<WorkBuddyAccountInfo> {
    const trimmed = key.trim()
    if (trimmed === '') throw new Error('workbuddy: account key must not be empty')
    const existing = await this.listAccounts()
    if (existing.includes(trimmed) && options?.force !== true) {
      throw new Error(`workbuddy: account "${trimmed}" already exists; pass force to overwrite`)
    }
    const store = this.desktopStore()
    const credential = await store.current()
    if (credential === undefined) {
      throw new Error('workbuddy: no signed-in WorkBuddy account found in the desktop app; sign in there first')
    }
    const target = this.storeFor(trimmed)
    await target.seedOwn(credential)
    return this.accountInfo(trimmed)
  }

  /** Live sign-in summary for one account, or signed-out when absent/broken. */
  async statusOf(key: string): Promise<WorkBuddyAccountStatus> {
    if (!(await this.listAccounts()).includes(key)) {
      return { ...this.accountInfo(key), state: 'signed-out' }
    }
    const summary = await this.storeFor(key).status()
    if (summary.state !== 'signed-in') return { ...this.accountInfo(key), state: 'signed-out' }
    return {
      ...this.accountInfo(key),
      state: 'signed-in',
      ...summary.nickname === undefined ? {} : { nickname: summary.nickname },
      ...summary.domain === undefined || summary.domain === '' ? {} : { domain: summary.domain },
      ...summary.expiresAtMs === undefined ? {} : { expiresAtMs: summary.expiresAtMs },
      ...summary.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: summary.refreshExpiresAtMs },
      source: summary.source ?? 'dsh',
    }
  }

  /** Sign-in summary for every discovered account. */
  async statuses(): Promise<WorkBuddyAccountStatus[]> {
    const keys = await this.listAccounts()
    return Promise.all(keys.map(key => this.statusOf(key)))
  }

  /** Resolve the freshest credential for one account, refreshing on demand. */
  async resolve(key: string): Promise<WorkBuddyCredential> {
    if (!(await this.listAccounts()).includes(key)) {
      throw new Error(`workbuddy: no such account "${key}"; import it with "dsh-workbuddy-connect import ${key}"`)
    }
    return this.storeFor(key).resolve()
  }

  /** Remove one account's plugin-owned copy; the desktop app is untouched. */
  async remove(key: string): Promise<void> {
    await rm(ownAccountPath(key), { force: true })
    await rm(`${ownAccountPath(key)}.lock`, { force: true })
    this.stores.delete(key)
  }
}
