/**
 * Multi-account pool for WorkBuddy Connect: bulk import, rotation, and daily
 * check-in.
 *
 * Why this exists: the credential store this plugin ships with resolves exactly
 * *one* account per variant — the desktop app's sign-in, or the plugin-owned
 * copy of it. Everything else (a second account, a purchased batch, a farm of
 * trial accounts) had no way in, no way to rotate when one account ran out of
 * credit, and no way to claim the daily credit grant.
 *
 * Design constraints, inherited from the other stores in this bundle:
 *
 * - **The pool never replaces the single-account path.** An empty pool is the
 *   pre-existing behaviour: the desktop file is still the authority and nothing
 *   here is consulted. Importing is opt-in.
 * - **One file per variant**, version-tagged, atomically written with `0o600`,
 *   and a malformed file reads as "no accounts" rather than throwing. A corrupt
 *   pool must never stop the plugin from serving the account the desktop app
 *   already signed in.
 * - **Tokens are secrets.** The pool file holds refresh and access tokens, so it
 *   is written `0o600` inside `$DSH_HOME`, and every diagnostic in this module
 *   reports uid/nickname/expiry only — never a token value.
 *
 * @module dsh-workbuddy-connect/account-pool
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential } from './auth.ts'

/** On-disk format this reader accepts; other versions are discarded. */
export const POOL_FORMAT_VERSION = 1

/** Basename of the CN variant's pool inside the Harness home. */
export const WORKBUDDY_POOL_FILENAME = '.workbuddy-pool.json'

/** Plugin-owned pool path inside the Harness home. */
export function workbuddyPoolPath(filename: string = WORKBUDDY_POOL_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/**
 * A credential as stored in the pool, before it is handed to the provider.
 *
 * Identical to {@link WorkBuddyCredential} except that `source` is not stored:
 * an imported account is neither the desktop's credential nor a refreshed copy
 * of one, and claiming either would misreport where it came from.
 */
export type WorkBuddyPoolCredential = Omit<WorkBuddyCredential, 'source'>

/** One account in the pool. */
export interface WorkBuddyPoolEntry {
  /**
   * Stable identity key (`uid:enterpriseId`, or an opaque digest when the
   * document carried no uid). Rotation, enable/disable, and removal all address
   * an account by this key.
   */
  key: string
  credential: WorkBuddyPoolCredential
  /** When this key was first imported. */
  addedAtMs?: number
  /** When the last check-in attempt ran, and what it concluded. */
  lastCheckinAtMs?: number
  lastCheckinStatus?: WorkBuddyCheckinStatus
  /**
   * Excluded from rotation and bulk check-in, but kept in the pool with its
   * tokens intact. Deliberately not a delete: an account that ran out of credit
   * this month is expected to come back.
   */
  disabled?: boolean
}

/** The verdict one account's check-in attempt reached. */
export type WorkBuddyCheckinStatus = 'ok' | 'already' | 'auth' | 'failed'

/** What one import did, per account. */
export interface WorkBuddyPoolMergeReport {
  added: number
  updated: number
  skipped: number
  entries: { key: string; action: 'added' | 'updated' | 'skipped'; nickname?: string }[]
}

/** Constructor options for {@link WorkBuddyAccountPool}. */
export interface WorkBuddyAccountPoolOptions {
  /** Pool file path; defaults to {@link workbuddyPoolPath}. */
  path?: string
  /**
   * Digest used for the key of an account that carries no uid. Injected so the
   * store never has to import `node:crypto` for callers that supply their own
   * (tests), and so the fallback stays swappable.
   */
  hashOf?: (seed: string) => string
}

/**
 * Normalize an expiry that may arrive in seconds or milliseconds.
 *
 * The same tolerance the desktop parser applies: upstream tooling and hand-made
 * auth files disagree about the unit, and a 10-digit epoch in seconds read as
 * milliseconds would place the expiry in 1970 and make every imported account
 * look permanently expired.
 */
export function expiryToMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 0xe8d4a51000 ? value : value * 1e3
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse one account document into a pool credential.
 *
 * Accepts every shape the ecosystem already produces, because the point of bulk
 * import is to take what the user has rather than require a bespoke format:
 *
 * - the plugin-owned / desktop nested form `{auth:{...},account:{...}}`,
 * - the flat form the Go gateway (`workbuddy2api`) writes to `auths/*.json`,
 * - this pool's own entry shape (`{uid, accessToken, ...}`),
 * - a bare `{accessToken, refreshToken, ...}` with identity fields inline.
 *
 * Returns `undefined` when no access token is present — an entry without one
 * cannot be used or refreshed, so accepting it would only produce a pool that
 * fails later with a worse message.
 */
export function parseAccountDocument(value: unknown): WorkBuddyPoolCredential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const document = value as Record<string, unknown>
  // Nested form: identity lives under `account`, tokens under `auth`.
  const nested = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const identity = typeof document['account'] === 'object' && document['account'] !== null
    ? document['account'] as Record<string, unknown>
    : document
  const accessToken = typeof nested['accessToken'] === 'string' ? nested['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshToken = typeof nested['refreshToken'] === 'string' ? nested['refreshToken'] : ''
  // Two expiry spellings, and the milliseconds one matters for round-tripping:
  // this pool writes its entries back as `expiresAtMs`, so a reader that only
  // understood `expiresAt` would reload every entry with an unknown expiry — and
  // an unknown expiry means "renew on every read", which silently turns a
  // healthy pool into a refresh storm. `expiresAt` keeps the seconds/milliseconds
  // tolerance the desktop parser applies; `expiresAtMs` is already milliseconds.
  const expiresAtMs = typeof nested['expiresAtMs'] === 'number'
    ? nested['expiresAtMs']
    : expiryToMs(nested['expiresAt'])
  // `0` from the normalizer means "no usable value", not "expires at the epoch":
  // it is dropped rather than stored, so the optional field stays absent exactly
  // when the source document did not carry it.
  const refreshRaw = typeof nested['refreshExpiresAtMs'] === 'number'
    ? nested['refreshExpiresAtMs']
    : expiryToMs(nested['refreshExpiresAt'])
  const refreshExpiresAtMs = refreshRaw > 0 ? refreshRaw : undefined
  const domain = optionalString(nested['domain']) ?? optionalString(document['domain']) ?? ''
  const uid = optionalString(identity['uid']) ?? optionalString(document['uid']) ?? ''
  const enterpriseId = optionalString(identity['enterpriseId']) ?? optionalString(document['enterpriseId'])
  const nickname = optionalString(identity['nickname']) ?? optionalString(document['nickname'])
  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain,
    uid,
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
  }
}

