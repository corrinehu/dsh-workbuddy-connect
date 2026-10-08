/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance. The wire behavior is
 * ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoint.
 *
 * @module dsh-workbuddy-connect/upstream
 */

import { appUserAgent, resolveAppVersion, type AppVersionInfo } from './app-version.ts'
import { chatUserAgent, fallbackChatIdentity, resolveChatIdentity, type ChatIdentity } from './client-identity.ts'
import type { WorkBuddyCredential } from './auth.ts'
import type { ProbeAttempt } from './probe.ts'
import { PROBE_MAX_TOKENS, PROBE_PROMPT } from './probe.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** One CLI-usable model as the upstream catalog describes it. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  /** The upstream's preferred window before an optional maximum is selected. */
  defaultContextWindow?: number
  maxInputTokens?: number
  supportedContextWindows?: readonly number[]
  promotions?: readonly WorkBuddyPromotion[]
  maxTokens: number
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling
}

/** Reasoning metadata the upstream catalog declares for one model. */
export interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[]
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean
}

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Billing convenience metadata reported for one model. */
export interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[]
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean
  /**
   * The rate cannot be stated for this model right now.
   *
   * Set when a row that arrived with promotions attached has no promotion in
   * force: the upstream bakes the discounted value into `credits`, so the
   * cached rate describes a discount that has ended. The original price is not
   * recoverable from the row, so the plugin reports "unknown, refresh needed"
   * rather than repeating a figure it can no longer stand behind — in
   * particular it never keeps claiming the model is free.
   */
  rateUnknown?: boolean
}

/** One billing package and its remaining credit. */
export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
  /**
   * The account's cycle quota is uncapped (`limitNum === -1` on the CN
   * enterprise endpoint).
   *
   * A separate flag rather than a `-1`/`0` sentinel in {@link total}: the two
   * mean opposite things to a reader ("no limit" vs "nothing left"), and the
   * existing negative-clamp in the personal branch would turn a sentinel into
   * a plausible-looking zero. Every renderer must therefore test this flag
   * first and not fall back to `total` when it is set.
   */
  unlimited?: true
  cycleResetTime?: string
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Display name for the single synthetic row the enterprise endpoint produces.
 *
 * The endpoint reports one cycle quota, not the personal endpoint's list of
 * named packages, so the card's "by package" table has exactly one row.
 */
const enterprisePackageName = 'enterprise'

/**
 * Field names and value types of a response document, for diagnostics.
 *
 * Names and `typeof` only. This string ends up in the status route and then in
 * the browser, and the response describes the account's own usage; the values
 * themselves must never travel. Only the document and its `data` member are
 * described, so the output stays small.
 */
function describeShape(document: unknown): string {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return typeof document
  }
  const record = document as Record<string, unknown>
  const at = (source: Record<string, unknown>): string => {
    const keys = Object.keys(source).slice(0, 24)
    return keys.length === 0 ? '(empty)' : keys.map(key => `${key}:${typeof source[key]}`).join(', ')
  }
  const top = `top-level { ${at(record)} }`
  const data = record['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return top
  return `${top}; data { ${at(data as Record<string, unknown>)} }`
}

