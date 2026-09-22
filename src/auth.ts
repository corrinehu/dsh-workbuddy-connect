/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under
 * `$DSH_HOME` holds token refreshes so the desktop file is never written.
 * The effective credential is whichever of the two expires later, so a
 * refresh by either side wins.
 *
 * @module dsh-workbuddy-connect/auth
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { regionOf } from './upstream.ts'
import type { WorkBuddyVariant } from './variants.ts'
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
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody is signed in" — a credential belonging to the other product, or a
   * desktop file written in a newer, encrypted format this build cannot read.
   * Present only on `signed-out`, and never a substitute for fixing the file.
   */
  reason?: string
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  variant?: WorkBuddyVariant
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

/**
 * The platform-default candidates for one variant, in probe order.
 *
 * Both apps write into the *same* shared `CodeBuddyExtension` auth directory
 * and differ only in the file's basename, so the per-platform ordering above
 * is reused verbatim and just the filename is swapped.
 */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  return defaultDesktopAuthCandidates().map(path => join(dirname(path), variant.desktopFilename))
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(variant?: WorkBuddyVariant): string | undefined {
  const candidates = variant === undefined ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(variant)
  return candidates[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Whether a value is a mutable record (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The key a newer desktop app wraps its sensitive fields in.
 *
 * WorkBuddy 5.6.0 writes `accessToken`, `refreshToken`, and the account's own
 * details as `{"$wbEncrypted":1,"envelope":"<base64>"}` instead of plain
 * strings. The envelope's key belongs to the desktop app, so the payload is
 * opaque to this plugin — but the *presence* of the marker is not, and that is
 * what makes "the file is newer than the plugin" distinguishable from "nobody
 * is signed in".
 */
export const WORKBUDDY_ENCRYPTED_MARKER = '$wbEncrypted'

/** What an encrypted desktop field looks like, as far as this build can tell. */
export interface WorkBuddyEncryptedFormat {
  /**
   * The marker's own value — `1` in the observed 5.6.0 file — treated as the
   * envelope format's version, since it is the only thing about the envelope
   * that is readable at all.
   */
  marker: number
  /** Which fields arrived enveloped: field *names* only, never token material. */
  fields: readonly string[]
}

/** A desktop auth file that exists but is written in that encrypted format. */
export interface WorkBuddyEncryptedAuthFile {
  /** The file that carried the envelope, for a message that names it. */
  path: string
  format: WorkBuddyEncryptedFormat
}

/** Outcome of reading one desktop auth document. */
export interface WorkBuddyAuthInspection {
  /** The credential the document carried, when it is one this build can read. */
  credential?: WorkBuddyCredential
  /**
   * Set when the document is a newer, encrypted one whose tokens cannot be
   * unwrapped: the file was found and is valid JSON, its sign-in is simply
   * opaque. Never set together with {@link credential} — a plaintext token
   * always wins, so an app that writes both (or a transitional build that
   * encrypts only one field) keeps working exactly as before.
   */
  encrypted?: WorkBuddyEncryptedFormat
}

/** The marker value of an envelope object; undefined for every other value. */
function envelopeMarker(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const marker = value[WORKBUDDY_ENCRYPTED_MARKER]
  return typeof marker === 'number' && Number.isFinite(marker) ? marker : undefined
}

/** Collect every enveloped field a document declares, identity fields included. */
function collectEnvelopes(...records: readonly Record<string, unknown>[]): WorkBuddyEncryptedFormat | undefined {
  const fields: string[] = []
  let marker: number | undefined
  for (const record of records) {
    for (const [field, value] of Object.entries(record)) {
      const found = envelopeMarker(value)
      if (found === undefined || fields.includes(field)) continue
      marker ??= found
      fields.push(field)
    }
  }
  return marker === undefined ? undefined : { marker, fields }
}

/**
 * Read a WorkBuddy auth document in either *plaintext* on-disk shape — the
 * plugin OAuth nested form `{"auth":{...},"account":{...}}` and the flat panel
 * form — and report the encrypted shape when that is what the file is.
 *
 * The plaintext branch is checked first and unconditionally: every desktop app
 * up to 5.5.6 writes a string token, and that must keep parsing exactly as it
 * always has. Only when a document carries *no* plaintext access token is an
 * envelope looked for — the case that used to be indistinguishable from an
 * empty file.
 */
export function inspectWorkBuddyAuth(text: string): WorkBuddyAuthInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const document = parsed
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (isRecord(document['auth'])) {
    auth = document['auth']
    identity = isRecord(document['account']) ? document['account'] : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') {
    const encrypted = collectEnvelopes(auth, identity)
    return encrypted === undefined ? {} : { encrypted }
  }
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
  return { credential }
}

/**
 * Parse a WorkBuddy auth document into a credential.
 *
 * Kept as the compatibility surface for callers that only want the token; it
 * cannot say *why* a document yielded nothing. Use
 * {@link inspectWorkBuddyAuth} when that distinction matters — a newer desktop
 * app's encrypted document parses to `undefined` here exactly like an empty
 * one, which is how "the file is present and unreadable" used to be reported as
 * "nobody is signed in".
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  return inspectWorkBuddyAuth(text).credential
}

/**
 * Classify the desktop auth file's first present candidate.
 *
 * `absent` and `encrypted` are the pair the card and `doctor` have to tell
 * apart: a sign-out caused by a missing file is the user's to fix, while one
 * caused by a format this build does not read is the plugin's.
 */
export type WorkBuddyDesktopAuthFormat = 'plaintext' | 'encrypted' | 'unrecognized' | 'absent'

/** One read of the desktop auth file, for diagnostics. */
export interface WorkBuddyDesktopAuthReport {
  format: WorkBuddyDesktopAuthFormat
  /** Where the verdict came from; absent only when no candidate exists. */
  path?: string
  /**
   * Set when `format` is `encrypted`, ready to hand to
   * {@link encryptedDesktopAuthReason}. `doctor` reuses the builder rather than
   * writing its own sentence, so every surface explains the file the same way.
   */
  encrypted?: WorkBuddyEncryptedAuthFile
}

/**
 * Explain a desktop auth file whose tokens this build cannot read.
 *
 * One sentence shared by {@link WorkBuddyCredentialStore.status}'s `reason`
 * (which the card renders verbatim), the store's `resolve()` error, and
 * `doctor`. It deliberately leads with what was *found*, because the generic
 * hint it replaces — "sign in once in the desktop app" — sends the user to
 * re-sign-in, which rewrites the very file that cannot be read, instead of
 * pointing at the version gap.
 */
export function encryptedDesktopAuthReason(appName: string, file: WorkBuddyEncryptedAuthFile): string {
  return `${appName} desktop auth file at ${file.path} is written in an encrypted format this plugin version cannot read`
    + ` (${WORKBUDDY_ENCRYPTED_MARKER}=${file.format.marker}, encrypted fields: ${file.format.fields.join(', ')});`
    + ` the ${appName} desktop app that wrote it is newer than this plugin — update dsh-workbuddy-connect to read it`
    + ` (signing in again rewrites the same file and will not help)`
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
  // The owned copy stores the normalized credential itself (camelCase
  // `expiresAtMs`, identity fields at the top level), not the desktop
  // document shape. Round-tripping through parseWorkBuddyAuth reads
  // `expiresAt` and an `account` object, finds neither, zeroes the expiry,
  // and drops uid/enterprise/nickname — so a surviving copy refreshed on
  // every request and lost its identity headers.
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

/** What the desktop slot had to say on one read. */
interface DesktopSlotRead {
  credential?: WorkBuddyCredential
  /** A found file whose tokens the desktop app encrypted — a newer app version. */
  encrypted?: WorkBuddyEncryptedAuthFile
}

/** What both storage slots had to say on one read. */
interface CredentialRead {
  /** The credential to serve; absent when neither slot has a usable one. */
  credential?: WorkBuddyCredential
  /**
   * Why the desktop slot yielded no credential, when the file was there and
   * the reason is the app's format rather than the user's sign-in state.
   */
  encrypted?: WorkBuddyEncryptedAuthFile
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
  private readonly variant: WorkBuddyVariant | undefined
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? (options.variant ? join(resolveDshHome(), options.variant.ownFilename) : workbuddyOwnAuthPath())
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[this.variant?.env ?? WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return this.variant === undefined
      ? defaultDesktopAuthCandidates()
      : desktopAuthCandidatesFor(this.variant)
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
    return (await this.readCredential()).credential
  }

  /**
   * Read both slots and pick the credential to serve, keeping the desktop
   * slot's verdict for the callers that have to *explain* a sign-out.
   */
  private async readCredential(): Promise<CredentialRead> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    const desktopCredential = desktop.credential
    // A credential belonging to the other product is refused rather than used:
    // the two apps share one auth directory and differ only by filename, so a
    // misconfigured `authFile` / env var is a realistic mistake, and sending one
    // region's token to the other's endpoint would leak it across products.
    // Naming the file and the expected region is what makes it fixable.
    if (this.variant !== undefined) {
      for (const [label, credential] of [['desktop file', desktopCredential], ['plugin copy', own]] as const) {
        if (credential === undefined) continue
        const region = regionOf(credential.domain)
        if (region !== this.variant.region) {
          throw new Error(
            `${this.variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
            + ` in its ${label} (domain ${JSON.stringify(credential.domain)});`
            + ` point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`,
          )
        }
      }
    }
    // The encrypted verdict rides along even when the plugin-owned copy still
    // supplies a credential: the caller decides whether it matters, and a
    // surviving copy must keep working — one app changing its storage format is
    // not a reason to drop a session this plugin refreshed itself.
    const encrypted = desktop.encrypted === undefined ? {} : { encrypted: desktop.encrypted }
    if (desktopCredential === undefined) {
      return own === undefined ? encrypted : { credential: own, ...encrypted }
    }
    if (own === undefined) return { credential: desktopCredential }
    // Identity beats expiry. The plugin's own copy is written by its own
    // refreshes, so after the user switches accounts in the desktop app the copy
    // still belongs to the *previous* account — and may well expire later,
    // because the plugin refreshed it. Preferring it by expiry would send the old
    // account's uid in `X-User-Id` and answer as the wrong user. The desktop
    // file is the authority on who is signed in now; a differing identity means
    // the copy is stale regardless of its timestamp.
    if (desktopCredential.uid !== own.uid || desktopCredential.enterpriseId !== own.enterpriseId) {
      return { credential: desktopCredential }
    }
    return { credential: own.expiresAtMs > desktopCredential.expiresAtMs ? own : desktopCredential }
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const read = await this.readCredential()
    const credential = read.credential
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      const app = this.variant?.appName ?? 'WorkBuddy'
      throw new Error(
        `workbuddy: no signed-in ${app} account found; sign in once in the ${app} desktop app`
        + ` (expected ${desktop} or ${this.variant?.env ?? WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`
        // A found-but-encrypted file is appended rather than replacing the hint:
        // the hint is still true, but on its own it is the advice that sends the
        // user to re-sign-in and rewrite the unreadable file.
        + (read.encrypted === undefined ? '' : ` — ${encryptedDesktopAuthReason(app, read.encrypted)}`),
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
      const read = await this.readCredential()
      const credential = read.credential
      if (credential === undefined) {
        return {
          state: 'signed-out',
          // Only the encrypted case earns a reason. It is the one where the file
          // was found and the *plugin* is behind, so "sign in once" is wrong
          // advice; a document that is merely empty or garbled stays a silent
          // sign-out, and `doctor` reports its format for that diagnosis.
          ...read.encrypted === undefined
            ? {}
            : { reason: encryptedDesktopAuthReason(this.variant?.appName ?? 'WorkBuddy', read.encrypted) },
        }
      }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch (error: unknown) {
      // A region mismatch (or an unreadable file) is a *diagnosable* signed-out
      // state, not a silent one: the user needs the path to the file that is
      // wrong, and which provider it actually belongs to. Reported as a status
      // rather than thrown, because `status()` is documented never to throw and
      // the card renders `reason` verbatim.
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
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
  private async readDesktop(): Promise<DesktopSlotRead> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      // A found file ends the probe either way: a credential, a newer app's
      // encrypted document (named, because it is the reason there is none), or
      // a document that simply carries no token.
      const inspection = inspectWorkBuddyAuth(text)
      if (inspection.credential !== undefined) return { credential: inspection.credential }
      if (inspection.encrypted !== undefined) return { encrypted: { path: desktopPath, format: inspection.encrypted } }
      return {}
    }
    return {}
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

  /**
   * Classify the desktop auth file's first present candidate.
   *
   * Subsumes {@link desktopFilePresent} for `doctor`, which needs the *reason*
   * a present file yielded nothing — "present" beside "signed-out" is exactly
   * the pair that made a newer App's format look like a stale path. Reads the
   * file (the presence question alone is a `stat`), never refreshes, never
   * throws, and never returns token material.
   */
  async inspectDesktopAuthFile(): Promise<WorkBuddyDesktopAuthReport> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (isENOENT(error)) continue
        // Present but unreadable (permissions, a directory): a fact about the
        // file, and not the same fact as `absent`.
        return { format: 'unrecognized', path: desktopPath }
      }
      const inspection = inspectWorkBuddyAuth(text)
      if (inspection.credential !== undefined) return { format: 'plaintext', path: desktopPath }
      if (inspection.encrypted !== undefined) {
        return {
          format: 'encrypted',
          path: desktopPath,
          encrypted: { path: desktopPath, format: inspection.encrypted },
        }
      }
      return { format: 'unrecognized', path: desktopPath }
    }
    return { format: 'absent' }
  }
}
