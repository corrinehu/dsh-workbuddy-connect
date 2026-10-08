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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore, type WorkBuddyCredential, type WorkBuddyStoreOptions } from './auth.ts'
import { atRestKeyProviderFor, WorkBuddyAtRestKeyProvider } from './desktop-credential-protection.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { workbuddyCatalogPath, WorkBuddyCatalogStore } from './catalog-store.ts'
import { WorkBuddyVisibilityStore, workbuddyVisibilityPath } from './visibility-store.ts'
import { createWorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore, workbuddyProbePath } from './probe-store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { registerWorkBuddyUpdateRoute } from './update-route.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { legacySettingsOf } from './legacy-settings.ts'
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
  WORKBUDDY_VISIBILITY_FILENAME,
  WorkBuddyVisibilityStore,
  workbuddyVisibilityPath,
} from './visibility-store.ts'
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
  prepareCnChatBody,
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
 * Settings namespace owning the CN card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as SettingsNamespace

/**
 * Settings namespace owning the international section.
 *
 * One namespace per variant, not one shared: each section owns only its own
 * fields (`authFile` vs `authFileAI` and `useMaximumContextWindow`), and the
 * sections are what `settings.yaml` and the TUI `/settings` read. On DSH 0.1.5
 * they carry one more duty — the settings Plugins tab dispatches a card by
 * rendering `settings.plugin.item` with `entryKey = ns` for each namespace the
 * Host serves, so each variant's card needs a served section whose namespace
 * equals its id. DSH 0.1.6+ ignores that pairing (its Plugins page renders the
 * bundle's single `plugins.bundle.config` entry, keyed by package name), which
 * costs nothing: a section that names no card renders no duplicate.
 */
export const WORKBUDDY_AI_SETTINGS_NS = 'workbuddy-ai' as SettingsNamespace

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

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** Explicit WorkBuddy AI (international) desktop auth-file path, overriding env and platform defaults. */
  authFileAI?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
  /** Use the largest context window the international catalog explicitly offers. */
  useMaximumContextWindow?: boolean
}

/** Explicit CN desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_FIELD = z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)')
/** Explicit international desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_AI_FIELD = z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)')
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true)
  .description('Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)')

export const Config: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  authFileAI: AUTH_FILE_AI_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
})

/**
 * The CN side's settings section: only the fields that side edits.
 *
 * The section's namespace is what serves these fields to `settings.yaml` and
 * the TUI `/settings`, and it keeps them apart from the international side's.
 * `probeConsent` lives here because it predates the second variant; it gates no
 * current code path (only manual, per-click-confirmed probes run), so it is left
 * where existing users set it rather than moved and re-asked.
 */
const CN_SECTION: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
})

/** The international card's settings section and its context-window preference. */
const AI_SECTION: z<Config> = z.object({
  authFileAI: AUTH_FILE_AI_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
})

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
  /**
   * This variant's per-account hidden-model preferences (issue #36). One file
   * per variant, keyed by account: a model id one account hid never hides for
   * another, and switching accounts switches the whole list in one read.
   */
  visibilityStore: WorkBuddyVisibilityStore
  /**
   * The visibility account key currently in effect (`uid:enterpriseId`), or
   * undefined when signed out or the credential carries no uid. Read per call,
   * so an account switch changes the answer without rebuilding anything.
   */
  account: () => string | undefined
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
 * The account key model-visibility preferences are stored under: the stable
 * identity, but only when it carries a uid.
 *
 * A credential whose desktop document carried no `account.uid` normalizes to
 * an empty string; keying preferences on the resulting `":enterpriseId"` would
 * silently share one bucket between every such account. Those accounts get no
 * per-account preferences at all — everything stays visible and the control
 * route explains the refusal — which is the only honest degradation: it never
 * applies one account's hidden list to another.
 */
