/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance.
 *
 * Two sources shape the wire behavior. Response handling and the request
 * *shape* come from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoint. The request *headers* — above all
 * the client-identity tuple a credit ledger attributes a request by (使用端) —
 * come from the installed official desktop client:
 * `docs/workbuddy-client-wire-contract.md` is the byte-verified contract, and
 * every value chosen below cites the block id it was read from. Where that
 * contract marks a value unknown, the header is left out rather than guessed.
 *
 * @module dsh-workbuddy-connect/upstream
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  FALLBACK_APP_VERSION,
  appUserAgent,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  type AppVersionInfo,
} from './app-version.ts'
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

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * User-Agent for the **CN model catalog** endpoint only.
 *
 * Not the chat UA — the chat request carries the official client's own
 * User-Agent (§3), never this literal. This endpoint
 * (`/console/enterprises/personal/models`) is the plugin's own path, not one
 * the official CLI uses (the string occurs 0 times in its bundle), and the
 * gateway's User-Agent gate there is unmeasured. The value is therefore left
 * exactly as the plugin has always sent it: changing the UA on the request
 * that *decides which models are exposed* is a catalog change, not a
 * wire-identity change.
 */
const CN_CATALOG_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/* -------------------------------------------------------------------------- *
 * Installed-client identity
 *
 * The official desktop client spawns its bundled agent CLI, which labels every
 * model request with a fixed identity tuple (§2.2) and a composed User-Agent
 * (§3). Those are the fields the credit ledger reads, so they must be derived
 * from the client actually installed here rather than hardcoded — and where
 * the contract marks a value unknown, the field is omitted.
 * -------------------------------------------------------------------------- */

/**
 * The platform/product token the desktop client injects (`WORKBUDDY_PLATFORM`,
 * `CLIENT_INFO_PLATFORM` and `CLIENT_INFO_IDE_TYPE` in B15) and the banner
 * endpoint repeats (B17). Byte-confirmed for the CN desktop; used for both
 * regions because no region-specific spelling is established for the chat path
 * — the contract leaves the region-dependent identity values unknown (§7).
 */
const CLIENT_PRODUCT = 'WorkBuddy'

/**
 * `X-Agent-Intent` when the session has no `codebuddy.ai/mode` meta (B1).
 *
 * The plugin's own request carries no session mode — the shim hands the
 * upstream seam an OpenAI body and nothing else — so the official default is
 * the only derivable value.
 */
const AGENT_INTENT_DEFAULT = 'craft'

/** `X-Agent-Type` for a request that is neither a subagent nor a team member (B3, B27). */
const AGENT_TYPE_MAIN = 'main'

/** Deployment type the official client reports on CN (`deploymentType ?? "SaaS"`, B11). */
const PRODUCT_SAAS = 'SaaS'

/** `X-Auth-Refresh-Source` on the token-refresh call (B9, contract §4). */
const REFRESH_SOURCE = 'plugin'

/** `cli/package.json` inside the installed App bundle, relative to the bundle root. */
const CLI_PACKAGE_PATH = ['Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json'] as const

/**
 * Installed desktop-client versions the outbound identity is built from.
 *
 * `appVersion` is the desktop App version (B15's `CLIENT_INFO_PLATFORM_VERSION`
 * = what B2 falls back to for `X-IDE-Version`); `cliVersion` is the bundled
 * agent CLI's own version, the `CLI/<version>` token of the User-Agent (§3).
 */
export interface WorkBuddyClientIdentity {
  /** Desktop App version; drives `X-IDE-Version` and both UA version tokens. */
  appVersion: string
  /** Bundled agent-CLI version; omitted from the UA when unresolvable (§3). */
  cliVersion?: string
}