/** Shared CLI-form User-Agent for refresh and the CN catalog; chat and probe present the desktop identity (client-identity.ts). */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped: Record<string, unknown>): { reasoning: WorkBuddyModelReasoning } {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts: WorkBuddyEffort[] | undefined
  let defaultEffort: WorkBuddyEffort | undefined
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const reasoning = rawReasoning as Record<string, unknown>
    const rawEfforts = reasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter((value): value is WorkBuddyEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof reasoning['defaultEffort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['defaultEffort'] as string)) {
      defaultEffort = reasoning['defaultEffort'] as WorkBuddyEffort
    } else if (typeof reasoning['effort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['effort'] as string)) {
      defaultEffort = reasoning['effort'] as WorkBuddyEffort
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire, so the
    // conservative default is "cannot be disabled".
    canDisableThinking = reasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some catalog
 * rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // A string that is only the unit word (`credits`) carries no multiplier.
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/**
 * Parse the upstream `tags` / `credits` fields into billing metadata.
 *
 * @param wrapped - one catalog row.
 * @param extraTags - badge tags recovered from another document, merged in
 * after the row's own. The `/v3/config` product document carries the roster
 * but no `badge:*` tags; those live only in the console catalog, so the CN
 * refresh reads both and joins them here (see `fetchPromoBadges`).
 */
function resolveUpstreamBilling(
  wrapped: Record<string, unknown>,
  extraTags?: readonly string[],
): { billing: WorkBuddyModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags: readonly unknown[] = [...Array.isArray(wrapped['tags']) ? wrapped['tags'] : [], ...extraTags ?? []]
  for (const tag of rawTags) {
    if (typeof tag !== 'string') continue
    const lowered = tag.toLowerCase()
    if (!lowered.startsWith(BADGE_PREFIX)) continue
    const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
    if (label !== '' && !badges.includes(label)) badges.push(label)
  }
  // A `x0.00` multiplier means the model is currently free. Judge from the
  // normalized multiplier: the raw string may carry a trailing unit word
  // (`x0.00 credits`) that a bare-multiplier match would never see.
  const multiplier = normalizeCredits(credits)
  const free = multiplier !== undefined && /^x?0\.0+$/u.test(multiplier)
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free,
    },
  }
}

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  // A 401 is an auth failure whatever its body says: there is no business
  // meaning for it on this upstream, and the session-dead markers below are
  // only an additional signal (they also catch dead sessions answered as
  // 403). Keeping every 401 in `session_dead` preserves the `(http 401)`
  // status note the host needs to classify it as AUTH.
  if (status === 401) return 'session_dead'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Extract a user-facing error message from an upstream JSON response body.
 * Prefers WorkBuddy's localized `displayMsg.zh` / `displayMsg.en`, falling back to `msg`.
 */
export function extractDisplayErrorMessage(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const obj = parsed as Record<string, unknown>
    const displayMsg = obj['displayMsg']
    if (typeof displayMsg === 'object' && displayMsg !== null && !Array.isArray(displayMsg)) {
      const localized = displayMsg as Record<string, unknown>
      if (typeof localized['zh'] === 'string' && localized['zh'].trim() !== '') {
        return localized['zh'].trim()
      }
      if (typeof localized['en'] === 'string' && localized['en'].trim() !== '') {
        return localized['en'].trim()
      }
    }
    if (typeof obj['msg'] === 'string' && obj['msg'].trim() !== '') {
      return obj['msg'].trim()
    }
  } catch {
    // Non-JSON bodies stay undefined
  }
  return undefined
}

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * Chat request headers, including the X-No-* conventions the official CLI uses.
 *
 * `userAgent` and `clientVersion` carry the same resolved desktop identity for
 * chat and probe requests. Refresh shares `commonHeaders` but never this
 * override, so the two paths cannot drift into each other.
 */
function chatHeaders(credential: WorkBuddyCredential, userAgent: string, clientVersion: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': clientVersion,
    'X-Product': 'SaaS',
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400),
 * and rewrite `developer` messages as `system`.
 *
 * The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
 * `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
 * upstream rejects that role with HTTP 400 code 11128 ("Illegal API
 * invocation from an unapproved channel"). Rewriting to `system` is the
 * compatible spelling the upstream accepts.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
  /**
   * The whole parsed response body.
   *
   * Carried alongside `data` because the two catalog shapes differ: the CN
   * endpoint always wraps (`{code,msg,data}`), while the international
   * `/v3/config` has also been observed answering with the product document
   * bare at the top level. `data` alone cannot express "there was no wrapper,
   * the body itself is the answer".
   */
  document: Record<string, unknown>
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  const envelope: Envelope = {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
    document,
  }
  return envelope
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/** Provenance of one successful catalog fetch, surfaced by the status card. */
export interface WorkBuddyCatalogFetch {
  fetchedAtMs: number
  /** Which document answered, e.g. `workbuddy-ai:app`. */
  source: string
  /** UA version used, when the request needed one. */
  appVersion?: AppVersionInfo
}

/** Constructor dependencies. */
export interface WorkBuddyUpstreamClientOptions {
  /** App-version resolver for international catalog requests; injectable for tests. */
  resolveAppVersion?: () => Promise<AppVersionInfo>
  /**
   * Chat-identity resolver for chat and probe requests; injectable for tests.
   * Defaults to `client-identity.ts`'s per-region chain. Refresh, catalog, and
   * billing never consult it — those requests keep their long-standing headers.
   */
  resolveChatIdentity?: (region: WorkBuddyRegion) => Promise<ChatIdentity>
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 *
 * One instance is *per variant*: the international provider needs its own
 * catalog source, UA version, and probe differences, and keeping them on the
 * instance avoids passing a variant through every call signature.
 */
export class WorkBuddyUpstreamClient {
  /**
   * Resolves the App-shaped UA version for international catalog requests.
   * Injectable so tests never read the real filesystem.
   */
  private readonly resolveAppVersion: () => Promise<AppVersionInfo>
  /** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
  private readonly resolveChatIdentity: (region: WorkBuddyRegion) => Promise<ChatIdentity>

  /** Provenance of the most recent successful catalog fetch, for the card. */
  lastCatalog: WorkBuddyCatalogFetch | undefined

  constructor(options: WorkBuddyUpstreamClientOptions = {}) {
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
    this.resolveChatIdentity = options.resolveChatIdentity ?? (region => resolveChatIdentity(region))
  }

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    const region = regionOf(credential.domain)
    // Identity resolution must never block a message: any failure — a thrown
    // resolver included — degrades to the desktop fallback form (built-in
    // version, no CLI segment), never to the legacy CLI UA.
    let identity: ChatIdentity
    let userAgent: string
    try {
      identity = await this.resolveChatIdentity(region)
      userAgent = chatUserAgent(identity, region)
    } catch {
      identity = fallbackChatIdentity(region)
      userAgent = chatUserAgent(identity, region)
    }
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential, userAgent, identity.clientVersion), 'Authorization': `Bearer ${credential.accessToken}` },
        body: region === 'global' ? prepareInternationalChatBody(bodyJson) : prepareCnChatBody(bodyJson),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * GET the personal model catalog.
   *
   * Both variants read `/v3/config`, the product document the desktop product
   * itself fetches. CN used to read `/console/enterprises/personal/models`
   * (the console catalog) instead, and that was why its model list drifted
   * from the desktop App's selector: the console document lags the product
   * one, and the product roster itself churns day to day (`auto`,
   * `kimi-k3-1`, `minimax-m3` have each appeared and disappeared within a
   * week).
   *
   * What distinguishes the two variants here is the User-Agent, not the path:
   * the gateway splits `/v3/config` by client identity, and the split is
   * load-bearing. A CLI-shaped UA yields the CLI's roster — the chat models
   * this plugin serves — while an App-shaped UA yields the App's internal
   * roster. CN keeps the CLI UA it sends for chat, so the catalog it
   * advertises is exactly the one its own requests can use. The international
   * variant has no CLI identity, so it keeps the App-shaped UA.
   *
   * Membership is the `cli` roster intersected with the usable rows (see
   * {@link parseModelCatalog}); the promo badges the product document does
   * not carry are merged in from a best-effort console read — see
   * {@link fetchPromoBadges}.
   *
   * Responses are unwrapped and classified the same way — `readEnvelope` plus
   * `envelopeError` — so an expired session or exhausted credit is reported as
   * such rather than as a generic catalog failure.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const international = regionOf(credential.domain) === 'global'
    // `this.resolveAppVersion`, not the module-level function: the constructor
    // injects a resolver so tests never read the real filesystem, and calling
    // the module function directly made that seam inert.
    const appVersion = international ? await this.resolveAppVersion() : undefined
    const response = await fetch(`${chatBase(credential)}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
        'User-Agent': appVersion === undefined ? CLIENT_UA : appUserAgent(appVersion.version),
      },
      signal: signal === undefined
        ? AbortSignal.timeout(JSON_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // Two catalog shapes share this path. The endpoints wrap their answer in
    // `{code,msg,data}`, but `/v3/config` has also been observed answering with
    // the product document bare at the top level (no wrapper at all). Treating
    // a missing `data` as an empty document turned that second shape into a
    // spurious "no cli agent models", so a body that itself looks like a
    // catalog (it carries models or agents) is used as the answer. A body with
    // neither shape still falls through to the empty-parse error below.
    const data = isObject(envelope.data) ? envelope.data
      : 'models' in envelope.document || 'agents' in envelope.document ? envelope.document
      : {}
    // Promo badges exist only in the console document, so CN merges them in.
    // The read is best-effort and separate: its failure costs the badges and
    // never the catalog.
    const promoBadges = international ? undefined : await this.fetchPromoBadges(credential, signal)
    const models = parseModelCatalog(data, international, promoBadges)
    this.lastCatalog = {
      fetchedAtMs: Date.now(),
      source: international ? 'workbuddy-ai:app' : 'workbuddy:cli',
      ...appVersion === undefined ? {} : { appVersion },
    }
    return models
  }

  /**
   * Read the console catalog's promotional tags, by model id.
   *
   * `/v3/config` carries no `badge:<label>:<color>` tags — the discount labels
   * the cards render (`限时免费`, `夜间折扣`, …) live only in
   * `/console/enterprises/personal/models`. Since the roster now comes from
   * the product document, those tags are read from the console one in a
   * second request and merged by id.
   *
   * Best-effort by construction: a badge is a label on a price, so failing to
   * read this document must not fail a catalog refresh. Every failure —
   * network, envelope, an unreadable body — returns undefined, and the models
   * simply ship without badges.
   */
  private async fetchPromoBadges(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
    try {
      const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: 'application/json',
          Origin: originReferer(credential),
          Referer: `${originReferer(credential)}/`,
          'User-Agent': CLIENT_UA,
        },
        signal: signal === undefined
          ? AbortSignal.timeout(JSON_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
      })
      if (!response.ok) return undefined
      const envelope = await readEnvelope(response)
      const data = isObject(envelope.data) ? envelope.data : envelope.document
      const rawModels = Array.isArray(data['models']) ? data['models'] : []
      const badges = new Map<string, readonly string[]>()
      for (const model of rawModels) {
        if (!isObject(model)) continue
        const id = typeof model['id'] === 'string' ? model['id'] : ''
        if (id === '') continue
        const tags = Array.isArray(model['tags'])
          ? model['tags'].filter((tag): tag is string =>
            typeof tag === 'string' && tag.toLowerCase().startsWith(BADGE_PREFIX))
          : []
        if (tags.length > 0) badges.set(id, tags)
      }
      return badges.size === 0 ? undefined : badges
    } catch {
      return undefined
    }
  }

  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * Two upstream shapes, chosen by account type:
   *
   * - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
   *   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
   *   cycle quota. The personal endpoint serves these accounts an empty
   *   `Accounts` list, which the card then renders as "0 credit" — a wrong
   *   number rather than a visible failure (issue #31).
   * - **Everyone else** keeps the personal endpoint unchanged.
   *
   * The region gate is load-bearing: the enterprise endpoint is unverified for
   * the global region, so an international credential that happens to carry an
   * `enterpriseId` must stay on the measured personal path instead of being
   * moved onto an unmeasured one.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    if (regionOf(credential.domain) === 'cn'
      && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      return await this.fetchEnterpriseCredits(credential)
    }
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
    const accounts: WorkBuddyCreditAccount[] = []
    let total = 0
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const size = numberField('CycleCapacitySize')
      const cycleRemain = numberField('CycleCapacityRemain')
      const cycleUsed = numberField('CycleCapacityUsed')
      const capacityRemain = numberField('CapacityRemain')
      let remain: number
      if (size > 0) remain = cycleRemain
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
      else remain = capacityRemain
      if (remain < 0) remain = 0
      total += remain
      accounts.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain,
        size: size > 0 ? size : numberField('CapacitySize'),
      })
    }
    return { total, accounts }
  }

  /**
   * CN enterprise credit read: a single cycle quota instead of a package list.
   *
   * Verified against the WorkBuddy desktop app (`app.asar`,
   * `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
   * body is an empty object and the account identity travels only in the
   * headers. The two official call sites disagree on the field spelling
   * (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
   *
   * A body carrying no recognisable quota field is a hard error rather than a
   * zero. Rendering `0` for "we did not understand the answer" is exactly how
   * issue #31 stayed invisible while users saw a plausible wrong number.
   *
   * The error names fields and types only: it reaches the browser, and the
   * response body may describe the account's usage.
   */
  private async fetchEnterpriseCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // The official reader accepts the payload at `data.data`, `data`, or the
    // envelope itself; the observed CN answer puts the fields at `data`.
    const sources: Record<string, unknown>[] = []
    for (const candidate of [envelope.data, envelope.document]) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      if (typeof record['data'] === 'object' && record['data'] !== null && !Array.isArray(record['data'])) {
        sources.push(record['data'] as Record<string, unknown>)
      }
      sources.push(record)
    }
    const numberAt = (source: Record<string, unknown>, key: string): number | undefined =>
      typeof source[key] === 'number' ? source[key] as number : undefined
    let limit: number | undefined
    let used: number | undefined
    let resetTime: string | undefined
    for (const source of sources) {
      const candidate = numberAt(source, 'limitNum') ?? numberAt(source, 'limit_num')
      if (candidate === undefined) continue
      limit = candidate
      used = numberAt(source, 'credit') ?? numberAt(source, 'used_num')
      if (typeof source['cycleResetTime'] === 'string' && source['cycleResetTime'] !== '') {
        resetTime = source['cycleResetTime'] as string
      }
      break
    }
    if (limit === undefined) {
      throw new Error(`workbuddy enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num; received ${describeShape(envelope.document)})`)
    }
    // `-1` is the upstream's "no cap" marker, not a balance. Carried as an
    // explicit flag so no renderer can mistake it for a number. The used amount
    // is not part of an uncapped reading.
    if (limit === -1) {
      return {
        total: 0,
        accounts: [{ packageName: enterprisePackageName, remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...resetTime === undefined ? {} : { cycleResetTime: resetTime },
      }
    }
    // A limit with no usable amount must fail rather than assume zero used.
    // Defaulting to 0 would render a confident "full quota remaining" from a
    // response we could not read — the same species of wrong-but-plausible
    // number as the bug this branch exists to fix.
    if (used === undefined) {
      throw new Error(`workbuddy enterprise billing response carried a quota limit but no recognised usage field (expected credit/used_num alongside limitNum/limit_num; received ${describeShape(envelope.document)})`)
    }
    let remain = limit - used
    if (remain < 0) remain = 0
    return {
      total: remain,
      accounts: [{ packageName: enterprisePackageName, remain, size: limit }],
      ...resetTime === undefined ? {} : { cycleResetTime: resetTime },
    }
  }


  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares `chatHeaders` with the normal chat path on purpose — the plan
   * forbids probing through anything but the plugin's own credential handling,
   * so a result describes what a real message would experience.
   *
   * The caller aborts as soon as a parseable event arrives; the body is never
   * assembled into an answer. `reasoning_effort` is omitted entirely (rather
   * than sent empty) when `effort` is undefined, so the baseline case is a
   * genuinely bare request.
   *
   * Two international differences, both measured on 2026-09-11:
   *
   * - The gateway requires a leading `system` message (400/11128 otherwise), so
   *   one is prepended for the global region only.
   * - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
   *   with 400/11133 `integer_below_min_value`), so the international probe asks
   *   for a slightly larger minimum. This is a floor the plugin must clear, not
   *   evidence about any model's effort support: a model still refusing that
   *   minimum is reported as an incompatible request, never as "effort
   *   unsupported", and the ceiling is never raised further to force an answer.
   */
  async probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const international = regionOf(credential.domain) === 'global'
    // Same identity rule as the chat path — chat and its probe sibling must
    // never present two different clients, and a thrown resolver degrades to
    // the desktop fallback form exactly as in `chatStream`.
    let identity: ChatIdentity
    let userAgent: string
    try {
      identity = await this.resolveChatIdentity(international ? 'global' : 'cn')
      userAgent = chatUserAgent(identity, international ? 'global' : 'cn')
    } catch {
      identity = fallbackChatIdentity(international ? 'global' : 'cn')
      userAgent = chatUserAgent(identity, international ? 'global' : 'cn')
    }
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        ...international ? [{ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT }] : [],
        { role: 'user', content: PROBE_PROMPT },
      ],
      max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential, userAgent, identity.clientVersion), 'Authorization': `Bearer ${credential.accessToken}` },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }

    // Read until the first parseable event, then hang up: the probe wants the
    // acceptance signal, not a completion.
    const streamed = await readFirstEvent(response)
    return { status: response.status, streamed }
  }
}