export function visibilityAccountOf(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string | undefined {
  return credential.uid === '' ? undefined : credentialIdentity(credential)
}

/** Read the configured explicit auth-file path for one variant. */
function configuredAuthFile(config: Config, variant: WorkBuddyVariant): string | undefined {
  return variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI
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

/** Build one variant's stores and probe state. */
function createVariantRuntime(
  config: Config,
  variant: WorkBuddyVariant,
  current: () => Config,
  identityOf: (variantId: string) => string | undefined,
  accountOf: (variantId: string) => string | undefined,
  keyProvider: WorkBuddyStoreOptions['keyProvider'],
): VariantRuntime {
  const client = new WorkBuddyUpstreamClient()
  const configured = configuredAuthFile(config, variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    ...configured === undefined ? {} : { desktopPath: configured },
    ...keyProvider === undefined ? {} : { keyProvider },
    refresh: credential => client.refreshToken(credential),
  })
  const fallback = fallbackFor(variant)
  const catalog = new WorkBuddyCatalog(fallback)
  if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true)
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
  const visibilityStore = new WorkBuddyVisibilityStore(
    workbuddyVisibilityPath(variant.visibilityFilename),
  )
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    // The two endpoints answer a rejected effort with different codes; each
    // runtime reads only the vocabulary measured on its own endpoint.
    region: variant.id === CN_VARIANT.id ? 'cn' : 'global',
    consent: () => current().probeConsent === true,
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
    visibilityStore,
    account: () => accountOf(variant.id),
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
async function startVariant(ctx: Context, runtime: VariantRuntime): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const workbuddy = createWorkBuddyAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      // From the variant descriptor, never inferred: it selects the CN-only
      // `onlyReasoning` rule that keeps an always-failing `off` out of the
      // picker (#87).
      region: variant.region,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
      observe: modelId => probeService.recordFor(modelId),
      // Hidden ids resolve per read from the store by the *current* account:
      // an account switch or a toggle changes the answer after the next
      // invalidate, and a signed-out or uid-less variant hides nothing.
      hidden: () => {
        const account = runtime.account()
        return account === undefined ? [] : runtime.visibilityStore.disabled(account)
      },
    })
    runtime.invalidate = () => {
      workbuddy.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    // Only the adapter registers. The plugin deliberately contributes NO
    // `registerConfigurableProviders` directory entry — on either DSH
    // generation: the Models settings page (present since 0.1.2, joining the
    // same way on 0.1.5 and 0.1.6) builds its rows from that registration, so
    // omitting it keeps the WorkBuddy providers off that page (its editor has
    // no fields to offer them) while the adapter keeps serving models and the
    // sections keep serving `settings.yaml` and the TUI. A live route with no
    // directory entry joins with an empty `settingsNs`, which every page reads
    // as unconfigured and does not render. Nothing else consumes the
    // directory: the model picker's group headings come from the adapter's own
    // provider metadata and catalog, and `/model` resolves through the
    // adapter, so both are unaffected.
    const releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter)
    try {
      ctx.effect(() => () => {
        releaseAdapter()
        void shim.close()
      })
    } catch {
      // `ctx.effect` throws when the context is already disposed, so the
      // disposer it would have registered never runs: release this variant's
      // own registration (and its shim) here instead.
      releaseAdapter()
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
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed, so edits reach the
  // probe consent gate without a restart.
  let current = (): Config => config

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /**
   * The account identity each variant last published a catalog for. Keeps a
   * same-identity token rotation from re-fetching, and lets a late response
   * from a previous identity be discarded instead of overwriting a newer one.
   */
  const lastIdentities = new Map<string, string>()
  /**
   * The visibility account key each variant last adopted, parallel to
   * {@link lastIdentities}: same credential, second key — undefined both when
   * signed out and when the credential carried no uid, which is exactly the
   * case that must not fall back to a shared preference bucket.
   */
  const lastAccounts = new Map<string, string>()

  // One at-rest key provider per variant, built by the shared helper the CLI
  // entry uses too. Product identity (env var, bundle id, registry name, exe
  // basename) lives on the variant's electron profile, so each provider can
  // only ever resolve — and execute — its own product's Electron: the two apps
  // currently seal credentials under the same at-rest key on a machine, but
  // that coincidence is never relied on. Discovery is platform-gated (macOS
  // and Windows for both products, Linux none); an explicit per-product env
  // var stays authoritative and never falls back.
  const atRestKeysFor = (variant: WorkBuddyVariant): WorkBuddyAtRestKeyProvider => atRestKeyProviderFor(variant)
  const runtimes = WORKBUDDY_VARIANTS.map(variant => createVariantRuntime(
    config,
    variant,
    () => current(),
    id => lastIdentities.get(id),
    id => lastAccounts.get(id),
    atRestKeysFor(variant),
  ))

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Whether this host's settings service carries the 0.1.2-era section API.
   * Decided once, inside the `settings` inject: DSH 0.1.7 removed
   * `installSection` (and `update`) with no replacement this plugin can drive.
   * The maximum-context getter answers `undefined` while this is false, and a
   * status document without the field is what keeps the card from rendering a
   * checkbox that could not be saved.
   */
  let legacySettingsAvailable = false
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
   * the account stamped on it, so the new account inherits nothing. Visibility
   * preferences are kept for the same reason, and read through the new
   * account's key immediately: the picker re-lists after the invalidate below
   * and a returning account finds its own hidden list back in force.
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   * @param account - the visibility key for that same credential (`undefined`
   * also when the credential carries no uid); stored alongside the identity so
   * preference reads never guess it from the identity string.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined, account: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    if (known === identity) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    if (account === undefined) lastAccounts.delete(id)
    else lastAccounts.set(id, account)
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
    // One update route for the whole bundle: it answers this npm package's
    // public version metadata only, so it is per-plugin, not per-variant.
    registerWorkBuddyUpdateRoute(webCtx, { currentVersion: WORKBUDDY_CONNECT_VERSION })
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
        // The full per-account hidden list — stale ids included — so the card's
        // checkboxes answer exactly what the picker filter reads. Absent (and
        // the card renders no controls) when no uid-keyed account is in effect.
        visibility: () => {
          const account = runtime.account()
          return account === undefined
            ? undefined
            : { account, disabled: runtime.visibilityStore.disabled(account) }
        },
        ...runtime.variant.id === CN_VARIANT.id ? {} : {
          // Presence of this field in the document is the card's capability
          // signal, so the getter answers `undefined` — not merely `false` —
          // on a host that cannot persist the preference. See
          // {@link legacySettingsAvailable}.
          useMaximumContextWindow: () => legacySettingsAvailable
            ? current().useMaximumContextWindow === true
            : undefined,
        },
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
            adoptIdentity(runtime, undefined, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*, not when
          // the fetch lands, or a failed fetch leaves those models pickable.
          adoptIdentity(runtime, identity, visibilityAccountOf(credential))
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
        setModelVisibility: async (modelId, visible, expectedAccount) => {
          // Refused rather than bucketed: a signed-out variant, or a
          // credential with no uid, has no account to key the preference by,
          // and writing it anywhere else would let one account's hidden list
          // answer for another.
          const account = runtime.account()
          if (account === undefined) {
            return { state: 'failed', reason: 'model visibility needs a signed-in account with a stable user id' }
          }
          // Expected-account guard: the card names the account its checkboxes
          // were rendered from. A card still showing account A while the
          // desktop has already switched to B must not land A's toggle in B's
          // bucket — refuse, and the card refreshes into B's own section.
          if (expectedAccount !== account) {
            return { state: 'stale-account', reason: 'the signed-in account changed' }
          }
          try {
            runtime.visibilityStore.setVisible(account, modelId, visible)
          } catch (error: unknown) {
            // A toggle that did not persist must not be reported as saved.
            return { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 300) : String(error) }
          }
          runtime.invalidate()
          return { state: 'updated' }
        },
      }, probeKey)
    }
  })


  // Each settings section is what makes its namespace "served", which is how
  // `settings.yaml` and the TUI `/settings` read this plugin's fields — and,
  // on DSH 0.1.5, how the settings Plugins tab finds this plugin's cards (the
  // tab dispatches `settings.plugin.item` by served namespace, one card per
  // namespace, and never interprets one). One section per variant: each owns
  // its own fields, so a shared namespace would collapse the two variants'
  // distinct settings onto one — and on 0.1.5 their two cards onto one.
  // (The Models settings page does not join on these on any version — the
  // plugin registers no configurable-provider directory entry, so that page
  // lists neither provider.)
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now has
  // to wait for a settings service to exist — exactly what the inject below
  // does. Without one the plugin still serves its models; it simply has no
  // user-editable sections, as before.
  ctx.inject(['settings'], settingsCtx => {
    /*
     * DSH 0.1.7 removed the provider-service section API (`installSection`,
     * `update`) without a replacement this plugin can drive, and DSH 0.2.0
     * replaced the whole service with a Config-derived *forms* facade
     * (`describe`/`update`/`mutate`, with no section installation at all).
     * Calling the old API there would throw mid-inject, so it is
     * feature-detected through the structural type above: a host carrying the
     * section API installs both legacy sections, while a 0.2.0 host degrades
     * to a settings-less provider — provider, picker, visibility, and the
     * context rows all keep working; only the two settings sections and the
     * maximum-context preference are absent, and without an exception.
     * (Since 0.7.0 the peers admit 0.2.0 cores only; the pre-0.2.0 branches
     * are structural compatibility carried over from the 0.6.x line, not a
     * current support promise.)
     *
     * The guard reads the API off a narrowed view rather than indexing the
     * service directly, because `installSection` is not a member of the 0.2.0
     * `SettingsForms` type at all: an `in`/`typeof` probe on that type is a
     * compile error, and a cast to `any` would hide the very drift this
     * detection exists to survive.
     */
    const legacy = legacySettingsOf(settingsCtx.settings)
    if (legacy === undefined) {
      ctx.logger.warn('dsh-workbuddy-connect: host settings service has no installSection API; per-variant settings and the maximum-context preference are unavailable')
      return
    }
    legacySettingsAvailable = true
    /** Section sources; each falls back to its own slice when its side unloads. */
    const sources: { cn: () => Config, ai: () => Config } = {
      cn: () => config,
      ai: () => config,
    }
    /** Merge both sections into the whole config the rest of the plugin reads. */
    const merged = (): Config => ({
      ...sources.cn().authFile === undefined ? {} : { authFile: sources.cn().authFile },
      ...sources.cn().probeConsent === undefined ? {} : { probeConsent: sources.cn().probeConsent },
      ...sources.ai().authFileAI === undefined ? {} : { authFileAI: sources.ai().authFileAI },
      ...sources.ai().useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: sources.ai().useMaximumContextWindow },
    })
    const applyMaximumContextWindow = (next: Config): void => {
      const runtime = runtimes.find(candidate => candidate.variant.id !== CN_VARIANT.id)
      if (runtime?.catalog.setUseMaximumContextWindow(next.useMaximumContextWindow === true)) runtime.invalidate()
    }
    const repointStores = (): void => {
      const next = merged()
      applyMaximumContextWindow(next)
      for (const runtime of runtimes) {
        runtime.store.setDesktopPath(configuredAuthFile(next, runtime.variant))
      }
    }
    legacy.installSection(ctx, WORKBUDDY_SETTINGS_NS, CN_SECTION, config, {
      setSource(source: () => Config) { sources.cn = source; current = merged },
      onChange: repointStores,
    })
    legacy.installSection(ctx, WORKBUDDY_AI_SETTINGS_NS, AI_SECTION, config, {
      setSource(source: () => Config) { sources.ai = source; current = merged },
      onChange: repointStores,
    })
    // No install-time apply here: the real 0.1.5/0.1.6 `installSection` fires
    // `onChange()` once synchronously at install (dsh-settings 0.1.6 calls it
    // unconditionally right after `setSource`), so a restored preference
    // already reaches `repointStores` through that first notification.
    // Calling it again would only repeat the work.
    setMaximumContextWindow = async enabled => {
      await legacy.update(WORKBUDDY_AI_SETTINGS_NS, { useMaximumContextWindow: enabled })
      return { state: 'updated' }
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
          adoptIdentity(runtime, resolvedIdentity, visibilityAccountOf(credential))
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
          adoptIdentity(runtime, latestIdentity, latest === undefined ? undefined : visibilityAccountOf(latest))
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
      adoptIdentity(runtime, undefined, undefined)
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

    adoptIdentity(runtime, identity, visibilityAccountOf(credential))
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  void Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime))).then(() => {
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