/** Whether a value is a version the App or CLI could legitimately report. */
function validCliVersion(value: unknown): value is string {
  // A version reaches a header, so it may not carry a space, CR or LF; the
  // upstream's own scheme allows a prerelease suffix (`2.137.1-rc.1`).
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/** Clamp an identity to header-safe values, degrading to the shared fallback. */
function normalizeIdentity(identity: WorkBuddyClientIdentity): WorkBuddyClientIdentity {
  const appVersion = validAppVersion(identity.appVersion) ? identity.appVersion : FALLBACK_APP_VERSION
  return validCliVersion(identity.cliVersion) ? { appVersion, cliVersion: identity.cliVersion } : { appVersion }
}

/**
 * The official User-Agent (§3, block B8):
 *
 * ```
 * <platform>/<platformVersion> <productName>/<productVersion> CLI/<cliVersion>
 * ```
 *
 * With the desktop-spawned inputs of B15 this is
 * `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`. The trailing `CLI/…` token is
 * dropped when no CLI version resolves — the official rule, not a fallback of
 * this plugin's own: `buildUserAgent` pushes the extension only when
 * `CLIENT_INFO_USER_AGENT_EXTENSION` is present (§3).
 */
export function clientUserAgent(identity: WorkBuddyClientIdentity): string {
  const parts = [`${CLIENT_PRODUCT}/${identity.appVersion}`, `${CLIENT_PRODUCT}/${identity.appVersion}`]
  if (validCliVersion(identity.cliVersion)) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/** macOS App-bundle roots, searched in the same order `app-version.ts` uses. */
function macAppRoots(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

/**
 * Cache file for the **CN** desktop App's version.
 *
 * Deliberately not `app-version.ts`'s `.workbuddy-ai-version.json`: that file
 * belongs to the international catalog path, and letting a CN App write its
 * version into it would relabel the international request's User-Agent — the
 * same reason one catalog file per variant exists. The name follows that
 * file's convention.
 */
function cnAppVersionPath(): string {
  return join(resolveDshHome(), '.workbuddy-app-version.json')
}

/** Bundle name of the desktop client that issues a region's requests. */
function desktopBundleName(region: WorkBuddyRegion): string {
  return region === 'global' ? 'WorkBuddy AI.app' : 'WorkBuddy.app'
}

/**
 * The installed desktop bundle for a region, or `undefined` when it is not
 * installed (or not readable).
 *
 * This is the *location* only: the version is still resolved by
 * `app-version.ts`'s `resolveAppVersion`, whose `installed` reader is its
 * documented injection point, so the whole installed → saved → fallback chain
 * (and its best-effort cache write) stays in one module. The default reader
 * there is pinned to the international `WorkBuddy AI.app`, which is not the
 * client that issues a CN chat request, and that is the one thing that has to
 * be supplied from here.
 *
 * Windows and Linux report `undefined` for the same reason `app-version.ts`
 * does: no verified bundle-metadata location exists there yet.
 */
async function installedDesktopBundle(region: WorkBuddyRegion): Promise<{ version: string; bundle: string } | undefined> {
  if (process.platform !== 'darwin') return undefined
  for (const root of macAppRoots()) {
    const bundle = join(root, desktopBundleName(region))
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) return { version, bundle }
  }
  return undefined
}

/**
 * The bundled agent CLI's real version, or `undefined` when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` and the real
 * version in `publishConfig.customPackage.version` (contract §1); the official
 * resolver prefers `version` but falls back to the custom package (§3.3).
 * Unreadable or placeholder-only metadata yields `undefined`, which drops the
 * `CLI/…` UA token instead of inventing a version (§3 degradation).
 */
async function readBundledCliVersion(bundle: string): Promise<string | undefined> {
  let document: unknown
  try {
    document = JSON.parse(await readFile(join(bundle, ...CLI_PACKAGE_PATH), 'utf8'))
  } catch {
    return undefined
  }
  if (!isObject(document)) return undefined
  const publishConfig = document['publishConfig']
  const customPackage = isObject(publishConfig) ? publishConfig['customPackage'] : undefined
  const customVersion = isObject(customPackage) ? customPackage['version'] : undefined
  const declared = document['version']
  const version = typeof declared === 'string' && declared !== '' && declared !== '0.0.0' ? declared : customVersion
  return validCliVersion(version) ? version : undefined
}

/**
 * A fresh request id: a UUID v4 with the dashes stripped.
 *
 * That is the exact shape the official client mints for `X-Request-ID`,
 * `X-Conversation-Message-ID` (B26) and `X-Conversation-Request-ID` (§2.3, the
 * session's request id re-minted for every run).
 */
function freshRequestId(): string {
  return randomUUID().replaceAll('-', '')
}

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

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/**
 * Refresh-endpoint headers; `X-Refresh-Token` appears here and nowhere else.
 *
 * The official refresh call (B9) carries the refresh token, the refresh source
 * and the same interceptor-provided headers every other request gets — no
 * `Origin`, `Referer` or `X-Requested-With` (§2.4), which is why they are no
 * longer sent here either.
 */
function refreshHeaders(credential: WorkBuddyCredential, identity: WorkBuddyClientIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': clientUserAgent(identity),
    'X-Refresh-Token': credential.refreshToken,
    // B9 / §4: the official refresh path sends `plugin`; the plugin used to
    // send `workbuddy`, a value that appears nowhere in the official client.
    'X-Auth-Refresh-Source': REFRESH_SOURCE,
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/**
 * Chat-request headers: the header set the official model request carries
 * (§2.2), and none of the headers §2.4 establishes it does not.
 *
 * The request ids are minted per call. The official client derives them from a
 * session it owns (`ew.id`, `session.conversationRequestId`), and the plugin
 * has no session at this seam: `chatStream` receives an OpenAI body and a
 * credential, nothing that marks a conversation boundary. Rather than fake a
 * stable conversation, every request is its own single-turn session — the
 * official minting rule when a session has no id yet (§2.3), applied per
 * request.
 *
 * Deliberately absent, each for a reason read from the contract:
 *
 * - `X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info`: the
 *   official chat path never sends them (§2.4). They are suppressor markers the
 *   auth interceptor *reads* (B6); an absent id is expressed by omitting the
 *   field, not by announcing the omission.
 * - `X-Department-Info`: sent only when the account carries a
 *   `departmentFullName` (B6), which the plugin's credential does not model.
 * - `X-Requested-With`, `Origin`, `Referer`: the CLI is a Node process and adds
 *   none of them (§2.4).
 * - `X-Root-Request-ID`, `X-Parent-Conversation-ID`, `X-Agent-Purpose`,
 *   `X-Stainless-*`: conditional on state the plugin does not have, or SDK
 *   internals that are not client identity (§2.2 #20-23).
 */
function chatHeaders(credential: WorkBuddyCredential, identity: WorkBuddyClientIdentity): Record<string, string> {
  // `X-Request-ID` and `X-Conversation-Message-ID` are the same value — both
  // are the turn's `messageId` (B1, B26).
  const messageId = freshRequestId()
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': clientUserAgent(identity),
    'X-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Conversation-ID': freshRequestId(),
    'X-Conversation-Request-ID': freshRequestId(),
    'X-Agent-Intent': AGENT_INTENT_DEFAULT,
    'X-Agent-Type': AGENT_TYPE_MAIN,
    // The client-identity tuple the server whitelists a client by (§2.5); its
    // three `X-IDE-*` values come from the installed bundle, never hardcoded.
    'X-IDE-Type': CLIENT_PRODUCT,
    'X-IDE-Name': CLIENT_PRODUCT,
    'X-IDE-Version': identity.appVersion,
    'X-Product': PRODUCT_SAAS,
  }
  // 安全红线：chat 请求绝不携带 refresh token。
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  // B6 injects the enterprise headers from the same field; a personal account
  // has neither, and then neither header is sent.
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  // `credential.domain` *is* the auth session's `domain` — `src/auth.ts` reads
  // it straight out of the desktop auth document's `auth.domain`, which is the
  // exact field B6 gates `X-Domain` on. An empty domain omits the header.
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
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
  /**
   * App-version resolver for international catalog requests; injectable for
   * tests.
   *
   * It is also the app-version half of the outbound client identity: the
   * default reader resolves the bundle of the *requesting* region, so a CN
   * chat request is labelled with the CN App's version instead of the
   * international App's.
   */
  resolveAppVersion?: (region: WorkBuddyRegion) => Promise<AppVersionInfo>
  /**
   * Outbound client identity (desktop App version + bundled CLI version);
   * injectable so tests never read the real App bundle.
   *
   * When supplied it wins over the installed-bundle reader for every header
   * that carries identity — the chat `User-Agent` and `X-IDE-Version` — and it
   * is validated the same way (`validAppVersion` / the CLI version shape), so a
   * test can pin the exact outbound request without owning a WorkBuddy install.
   */
  resolveClientIdentity?: (region: WorkBuddyRegion) => Promise<WorkBuddyClientIdentity>
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
   * Resolves the App-shaped UA version for international catalog requests, and
   * the app-version half of the outbound client identity. Injectable so tests
   * never read the real filesystem.
   */
  private readonly resolveAppVersion: (region: WorkBuddyRegion) => Promise<AppVersionInfo>

  /** Injected identity resolver; wins over the installed-bundle reader. */
  private readonly resolveClientIdentity: ((region: WorkBuddyRegion) => Promise<WorkBuddyClientIdentity>) | undefined

  /**
   * Identity per region, resolved once per client.
   *
   * The official client reads its client info once per process, and the
   * resolution reads the App bundle and may write the version cache, so it must
   * not run per message.
   */
  private readonly identities = new Map<WorkBuddyRegion, Promise<WorkBuddyClientIdentity>>()

  /** Provenance of the most recent successful catalog fetch, for the card. */
  lastCatalog: WorkBuddyCatalogFetch | undefined

  constructor(options: WorkBuddyUpstreamClientOptions = {}) {
    this.resolveAppVersion = options.resolveAppVersion
      ?? (region => resolveAppVersion({
        installed: () => installedDesktopBundle(region),
        // Each region caches its own App version, so adopting the CN App's
        // version here cannot relabel the international catalog's UA.
        ...region === 'global' ? {} : { path: cnAppVersionPath() },
      }))
    this.resolveClientIdentity = options.resolveClientIdentity
  }

  /**
   * The identity this client presents for one region's requests.
   *
   * Never fatal and never blocking: a bundle that cannot be read, a version
   * that cannot be parsed, or a failing injected resolver all degrade to
   * {@link FALLBACK_APP_VERSION} — the same last resort `app-version.ts` uses —
   * and to a User-Agent without the trailing `CLI/…` token, which is the
   * official degradation when the CLI version is absent (§3).
   */
  private clientIdentity(region: WorkBuddyRegion): Promise<WorkBuddyClientIdentity> {
    const cached = this.identities.get(region)
    if (cached !== undefined) return cached
    // The last-resort `catch` keeps the cached promise from ever rejecting: a
    // rejected promise cached here would fail every later request too.
    const resolved = this.resolveIdentity(region).catch((): WorkBuddyClientIdentity => ({ appVersion: FALLBACK_APP_VERSION }))
    this.identities.set(region, resolved)
    return resolved
  }

  /** Resolve one region's identity: injected first, then the installed bundle. */
  private async resolveIdentity(region: WorkBuddyRegion): Promise<WorkBuddyClientIdentity> {
    const injected = this.resolveClientIdentity
    if (injected !== undefined) {
      try {
        return normalizeIdentity(await injected(region))
      } catch {
        // A failing injected resolver must not block a request; fall through to
        // the installed bundle below.
      }
    }
    let appVersion: string
    try {
      const resolved = await this.resolveAppVersion(region)
      appVersion = validAppVersion(resolved.version) ? resolved.version : FALLBACK_APP_VERSION
    } catch {
      appVersion = FALLBACK_APP_VERSION
    }
    const bundle = await installedDesktopBundle(region)
    const cliVersion = bundle === undefined ? undefined : await readBundledCliVersion(bundle.bundle)
    return cliVersion === undefined ? { appVersion } : { appVersion, cliVersion }
  }

  /**
   * POST the chat endpoint; a successful answer is the raw SSE response.
   *
   * The body is normalized for both regions. The international endpoint needs a
   * leading `system` message (400/11128) and gets one from
   * {@link prepareInternationalChatBody}; the CN endpoint has no such rule, but
   * it does reject the `developer` role container, so the CN body goes through
   * {@link prepareChatBody} — the same rewrite the shim already applies, and
   * idempotent. No artificial CN system prompt is invented: the official
   * builder prepends one only when the agent has instructions (B10), so a body
   * without one is not a violation of anything the contract establishes (§5).
   */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      const region = regionOf(credential.domain)
      const identity = await this.clientIdentity(region)
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential, identity), 'Authorization': `Bearer ${credential.accessToken}` },
        body: region === 'global' ? prepareInternationalChatBody(bodyJson) : prepareChatBody(bodyJson),
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
    const identity = await this.clientIdentity(regionOf(credential.domain))
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential, identity),
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
   * Two upstream documents feed this, one per variant:
   *
   * - CN (`workbuddy`): `/console/enterprises/personal/models`, the document
   *   the official CLI itself consumes. Unchanged behaviour.
   * - International (`workbuddy-ai`): `/v3/config`, the product document the
   *   App's main process fetches. The gateway splits it by User-Agent, so this
   *   request carries the App-shaped UA while every other request keeps the
   *   CLI UA it has always sent.
   *
   * Both are unwrapped and classified the same way — `readEnvelope` plus
   * `envelopeError` — so an expired session or exhausted credit is reported as
   * such rather than as a generic catalog failure.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const international = regionOf(credential.domain) === 'global'
    // `this.resolveAppVersion`, not the module-level function: the constructor
    // injects a resolver so tests never read the real filesystem, and calling
    // the module function directly made that seam inert.
    const appVersion = international ? await this.resolveAppVersion('global') : undefined
    const response = await fetch(`${chatBase(credential)}${international ? '/v3/config' : '/console/enterprises/personal/models'}`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
        'User-Agent': appVersion === undefined ? CN_CATALOG_UA : appUserAgent(appVersion.version),
      },
      signal: signal === undefined
        ? AbortSignal.timeout(JSON_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // Two catalog shapes share this path. The CN endpoint always answers with
    // the `{code,msg,data}` wrapper; `/v3/config` has also been observed
    // answering with the product document bare at the top level (no wrapper at
    // all). Treating a missing `data` as an empty document turned that second
    // shape into a spurious "no cli agent models", so a body that itself looks
    // like a catalog (it carries models or agents) is used as the answer. A body
    // with neither shape still falls through to the empty-parse error below.
    const data = isObject(envelope.data) ? envelope.data
      : 'models' in envelope.document || 'agents' in envelope.document ? envelope.document
      : {}
    const models = parseModelCatalog(data, international)
    this.lastCatalog = {
      fetchedAtMs: Date.now(),
      source: international ? 'workbuddy-ai:app' : 'workbuddy:cli',
      ...appVersion === undefined ? {} : { appVersion },
    }
    return models
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
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
    const identity = await this.clientIdentity(international ? 'global' : 'cn')
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
        headers: { ...chatHeaders(credential, identity), 'Authorization': `Bearer ${credential.accessToken}` },
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
/** Parse either response shape after its envelope has been checked. */
export function parseModelCatalog(data: Record<string, unknown>, international = false): readonly WorkBuddyUpstreamModel[] {
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
          maxInputTokens: input,
          supportedContextWindows: isObject(wrapped['contextWindow']) && Array.isArray(wrapped['contextWindow']['supportedLengths'])
            ? wrapped['contextWindow']['supportedLengths'].filter(positive) : [],
          promotions: parsePromotions(data['modelPromotions'], id),
        } : {}),
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
  const messages = body['messages']
  if (!Array.isArray(messages)) return prepared
  const first = messages[0]
  if (isObject(first) && first['role'] === 'system') return prepared
  // Unshift, so every caller-supplied message keeps its position and content.
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
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
