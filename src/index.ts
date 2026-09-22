/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop apps'
 * sign-in. Registers one provider per product variant — `workbuddy` for the CN
 * app and `workbuddy-ai` for the international one — while streaming, tool
 * calls, compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link WorkBuddyVariant} descriptor: each gets its own credential store,
 * catalog, upstream client, shim, adapter, probe state, and routes. Neither
 * variant's startup, catalog fetch, or credential state can stop the other from
 * registering — a user with only one app installed sees only that group.
 *
 * @module dsh-workbuddy-connect
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: merges the Loader's own `Fiber.entry` and the `loader/*` events
// into the cordis Context this module is written against. The Loader itself is
// part of every DSH boot, so nothing is installed for it at runtime.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from './auth.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { workbuddyCatalogPath, WorkBuddyCatalogStore } from './catalog-store.ts'
import { createWorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore, workbuddyProbePath } from './probe-store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { CN_VARIANT, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  WORKBUDDY_CATALOG_FILENAME,
  workbuddyCatalogPath,
  WorkBuddyCatalogStore,
} from './catalog-store.ts'
export {
  fingerprintModel,
  WorkBuddyProbeStore,
  workbuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export {
  AI_VARIANT,
  CN_VARIANT,
  variantFor,
  WORKBUDDY_VARIANTS,
  type WorkBuddyVariant,
} from './variants.ts'
export {
  appUserAgent,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  WORKBUDDY_APP_VERSION_FILENAME,
  type AppVersionInfo,
  type WorkBuddyAppVersionSource,
} from './app-version.ts'
export {
  CN_APP_VERSION_FILENAME,
  FALLBACK_CN_APP_VERSION,
  chatUserAgent,
  fallbackChatIdentity,
  readCliVersion,
  resolveChatIdentity,
  validCliVersion,
  type ChatIdentity,
  type ResolveChatIdentityOptions,
} from './client-identity.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  modelWithCurrentPromotion,
  normalizeCredits,
  parseModelCatalog,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyCatalogFetch,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * The loader entry id this bundle's own patch declares, which is also this
 * plugin's settings namespace.
 *
 * DSH 0.1.7 rebuilt the settings seam around Loader entries: a namespace is no
 * longer an arbitrary string a plugin installs a section under, it is the
 * profile entry id of the plugin instance itself, and the form is derived from
 * the plugin's own `Config` schema (only fields declared `.volatile()`).
 * `cordis.patch.yml` in this package pins the entry id, so the plugin and its
 * client half agree on it without a handshake. {@link settingsNamespace} still
 * prefers the live fiber's entry id when the profile renamed the row.
 */
export const WORKBUDDY_ENTRY_ID = 'llm-workbuddy'

/**
 * Resolve this instance's settings namespace.
 *
 * The entry id is read from the running fiber rather than assumed, because a
 * profile may compose this plugin under a different row id; the constant is the
 * fallback for the one composition this package ships.
 *
 * @param ctx - the plugin context whose fiber owns the Loader entry.
 * @returns the profile entry id serving this plugin's configuration form.
 */
function settingsNamespace(ctx: Context): string {
  return ctx.fiber.entry?.options.id ?? WORKBUDDY_ENTRY_ID
}

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a sign-in that happens while DSH
 * is already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 *
 * `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow sign-in
 * on a real machine; it is not a product setting and no UI exposes it. The
 * value is clamped to a sane range so a mistaken override cannot turn the poll
 * into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_WORKBUDDY_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (a same-identity token rotation carries no new model information). But a
 * *failed* fetch must not be treated the same way: without a retry, one
 * transient network blip at startup would leave the group on the built-in
 * fallback roster until the user noticed and pressed refresh. This bound keeps
 * that recovery automatic while still honoring the "not every round" rule — at
 * most one attempt per interval, and none at all once a live catalog lands.
 *
 * Expressed as a multiple of the sweep rather than a fixed duration so the two
 * stay in proportion under the `DSH_WORKBUDDY_POLL_MS` override.
 */
const CATALOG_RETRY_SWEEPS = 10

/**
 * Plugin configuration.
 *
 * Every field is a {@link Volatile} reference since DSH 0.1.7: the settings
 * form is derived from this schema, and only volatile fields are editable
 * live — a change to them is committed into the running fiber's references and
 * announced as `loader/volatile-update` instead of remounting the plugin. A
 * non-volatile field would still be ordinary configuration (editable through
 * the profile patch) but would be invisible to the settings surface and would
 * reload the whole plugin when edited.
 */
export interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults. */
  authFile?: Volatile<string | undefined>
  /** Explicit WorkBuddy AI (international) desktop auth-file path, overriding env and platform defaults. */
  authFileAI?: Volatile<string | undefined>
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: Volatile<boolean>
  /** Use the largest context window the international catalog explicitly offers. */
  useMaximumContextWindow?: Volatile<boolean>
}

/** Explicit CN desktop auth-file path. */
const AUTH_FILE_FIELD = z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)')
/** Explicit international desktop auth-file path. */
const AUTH_FILE_AI_FIELD = z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)')
/** Probe authorization. */
const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true)
  .description('Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)')

// Deliberately not annotated `z<Config>`: a volatile field's resolved type
// (`Volatile<T>`) differs from its raw one (`T`), so the schema's *output* is
// the interface above while its *input* — what a profile patch or a settings
// write supplies — is the plain shape. Annotating against the output shape is
// what upstream `dsh-llm-pi-ai` does too: inference carries the input.
export const Config = z.object({
  authFile: AUTH_FILE_FIELD.volatile(),
  authFileAI: AUTH_FILE_AI_FIELD.volatile(),
  probeConsent: PROBE_CONSENT_FIELD.volatile(),
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD.volatile(),
})

/** Live reads of the configuration, through the references DSH commits in place. */
interface ConfigReader {
  /** The configured desktop auth-file path for one variant, when one is set. */
  authFile: (variant: WorkBuddyVariant) => string | undefined
  /** Whether the user authorized paid reasoning-effort probes. */
  probeConsent: () => boolean
  /** Whether the international catalog serves its largest declared window. */
  useMaximumContextWindow: () => boolean
}

/** Bind a configuration schema's volatile references to plain readers. */
function createConfigReader(config: Config): ConfigReader {
  return {
    authFile: variant => (variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI)?.get(),
    probeConsent: () => config.probeConsent?.get() === true,
    useMaximumContextWindow: () => config.useMaximumContextWindow?.get() === true,
  }
}

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /**
   * The last catalogs that loaded, keyed by account.
   *
   * Sits between the live fetch and the built-in roster in the degradation
   * order: a restart, or a fetch that fails while offline, serves what this
   * account was last actually shown instead of the one-off snapshot compiled
   * into the plugin.
   */
  savedCatalogs: WorkBuddyCatalogStore
  /** The static roster this variant falls back to. */
  fallback: readonly WorkBuddyModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes — an account
   * switch, a sign-out, or a new fetch superseding an older one. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop (spec §5: late responses are discarded).
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under. A caller may only join the same scope; an account change cancels the
   * old request and immediately starts one for the newly adopted account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Each variant has its own roster: the two endpoints share several model ids
 * but not their billing, context windows, or reasoning sets, so one shared
 * fallback would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/**
 * Build one variant's stores and probe state.
 *
 * Configuration is read through {@link ConfigReader} rather than captured as a
 * plain object: the values live in volatile references, so a settings write
 * changes them in place and every read here sees the new value without the
 * plugin being remounted.
 */
function createVariantRuntime(
  read: ConfigReader,
  variant: WorkBuddyVariant,
  identityOf: (variantId: string) => string | undefined,
): VariantRuntime {
  const client = new WorkBuddyUpstreamClient()
  const configured = read.authFile(variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    ...configured === undefined ? {} : { desktopPath: configured },
    refresh: credential => client.refreshToken(credential),
  })
  const fallback = fallbackFor(variant)
  const catalog = new WorkBuddyCatalog(fallback)
  if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(read.useMaximumContextWindow())
  // Start hidden: a variant must serve no models until an account has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail. `adoptIdentity` is what reveals it, and it
  // treats "never seen, still signed out" as no change — which is only correct
  // if the pre-adoption state is already hidden.
  catalog.setVisible(false)
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    path: workbuddyProbePath(variant.probeFilename),
  })
  // One file per variant, for the same reason the probe records are split: the
  // two endpoints disagree about rates and windows for shared model ids, so a
  // saved CN roster must never be served as an international one.
  const savedCatalogs = new WorkBuddyCatalogStore(
    workbuddyCatalogPath(variant.catalogFilename),
  )
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => read.probeConsent(),
    // Observations are per account: the service reads and writes its records
    // against this identity, so one account's detected levels never answer for
    // another's, and an in-flight sweep cannot store under a new account.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    catalog,
    probeStore,
    probeService,
    savedCatalogs,
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
  const fetch = runtime.client.lastCatalog
  return {
    // The source is what the models on screen actually came from, so the card
    // can distinguish a fresh fetch from a saved one from the built-in roster —
    // "stale" and "offline" are different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, which for a saved list is when it
    // was fetched, not when the process started.
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...fetch?.appVersion === undefined ? {} : { appVersion: fetch.appVersion.version },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists. Dropping a
 * model once it has been detected made the list shrink with use, so
 * re-detecting one model — after an upstream change, say — meant clearing every
 * other result first. The list stays stable and the card marks which entries
 * already have an answer.
 */
function isProbeCandidate(info: WorkBuddyModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): WorkBuddyWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the *same* judgement the adapter uses, rather than
  // straight from the store. A raw record can be stale in ways the adapter
  // already discounts — its catalog row changed, it aged past the TTL, or the
  // upstream has since declared an effort set (which always wins) — and showing
  // one would have the card promise levels the model picker does not offer. A
  // model the upstream dropped leaves the catalog entirely, so it drops out
  // here too.
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one.
    results: newestFirst(results),
  }
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime, settingsNs: string): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  let invalidate: (() => void) | undefined
  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const workbuddy = createWorkBuddyAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
    })
    invalidate = workbuddy.invalidate
    runtime.invalidate = () => {
      workbuddy.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        // Both variants join the ONE namespace this plugin owns — its profile
        // entry id. DSH 0.1.7 keys a settings form by the owning plugin entry,
        // not by an arbitrary string a plugin installs a section under, and the
        // Models settings page resolves `settingsNs` against the namespaces the
        // Host serves. The fields are per-variant (`authFile` / `authFileAI`),
        // so the joined form edits both products' paths from one page.
        settingsNs,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        void shim.close()
      })
    } catch {
      // The plugin was disposed during registration; release immediately — the
      // plugin-level disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      void shim.close()
    }
    runtime.registered = true
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} provider registration failed`, error)
    void shim.close()
    return false
  }
}

