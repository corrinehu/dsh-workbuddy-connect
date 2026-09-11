/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance. The wire behavior is
 * ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoint.
 *
 * @module dsh-workbuddy-connect/upstream
 */

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
}

/** One billing package and its remaining credit. */
export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
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

/** User-Agent of the official CLI. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** User-Agent of the desktop app; see {@link RegionWire.modelsUserAgent}. */
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'WorkBuddyAI/5.5.2 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36'

/**
 * Per-region wire shape. The two sites are separate services rather than
 * mirrors of one another: they agree on the chat path but disagree on where
 * the personal model catalog and billing live, and the billing endpoints
 * answer with different documents.
 */
interface RegionWire {
  /** Origin serving chat, the model catalog, and token refresh. */
  chatBase: string
  /** Origin serving billing; also the Origin/Referer sent with chat. */
  billingBase: string
  /** Chat completions path. Identical on both sites today. */
  chatPath: string
  /** Token refresh path. */
  refreshPath: string
  /** Personal model catalog path. */
  modelsPath: string
  /**
   * User-Agent to send with the catalog request. The global site picks the
   * catalog document from it: the desktop app's UA answers the current product
   * catalog, while the CLI's UA answers an older base one that is missing
   * models added since. Omitted where the CLI agent string is the right one.
   */
  modelsUserAgent?: string
  /** Billing path, paired with {@link RegionWire.billingFlavor}. */
  billingPath: string
  /** Which billing document {@link RegionWire.billingPath} answers with. */
  billingFlavor: 'legacy' | 'summary'
}

/**
 * China wire. Billing answers `get-user-resource` with the nested
 * `data.Response.Data.Accounts` document, whose capacity fields are numbers.
 */
const CN_WIRE: RegionWire = {
  chatBase: 'https://copilot.tencent.com',
  billingBase: 'https://www.codebuddy.cn',
  chatPath: '/v2/chat/completions',
  refreshPath: '/v2/plugin/auth/token/refresh',
  modelsPath: '/console/enterprises/personal/models',
  billingPath: '/v2/billing/meter/get-user-resource',
  billingFlavor: 'legacy',
}

/**
 * Global wire. The catalog is the desktop app's product document, which has to
 * be requested with that app's User-Agent, token refresh dropped the `plugin`
 * segment, and billing answers `get-user-resource-summary` with a flat
 * `data.Packages` list whose capacities arrive as **strings**.
 */
const GLOBAL_WIRE: RegionWire = {
  chatBase: 'https://www.workbuddy.ai',
  billingBase: 'https://www.workbuddy.ai',
  chatPath: '/v2/chat/completions',
  refreshPath: '/v2/auth/token/refresh',
  modelsPath: '/v3/config',
  modelsUserAgent: APP_UA,
  billingPath: '/billing/meter/get-user-resource-summary',
  billingFlavor: 'summary',
}
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
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

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped: Record<string, unknown>): { billing: WorkBuddyModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags = wrapped['tags']
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string') continue
      const lowered = tag.toLowerCase()
      if (!lowered.startsWith(BADGE_PREFIX)) continue
      const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
      if (label !== '') badges.push(label)
    }
  }
  // A `x0.00` multiplier means the model is currently free.
  const free = credits !== undefined && /^x?0\.0+$/u.test(credits)
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

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

/** Wire descriptor for the region a credential belongs to. */
function wireOf(credential: WorkBuddyCredential): RegionWire {
  return regionOf(credential.domain) === 'global' ? GLOBAL_WIRE : CN_WIRE
}

function chatBase(credential: WorkBuddyCredential): string {
  return wireOf(credential).chatBase
}

function billingBase(credential: WorkBuddyCredential): string {
  return wireOf(credential).billingBase
}

function originReferer(credential: WorkBuddyCredential): string {
  return wireOf(credential).billingBase
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

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
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
   * The parsed document as-is. Most endpoints wrap their payload in `data`,
   * but some (the global product catalog) are the payload.
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
  if (typeof parsed !== 'object' || parsed === null) {
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

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}${wireOf(credential).chatPath}`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
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
    const response = await fetch(`${chatBase(credential)}${wireOf(credential).refreshPath}`, {
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

  /** GET the personal model catalog and keep the `cli` agent's models only. */
  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    const wire = wireOf(credential)
    const response = await fetch(`${chatBase(credential)}${wire.modelsPath}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': wire.modelsUserAgent ?? CLIENT_UA,
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // China wraps the catalog in `data`; the global product document is the
    // catalog, with `models` and `agents` at its top level.
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : envelope.document
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
        contextWindow: input,
        maxTokens: output,
        supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
        ...resolveUpstreamReasoning(wrapped),
        ...resolveUpstreamBilling(wrapped),
      })
    }
    const models = cliIds
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
    return models
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const wire = wireOf(credential)
    if (wire.billingFlavor === 'summary') return this.fetchCreditsSummary(credential, wire)
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
    const response = await fetch(`${wire.billingBase}${wire.billingPath}`, {
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
   * Billing for the global wire: a flat `data.Packages` list whose capacity
   * fields are strings ("250"), with no friendly package name - only the
   * internal `PackageCode`.
   */
  private async fetchCreditsSummary(
    credential: WorkBuddyCredential,
    wire: RegionWire,
  ): Promise<WorkBuddyCredits> {
    const response = await fetch(`${wire.billingBase}${wire.billingPath}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawPackages = Array.isArray(data['Packages']) ? data['Packages'] : []
    const accounts: WorkBuddyCreditAccount[] = []
    let total = 0
    for (const raw of rawPackages) {
      if (typeof raw !== 'object' || raw === null) continue
      const wrapped = raw as Record<string, unknown>
      const numberField = (key: string): number => {
        const value = wrapped[key]
        if (typeof value === 'number') return value
        if (typeof value === 'string') {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : 0
        }
        return 0
      }
      const size = numberField('CycleTotalCapacity')
      let remain = numberField('CycleRemainCapacity')
      if (remain < 0) remain = 0
      total += remain
      accounts.push({
        packageName: typeof wrapped['PackageCode'] === 'string' && wrapped['PackageCode'] !== ''
          ? wrapped['PackageCode']
          : '(unnamed)',
        remain,
        size: size > 0 ? size : 0,
      })
    }
    return { total, accounts }
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
   */
  async probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}${wireOf(credential).chatPath}`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
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