/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text: string): { errorCode?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const wrapped = parsed as Record<string, unknown>
      const extError = wrapped['extError']
      if (typeof extError === 'object' && extError !== null && !Array.isArray(extError)) {
        const code = (extError as Record<string, unknown>)['code']
        if (typeof code === 'string') return { errorCode: code, detail: code }
      }
    }
  } catch {
    // Not JSON: fall through to a plain detail line.
  }
  return { detail: text.slice(0, 200) }
}

/**
 * Consume just enough of a streaming response to know it really streams.
 *
 * Returns true on the first chunk containing a data line. Cancels the body
 * afterwards; a stream that ends or errors before that counts as not streamed,
 * because an empty 200 is not evidence the effort was accepted.
 */
async function readFirstEvent(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      const text = decoder.decode(value, { stream: true })
      if (text.includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
/**
 * Parse either response shape after its envelope has been checked.
 *
 * Membership is the `cli` agent's roster, intersected with the rows that are
 * usable: the roster is what the client identity this plugin presents is
 * allowed to chat with, and joining rather than trusting it outright drops
 * both ids the roster has retired and rows the document lists but cannot
 * serve (no row, `disabled: true`, or non-positive caps all drop out here —
 * a published-but-unservable id must never reach the picker).
 *
 * @param data - the unwrapped catalog/product document.
 * @param international - whether it is the international product document, whose
 * rows carry window objects and promotions.
 * @param promoBadges - badge tags by model id, read from the console document,
 * which is the only one that carries them.
 */
export function parseModelCatalog(
  data: Record<string, unknown>,
  international = false,
  promoBadges?: ReadonlyMap<string, readonly string[]>,
): readonly WorkBuddyUpstreamModel[] {
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    if (cliIds === undefined || cliIds.length === 0) {
      throw new Error('workbuddy model catalog lists no cli agent models')
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      if (typeof model !== 'object' || model === null) continue
      const wrapped = model as Record<string, unknown>
      const id = typeof wrapped['id'] === 'string' ? wrapped['id'] : ''
      if (id === '' || wrapped['disabled'] === true) continue
      const input = typeof wrapped['maxInputTokens'] === 'number' ? wrapped['maxInputTokens'] : 0
      const output = typeof wrapped['maxOutputTokens'] === 'number' ? wrapped['maxOutputTokens'] : 0
      if (input <= 0 || output <= 0) continue
      byId.set(id, {
        id,
        name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
        contextWindow: international && isObject(wrapped['contextWindow']) && positive(wrapped['contextWindow']['defaultLength'])
          ? wrapped['contextWindow']['defaultLength'] : input,
        ...(international ? {
          ...isObject(wrapped['contextWindow']) && positive(wrapped['contextWindow']['defaultLength'])
            ? { defaultContextWindow: wrapped['contextWindow']['defaultLength'] } : {},
          maxInputTokens: input,
          supportedContextWindows: isObject(wrapped['contextWindow']) && Array.isArray(wrapped['contextWindow']['supportedLengths'])
            ? wrapped['contextWindow']['supportedLengths'].filter(positive) : [],
          promotions: parsePromotions(data['modelPromotions'], id),
        } : {}),
        maxTokens: output,
        supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
        ...resolveUpstreamReasoning(wrapped),
        ...resolveUpstreamBilling(wrapped, promoBadges?.get(id)),
      })
    }
    const models = cliIds
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
    return models
}

/**
 * One verified promotion entry.
 *
 * Only the shape actually observed in the international App document is
 * modelled — an enabled, time-boxed, `displayMode: "replace"` discount. An
 * entry that does not match is dropped rather than guessed at: rendering a
 * discount the plugin does not understand could understate what the user pays.
 */
export interface WorkBuddyPromotion {
  /** Window start, epoch ms, parsed from the document's offset timestamp. */
  start: number
  /** Window end, epoch ms. */
  end: number
  /** Badge text as the upstream wrote it, e.g. `Free now`. */
  label: string
  /** Multiplier applied to the model's rate; `0` replaces it outright. */
  factor: number
  /** Higher wins when several promotions cover one model. */
  priority: number
}

/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value: unknown, model: string): WorkBuddyPromotion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isObject(item) || item['enabled'] !== true) return []
    const modelIds = item['modelIds']
    if (!Array.isArray(modelIds) || !modelIds.includes(model)) return []
    const schedule = item['schedule']
    const discount = item['discount']
    const badge = item['badge']
    if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return []
    // Only a replacement discount has an unambiguous display rule; any other
    // display mode is left to the upstream's own client.
    if (discount['displayMode'] !== 'replace') return []
    const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : Number.NaN
    const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : Number.NaN
    const factor = discount['factor']
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return []
    return [{
      start,
      end,
      factor,
      label: typeof badge['label'] === 'string' ? badge['label'] : '',
      priority: typeof item['priority'] === 'number' && Number.isFinite(item['priority']) ? item['priority'] : 0,
    }]
  })
}