/**
 * Start both variants: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, this plugin's configuration page, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 *
 * The configuration page is the browser half's own contribution to DSH's
 * Plugins page (`plugins.bundle.config`). That page is this plugin's own, so it
 * is declared here — with `auto: false` — rather than derived from the schema
 * like a third-party configuration surface would be.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration reads. The schema's volatile references are committed in
  // place by the Loader, so every reader below sees a settings write without
  // this plugin being remounted; `loader/volatile-update` is only what tells it
  // to re-apply a value to state that was derived from it (a desktop path, a
  // context-window preference).
  const read = createConfigReader(config)
  /** This instance's settings namespace: the profile entry id that owns it. */
  const settingsNs = settingsNamespace(ctx)

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /**
   * The account identity each variant last published a catalog for. Keeps a
   * same-identity token rotation from re-fetching, and lets a late response
   * from a previous identity be discarded instead of overwriting a newer one.
   */
  const lastIdentities = new Map<string, string>()

  const runtimes = WORKBUDDY_VARIANTS.map(variant => createVariantRuntime(
    read,
    variant,
    id => lastIdentities.get(id),
  ))

  // Same-origin routes backing the plugin's configuration page; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, manual refresh sign-out) because each of them used to do its own
   * partial version, and the manual path forgot pieces the sweep did. Every
   * transition bumps {@link VariantRuntime.catalogGeneration}, which is what
   * makes an in-flight request from before the change refuse to write back.
   *
   * Probe observations are kept across an account change: the store nests them
   * per account, so the departing account's records simply stop being served
   * (every read is account-scoped) and are found intact if that account
   * returns. The "signed out, then in as someone else" sequence that used to
   * look like a first sighting is still safe — a record only ever answers for
   * the account stamped on it, so the new account inherits nothing.
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    if (known === identity) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    // Any change of identity invalidates in-flight work and the catalog it was
    // serving; recorded probe answers stay on disk, keyed by account and
    // re-judged on every read.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back. The signed-out
      // account's saved catalog is forgotten as well — it is that account's
      // data, and it is keyed by identity so nothing else can serve it, but
      // keeping it would only be useful if that same account returned, and the
      // file is not a place to accumulate departed accounts' catalogs.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account (from this source)
    // was actually served. This covers both a switch and a restart — on a
    // restart `hadCredential` is false, and the saved catalog is exactly what
    // stops the group from falling back to the compiled-in list.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, read.probeConsent()),
        probeKey,
        ...runtime.variant.id === CN_VARIANT.id ? {} : { useMaximumContextWindow: () => read.useMaximumContextWindow() },
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          // Re-read the credential first: the user pressed this because the list
          // looks wrong, and a sign-in that happened since the last sweep is the
          // common cause. Re-registering is unnecessary — visibility is what
          // changes, and the sweep owns that.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report,
            // not a crash out of the route.
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            adoptIdentity(runtime, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*, not when
          // the fetch lands, or a failed fetch leaves those models pickable.
          adoptIdentity(runtime, identity)
          await fetchCatalog(runtime, identity)
          return runtime.catalogError === undefined
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'failed', reason: runtime.catalogError }
        },
        ...runtime.variant.id === CN_VARIANT.id ? {} : {
          setMaximumContextWindow: async enabled => {
            if (setMaximumContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
            return setMaximumContextWindow(enabled)
          },
        },
      }, probeKey)
    }
  })


  // DSH 0.1.7 owns a settings form by profile entry id. A plugin no longer
  // installs a section of its own: the Loader already holds the entry's `Config`
  // schema, `settings.describe()` projects the volatile fields of every live,
  // uniquely addressed entry, and a write lands in the profile patch and is
  // committed into the running volatile references. What is left for a plugin
  // that ships its own page is to say so — `auto: false` stops a client from
  // also generating a page from the schema — and to write its own fields
  // through the service.
  //
  // Registering this inside `ctx.inject(['settings'], …)` keeps the plugin
  // usable without a settings service: it still serves its models, it simply
  // has no page to write through, exactly as when a section failed to install.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    setMaximumContextWindow = async enabled => {
      await settingsCtx.settings.update(settingsNs, { useMaximumContextWindow: enabled })
      return { state: 'updated' }
    }
  })

  /**
   * Re-apply the configuration that derived state was built from.
   *
   * A volatile commit changes the reference in place, so every value read per
   * request already reflects it. Two things do not, because they were resolved
   * once rather than per request: the credential store's desktop path, and the
   * international catalog's window preference (a property of the catalog
   * object, not of a request). The event fires on the owning fiber only, which
   * is this one.
   */
  ctx.on('loader/volatile-update', () => {
    for (const runtime of runtimes) runtime.store.setDesktopPath(read.authFile(runtime.variant))
    const runtime = runtimes.find(candidate => candidate.variant.id !== CN_VARIANT.id)
    if (runtime?.catalog.setUseMaximumContextWindow(read.useMaximumContextWindow()) === true) {
      runtime.invalidate()
    }
  })

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    void clearHostHeartbeat()
  })

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch
   *   instead of starting its own (spec §5: one catalog request per variant at
   *   a time).
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on — which is
   *   what a slow answer from a superseded account must not do. Checking only
   *   the *identity* was not enough: two refreshes for the same account can
   *   still finish out of order, and the older one would win.
   * - **`resolve()`, not `current()`.** Only `resolve()` performs the locked,
   *   single-flight token renewal. Reading `current()` meant an expired token
   *   made every catalog request fail until something else happened to refresh
   *   it, leaving the group on the fallback roster.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well:
    // no stale request may prevent the current account from fetching now.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly WorkBuddyModelInfo[]
      try {
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        // `current()` established the identity that owns this fetch, but
        // `resolve()` reads the desktop file again. The App can switch accounts
        // between those reads; never send or persist B's directory as A's.
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity)
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(credential, controller.signal)
        // The account can also change while the upstream request is in flight.
        // Re-read before publishing so the just-finished document still belongs
        // to the account that is currently selected in the desktop App.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity)
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-workbuddy-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown rather than the
      // snapshot compiled into the plugin.
      if (lastIdentities.get(runtime.variant.id) === identity) {
        runtime.savedCatalogs.set(identity, {
          source: runtime.client.lastCatalog?.source ?? 'unknown',
          fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
          models: [...models],
          ...runtime.client.lastCatalog?.appVersion === undefined
            ? {}
            : { appVersion: runtime.client.lastCatalog.appVersion.version },
        })
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another user's probe answers cannot be read as
   *   the new account's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — the store refreshes tokens on demand,
   *   and re-fetching on every rotation would hit the catalog endpoint for no
   *   new information.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff rather than
      // every sweep, so a persistent outage does not become a request loop.
      // Any non-live source is stale: both the saved catalog and the built-in
      // roster are worth replacing with a fresh fetch on the same backoff.
      const stale = runtime.catalogSource !== 'live'
      const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity)
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  void Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime, settingsNs))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some(runtime => runtime.registered)) void writeHostHeartbeat()

    void syncAll()
    const timer = setInterval(() => { void syncAll() }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  })
}