/**
 * The pool key for one credential: the same `uid:enterpriseId` identity the
 * saved catalogs, visibility lists, and probe records are keyed by.
 *
 * A credential with no uid falls back to a digest of its refresh token rather
 * than collapsing into the shared `:enterpriseId` bucket — two accounts that
 * both omit uid must not overwrite each other on import. The fallback is
 * deliberately opaque: it appears in CLI output, and the token it is derived
 * from must not.
 */
export function poolKeyOf(
  credential: Pick<WorkBuddyPoolCredential, 'uid' | 'enterpriseId' | 'refreshToken' | 'accessToken'>,
  hashOf?: (seed: string) => string,
): string {
  if (credential.uid !== '') return `${credential.uid}:${credential.enterpriseId ?? ''}`
  const seed = credential.refreshToken !== '' ? credential.refreshToken : credential.accessToken
  if (hashOf === undefined) {
    // No hasher supplied (a directly-constructed pool in a test): fall back to a
    // length-tagged digest of the seed. Still keyed per credential, still opaque,
    // and never the token itself.
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
    }
    return `anon:${hash.toString(16)}-${seed.length.toString(16)}`
  }
  return `anon:${hashOf(seed).slice(0, 16)}`
}

/** Whether a parsed value is a pool entry this reader can trust. */
function isPoolEntry(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry['key'] === 'string' && entry['key'] !== ''
    && typeof entry['credential'] === 'object' && entry['credential'] !== null
}

/**
 * The account pool for one variant.
 *
 * `entries` is a plain array rather than a map because rotation walks it in
 * import order, and an array keeps that order stable across a JSON round-trip on
 * every runtime that matters here. Lookup by key is a linear scan; pools are
 * tens of accounts, not thousands, and a map would have to be rebuilt on every
 * mutation anyway.
 */