/**
 * Re-evaluate a model's promotion against the current time.
 *
 * Promotions are time-boxed, and the catalog they arrive in is cached for the
 * life of the process. Frozen at parse time, a cached "Free now" would keep
 * claiming a discount after `validUntil` had passed, and would keep showing the
 * pre-discount rate as the discounted one. Re-deriving on every read means the
 * badge disappears on its own and the rate reverts, with no refresh needed.
 *
 * Non-destructive: the model's own `credits` and `badges` are the base, and the
 * promotion is layered onto a copy. A model with no live promotion is returned
 * as-is, so the common case allocates nothing.
 */
export function modelWithCurrentPromotion(model: WorkBuddyUpstreamModel, now = Date.now()): WorkBuddyUpstreamModel {
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    // This row arrives with promotions attached, but none is in force now. The
    // catalog is cached for the process's life, so the rate baked into the row
    // was read while a promotion *was* active — the upstream writes the
    // discounted value into `credits` itself (the international document's
    // free models ship `credits: "x0.00"`). Keeping that value would advertise
    // a discount that has ended, and `free: true` is the worst case of it: the
    // user would be told a model costs nothing when it does not.
    //
    // The original price is not recoverable from this row, so the honest answer
    // is to stop asserting one: the rate is dropped and any promo badge
    // removed. `rateUnknown` marks it so the card can say the price needs a
    // refresh rather than implying the model is free.
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    return {
      ...model,
      billing: {
        free: false,
        rateUnknown: true,
      },
    }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  // A replacement to zero is meaningful even when the base rate is unknown (the
  // App document's Auto row carries an empty rate string); any other multiplier
  // needs a number to scale, so it is skipped rather than invented.
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: [
        ...(model.billing?.badges ?? []),
        ...promotion.label === '' ? [] : [promotion.label],
      ],
    },
  }
}
/**
 * Apply the international endpoint's extra chat requirement: the first message
 * must be a system prompt.
 *
 * The international gateway rejects a body whose first message is not `system`
 * with HTTP 400 code 11128 ("first message is not system prompt"). Note that
 * the *same* code means something else on the CN endpoint — there it reports a
 * rejected `developer` role — so the two are never branched on by code alone.
 *
 * The added prompt is deliberately empty of user content and prepended, never
 * merged: existing messages keep their order and wording. A body that is not a
 * JSON object is returned unchanged, exactly as {@link prepareChatBody} does,
 * so this is safe to run over an already-prepared-or-not body.
 */
/**
 * Prepare a body for the **CN** endpoint.
 *
 * Until #87 the CN wire was the caller's body verbatim. The only difference
 * now is the shared {@link dropUnsupportedEffort} strip, whose region scope was
 * lifted once measurements showed this endpoint rejects `off` too.
 *
 * Deliberately **not** routed through {@link prepareChatBody}: the shim already
 * applies it before handing the body to {@link WorkBuddyUpstreamClient.chatStream},
 * and re-running it would be a second `stream`/`developer`/`tool_choice`
 * normalisation of an already-normalised body. Only the strip belongs here.
 *
 * A body that is not a JSON object is returned unchanged, so this is safe to
 * run over an already-prepared-or-not body.
 */
export function prepareCnChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    // Not JSON: nothing to strip, and the upstream will reject it anyway.
    return source
  }
  if (!isObject(body)) return source
  dropUnsupportedEffort(body)
  return JSON.stringify(body)
}

export function prepareInternationalChatBody(source: string): string {
  const prepared = prepareChatBody(source)
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    // Not JSON: nothing to prepend to, and the upstream will reject it anyway.
    return prepared
  }
  if (!isObject(body)) return prepared
  // Shared with the CN path since #87: both endpoints reject the adapter's own
  // `off` spelling, so the strip is no longer region-scoped.
  dropUnsupportedEffort(body)
  const messages = body['messages']
  if (!Array.isArray(messages)) return JSON.stringify(body)
  const first = messages[0]
  if (isObject(first) && first['role'] === 'system') return JSON.stringify(body)
  // Unshift, so every caller-supplied message keeps its position and content.
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
}