export class WorkBuddyAccountPool {
  private readonly path: string
  private readonly hashOf: ((seed: string) => string) | undefined
  private entries: WorkBuddyPoolEntry[] | undefined

  constructor(options: string | WorkBuddyAccountPoolOptions = {}) {
    this.path = typeof options === 'string' ? options : options.path ?? workbuddyPoolPath()
    this.hashOf = typeof options === 'string' ? undefined : options.hashOf
  }

  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  private load(): WorkBuddyPoolEntry[] {
    if (this.entries !== undefined) return this.entries
    const entries: WorkBuddyPoolEntry[] = []
    if (existsSync(this.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const document = parsed as Record<string, unknown>
          const raw = document['version'] === POOL_FORMAT_VERSION ? document['entries'] : undefined
          if (Array.isArray(raw)) {
            for (const value of raw) {
              if (!isPoolEntry(value)) continue
              const credential = parseAccountDocument(value['credential'])
              if (credential === undefined) continue
              const status = value['lastCheckinStatus']
              entries.push({
                key: value['key'] as string,
                credential,
                ...typeof value['addedAtMs'] === 'number' ? { addedAtMs: value['addedAtMs'] } : {},
                ...typeof value['lastCheckinAtMs'] === 'number' ? { lastCheckinAtMs: value['lastCheckinAtMs'] } : {},
                ...status === 'ok' || status === 'already' || status === 'auth' || status === 'failed'
                  ? { lastCheckinStatus: status }
                  : {},
                ...typeof value['disabled'] === 'boolean' ? { disabled: value['disabled'] } : {},
              })
            }
          }
        }
      } catch {}
    }
    this.entries = entries
    return entries
  }

  /** Every entry, in import order. */
  all(): readonly WorkBuddyPoolEntry[] {
    return this.load()
  }

  /** Entries eligible for rotation: present and not disabled. */
  usable(): readonly WorkBuddyPoolEntry[] {
    return this.load().filter(entry => entry.disabled !== true)
  }

  /** One entry by key, or `undefined`. */
  get(key: string): WorkBuddyPoolEntry | undefined {
    return this.load().find(entry => entry.key === key)
  }

  /** How many entries exist, and how many are usable. */
  counts(): { total: number; usable: number } {
    const entries = this.load()
    return {
      total: entries.length,
      usable: entries.filter(entry => entry.disabled !== true).length,
    }
  }

  /**
   * Merge imported credentials into the pool.
   *
   * Merge policy is **refresh, not replace**, and it is the load-bearing
   * decision in this module:
   *
   * - A key already present is updated in place, keeping its original import
   *   position, so re-importing a fresher export of the same accounts does not
   *   reshuffle the rotation order.
   * - Freshness is judged by the access token's expiry, which is the only signal
   *   an export carries, and the comparison is **strictly newer wins**. An equal
   *   expiry means the document is the same vintage as what is stored, and the
   *   stored copy is the one this plugin may have already refreshed — so a tie
   *   keeps it. That is what makes re-importing the same file idempotent, which
   *   is the property a batch tool most needs: running an import twice must not
   *   change the pool.
   * - When the incoming document is *older*, both halves of the pair are treated
   *   as stale — access token **and** refresh token. Taking the incoming refresh
   *   token anyway would be the worse half of the mistake: a refresh token that
   *   has since rotated is dead, and adopting it would break an account this
   *   plugin had already renewed.
   * - A refresh token is still taken from an older document when the stored one
   *   is empty — an empty half cannot renew anything, so any value is an
   *   improvement.
   * - A brand-new key is appended.
   *
   * `disabled` is never cleared by an import: a re-import is not a user saying
   * "re-enable this account".
   */
  merge(imported: readonly WorkBuddyPoolCredential[], options: { now?: number } = {}): WorkBuddyPoolMergeReport {
    const entries = this.load()
    const now = options.now ?? Date.now()
    const report: WorkBuddyPoolMergeReport = { added: 0, updated: 0, skipped: 0, entries: [] }
    for (const credential of imported) {
      const key = poolKeyOf(credential, this.hashOf)
      const existing = entries.find(entry => entry.key === key)
      if (existing === undefined) {
        entries.push({ key, credential, addedAtMs: now })
        report.added += 1
        report.entries.push({
          key,
          action: 'added',
          ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        })
        continue
      }
      const stored = existing.credential
      const incomingIsStale = credential.expiresAtMs <= stored.expiresAtMs
      const storedRefresh = stored.refreshToken
      const merged: WorkBuddyPoolCredential = {
        ...stored,
        accessToken: incomingIsStale ? stored.accessToken : credential.accessToken,
        expiresAtMs: incomingIsStale ? stored.expiresAtMs : credential.expiresAtMs,
        refreshToken: incomingIsStale
          ? storedRefresh !== '' ? storedRefresh : credential.refreshToken
          : credential.refreshToken !== '' ? credential.refreshToken : storedRefresh,
        domain: credential.domain !== '' ? credential.domain : stored.domain,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      }
      const unchanged = merged.accessToken === stored.accessToken
        && merged.refreshToken === stored.refreshToken
        && merged.expiresAtMs === stored.expiresAtMs
      if (unchanged) {
        report.skipped += 1
        report.entries.push({
          key,
          action: 'skipped',
          ...stored.nickname === undefined ? {} : { nickname: stored.nickname },
        })
        continue
      }
      existing.credential = merged
      report.updated += 1
      report.entries.push({
        key,
        action: 'updated',
        ...merged.nickname === undefined ? {} : { nickname: merged.nickname },
      })
    }
    this.persist()
    return report
  }

  /** Replace one entry's credential in place (a refresh, or a rotation write-back). */
  update(key: string, credential: WorkBuddyPoolCredential): boolean {
    const entry = this.get(key)
    if (entry === undefined) return false
    entry.credential = credential
    this.persist()
    return true
  }

  /** Record the outcome of one account's check-in attempt. */
  markCheckin(key: string, status: WorkBuddyCheckinStatus, now: number = Date.now()): void {
    const entry = this.get(key)
    if (entry === undefined) return
    entry.lastCheckinAtMs = now
    entry.lastCheckinStatus = status
    this.persist()
  }

  /**
   * Enable or disable one account. A disabled account stays in the pool with its
   * tokens intact — it is skipped by rotation and by bulk check-in, and nothing
   * else.
   */
  setDisabled(key: string, disabled: boolean): boolean {
    const entry = this.get(key)
    if (entry === undefined) return false
    entry.disabled = disabled
    this.persist()
    return true
  }

  /** Remove one account permanently. Returns whether it existed. */
  remove(key: string): boolean {
    const entries = this.load()
    const index = entries.findIndex(entry => entry.key === key)
    if (index < 0) return false
    entries.splice(index, 1)
    this.persist()
    return true
  }

  /** Remove every account. */
  clear(): void {
    this.entries = []
    this.persist()
  }

  /**
   * Write the pool atomically with `0o600`.
   *
   * Unlike the catalog store, a failed write **propagates**: the caller is a
   * user-facing import or a credential refresh, and silently losing a token the
   * user just imported would be a lie about what happened.
   */
  persist(): void {
    const directory = dirname(this.path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document = { version: POOL_FORMAT_VERSION, entries: this.load() }
    const temporary = resolve(`${this.path}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

/**
 * Extract every account document from one parsed import payload.
 *
 * Accepts the shapes a user actually has on disk, and returns them all rather
 * than the first match, so one file can carry a whole batch:
 *
 * - an array of account documents,
 * - `{accounts: [...]}` / `{auths: [...]}` / `{entries: [...]}` wrappers,
 * - a map keyed by uid whose values are account documents,
 * - a single account document.
 */
export function accountsFromPayload(value: unknown): WorkBuddyPoolCredential[] {
  if (Array.isArray(value)) return value.flatMap(item => accountsFromPayload(item))
  if (typeof value !== 'object' || value === null) return []
  const document = value as Record<string, unknown>
  for (const field of ['accounts', 'auths', 'entries', 'data', 'list']) {
    const nested = document[field]
    if (Array.isArray(nested)) return nested.flatMap(item => accountsFromPayload(item))
  }
  const direct = parseAccountDocument(document)
  if (direct !== undefined) return [direct]
  // A map keyed by uid (or by filename stem): every value that parses wins.
  const collected: WorkBuddyPoolCredential[] = []
  for (const nested of Object.values(document)) {
    if (typeof nested !== 'object' || nested === null) continue
    collected.push(...accountsFromPayload(nested))
  }
  return collected
}

/**
 * Parse one import file's text into account documents.
 *
 * Two encodings, tried in that order:
 *
 * 1. **JSON** — a single document or array, in any of the shapes
 *    {@link accountsFromPayload} accepts.
 * 2. **JSON Lines** — one document per line. Tried only when JSON parsing fails,
 *    and every line must parse; a file where some lines parse and others do not
 *    is reported as malformed rather than silently imported in part, because a
 *    half-imported batch is worse than a visible failure.
 *
 * Lines that are blank or start with `#` are skipped, so a hand-maintained list
 * can carry comments.
 */
export function parseImportText(text: string): { accounts: WorkBuddyPoolCredential[]; skippedLines: number } {
  const trimmed = text.trim()
  if (trimmed === '') return { accounts: [], skippedLines: 0 }
  try {
    return { accounts: accountsFromPayload(JSON.parse(trimmed)), skippedLines: 0 }
  } catch {}
  const accounts: WorkBuddyPoolCredential[] = []
  let skippedLines = 0
  for (const rawLine of trimmed.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('not JSON and not valid JSON Lines (a line failed to parse)')
    }
    const fromLine = accountsFromPayload(parsed)
    if (fromLine.length === 0) skippedLines += 1
    else accounts.push(...fromLine)
  }
  return { accounts, skippedLines }
}

/**
 * Business codes that mean "already claimed today" or "not applicable".
 *
 * Ported from the Go gateway's `cmd/signin` (`idempotentCodes`), because the
 * upstream's behaviour was measured there and re-deriving it here would only
 * invent a second, divergent answer.
 */
export const IDEMPOTENT_CODES: readonly string[] = ['10001', '14001']

/** Business-message markers with the same meaning as {@link IDEMPOTENT_CODES}. */
export const IDEMPOTENT_MARKERS: readonly string[] = [
  '今天已签到',
  '今日已签到',
  '已签到',
  'already',
  '未开启',
  '未开放',
  '已过期',
  'inactive',
]

/**
 * Markers allowed to match a *transport-level* error's text.
 *
 * The English words are excluded on purpose: `already` and `inactive` occur in
 * ordinary network failures ("address already in use", "session inactive"), and
 * treating one as a successful check-in would report an account as claimed for
 * the day when it never reached the upstream. The gateway made exactly this
 * distinction; it is kept here.
 */
export const BARE_MARKERS: readonly string[] = ['今天已签到', '今日已签到', '已签到', '未开启', '未开放', '已过期']

function isCodeWordChar(char: string): boolean {
  return /[0-9A-Za-z_]/u.test(char)
}

/** Whether `code` appears in `text` as a delimited token. */
export function hasDelimitedCode(text: string, code: string): boolean {
  for (let from = 0; from + code.length <= text.length;) {
    const at = text.indexOf(code, from)
    if (at < 0) return false
    const before = at > 0 ? text[at - 1]! : ''
    const after = at + code.length < text.length ? text[at + code.length]! : ''
    if (!isCodeWordChar(before) && !isCodeWordChar(after)) return true
    from = at + code.length
  }
  return false
}

/**
 * Classify a check-in outcome from the upstream's own words.
 *
 * `businessMessage` is the upstream's `msg`/`code` text when the failure was a
 * classified business error; `transportMessage` is only consulted when there was
 * no business message. Returns:
 *
 * - `ok` — the call succeeded.
 * - `already` — idempotent: claimed today, or the feature does not apply.
 * - `auth` — the session is dead; the account needs a human to sign in again.
 * - `failed` — anything else.
 */
export function classifyCheckinOutcome(
  businessMessage: string | undefined,
  transportMessage: string | undefined,
): WorkBuddyCheckinStatus {
  if (businessMessage === undefined) return 'ok'
  const lowered = businessMessage.toLowerCase()
  if (IDEMPOTENT_CODES.some(code => hasDelimitedCode(lowered, code))) return 'already'
  if (IDEMPOTENT_MARKERS.some(marker => lowered.includes(marker.toLowerCase()))) return 'already'
  if (transportMessage === undefined) return 'failed'
  if (BARE_MARKERS.some(marker => transportMessage.includes(marker))) return 'already'
  return 'failed'
}