/**
 * Remove the adapter's own `off` effort spelling from the wire, on every region.
 *
 * `thinkingLevelMap.off` is pinned to the literal `'off'` for models that
 * declare `canDisableThinking`, so that the level stays selectable. pi-ai
 * sends that value for any request carrying no explicit level — which is why
 * this covers **Default and Off alike**: the two produce the same body, so a
 * fix that only removed the menu entry would leave Default failing.
 *
 * Both endpoints reject it, which is why this is no longer region-scoped
 * (#87): the international GPT family answers HTTP 400 `11133` /
 * `extError.param === 'reasoning.effort'` (issue #49), and the CN endpoint
 * rejects it on models that declare `onlyReasoning` — measured on
 * `deepseek-v4.1-flash` with 400 / `11150`, while `low`/`high`/`max` pass
 * (issue #87). Omission is the only form measured good on every such model; a
 * literal `'none'` is *not* a safe substitute — accepted by the GPT-5.6 family
 * and GLM, rejected by `gpt-6-astra`.
 *
 * Consequences, stated honestly: the picker still offers Off for models where
 * the upstream declares `canDisableThinking`, but selecting it now means "the
 * field is omitted" — the model's actual behaviour is decided upstream and is
 * *not* guaranteed to disable thinking or to match the catalog's
 * `defaultEffort`. Declared spellings (`low`/`medium`/`high`/`xhigh`/`max`)
 * and an explicit `none` pass through untouched.
 *
 * The CN strip replaces a scope decision whose premise did not hold: the
 * earlier note here said that endpoint "has accepted this spelling in every
 * measurement so far". Measurements since (#87) show it rejects `off` on
 * validating models — the earlier runs had simply not hit one.
 */
function dropUnsupportedEffort(obj: Record<string, unknown>): void {
  if (obj['reasoning_effort'] === 'off') delete obj['reasoning_effort']
}

/**
 * The system prompt injected when the international endpoint receives a body
 * with none.
 *
 * Minimal on purpose: it exists to satisfy a gateway precondition, not to
 * steer the model. The plugin is not the place to invent a persona, and the
 * normal path never reaches this — pi-ai already sends the harness's system
 * prompt, so this only covers a caller that omitted one.
 */
const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * Output ceiling for an international probe request.
 *
 * Above the smallest value that the strictest observed model accepts (the
 * GPT-5.6 family rejects `1` with 11133), while still being far too small to
 * produce a real answer. See {@link WorkBuddyUpstreamClient.probeEffort}.
 */
const INTERNATIONAL_PROBE_MAX_TOKENS = 16
