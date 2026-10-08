/**
 * The `workbuddy` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
 * extension points the way `dsh-codex-connect` assembles its Codex route.
 *
 * @module dsh-workbuddy-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyProbeRecord } from './probe-store.ts'
import type { WorkBuddyShim } from './shim.ts'
import { normalizeCredits } from './upstream.ts'

/** Provider route this bundle owns. */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2. They bound requests to models whose catalog
 * entry declares `supportsImages`; text-only models never receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The workbuddy route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * Translate the request-image contract across the two attachment-service
 * generations a link-installed plugin can straddle.
 *
 * A `link:` install resolves its platform imports from the *repository's*
 * node_modules (Node follows the symlink's real path), so this adapter always
 * runs against the pi-ai it was built with — while the attachment service
 * comes from the host. Those two generations disagree on what
 * `readImageRequest(ref, policyOrTarget)` receives:
 *
 * - dsh-attachment-local ≤0.1.5: a route policy `{ maxPixels, maxBytes }`,
 *   and `validatePolicy` throws `Image request maxPixels must be a positive
 *   integer.` when `maxPixels` is missing.
 * - 0.1.6+: a per-image target `{ width, height, maxBytes }` with no
 *   `maxPixels` at all, validated by `validateTarget`.
 *
 * A 0.1.6-built pi-ai on a 0.1.5 host therefore hands the old store a target
 * the old store rejects, and every image-bearing request fails before it is
 * sent. The wrapper below fills the route's own pixel budget into a target
 * that lacks it: the 0.1.5 store then computes the same dimensions pi-ai's
 * budget already chose, and a 0.1.6 store ignores the extra key.
 */
function withLegacyImageBudget(store: AttachmentStore): AttachmentStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'imageHostPath') {
        // The access resolver calls through this proxy; keep the concrete
        // store as `this` for implementations that use private fields.
        return target.imageHostPath.bind(target)
      }
      if (property !== 'readImageRequest') return Reflect.get(target, property, receiver)
      return (...args: Parameters<AttachmentStore['readImageRequest']>) => {
        const [ref, policy, signal] = args
        // The ≤0.1.5 store's own validity rule is "safe integer AND positive";
        // a present-but-non-positive maxPixels would pass an isSafeInteger-only
        // check and still be rejected there, so it is replaced too.
        const present = (policy as { maxPixels?: number } | undefined)?.maxPixels
        const withPixels = Number.isSafeInteger(present) && (present as number) > 0
          ? policy
          : { ...policy, maxPixels: REQUEST_IMAGE_BUDGETS.requestImagePixelBudget } as typeof policy
        return target.readImageRequest(ref, withPixels, signal)
      }
    },
  })
}

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
 * separator would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * Append the billing rate to one model's display name.
 *
 * The rate AND the declared promo badges ride the *name* alone: since DSH
 * 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
 * `description` is no longer read there at all (the 0.1.1-era client rendered
 * it, which is why the badges used to be visible in the seat). The `/model`
 * popup renders the name too, so a separate `description` copy would either
 * duplicate (rate) or vanish (badges) depending on client generation.
 *
 * This is display-only and cannot affect routing: the wire request is built
 * from `model.id` (pi-ai's completions API sets `model: model.id`), the
 * selection a picker submits is `{provider, model: id, reasoningEffort}`, and
 * `dsh-llm` validates `name` as a non-empty string without comparing its
 * contents. Nothing in the host resolves a model *by* name.
 */

/**
 * The catalog display suffix: the billing rate followed by the declared promo
 * badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
 * The badge labels are the upstream's own spellings and the host seam has no
 * locale service, so non-Chinese UIs see them verbatim — accepted until the
 * picker grows a localized badge slot.
 */
function displaySuffix(info: WorkBuddyModelInfo): string | undefined {
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: WorkBuddyModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  providerId?: string
  displayName?: string
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Resolve one image's path in the current model-tool execution world. */
  resolveImageAccess?: NonNullable<PiAiAdapterOptions['resolveImageAccess']>
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined
  /**
   * Model ids the current account has hidden from the picker, resolved per
   * read so an account switch is honored without rebuilding the adapter.
   *
   * Hiding is a *listing* concern only: `buildModels()` keeps serving the full
   * catalog because pi-ai's `resolveModel`/`prepareCall` resolve from the same
   * snapshot `listModels` reads — filtering the descriptors there would make a
   * hidden model unresolvable and break sessions already using it. The filter
   * therefore lives in this adapter's `listModels` override alone.
   */
  hidden?: () => readonly string[]
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
 * unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
 *
 * Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
 *
 * 1. **The declared set.** When the upstream declares a non-empty
 *    `supportedEfforts`, exactly those values are offered and nothing else.
 *    This always wins: an observation never widens or narrows a declared set.
 * 2. **A local observation.** Rows without a declared set (the older
 *    `{effort, summary}` shape) normally get no control at all — their
 *    selectable set is client-side knowledge the catalog does not carry, and
 *    the desktop app differs per model there. If the user authorized a probe
 *    and it established that the upstream *validates* the parameter, the
 *    verified spellings are offered.
 *
 * A `non-validating` observation deliberately yields no control: the upstream
 * accepts values that cannot exist (measured on `glm-5.2`), so every per-level
 * acceptance it produced would be a false positive.
 *
 * `off` is offered only when the upstream declares `canDisableThinking: true`.
 * It is never probed — disabling thinking is a separate capability, and the
 * per-model acceptance of `off` cannot be inferred from the row's shape.
 *
 * The offered set is described internally as "verified accepted", never as
 * "verified effective": acceptance proves the upstream did not reject the
 * spelling, not that it changes what the model does.
 */
export function reasoningFields(
  info: WorkBuddyModelInfo,
  observed?: WorkBuddyProbeRecord,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts
  const efforts = declared !== undefined && declared.length > 0
    ? declared
    // Only a validating observation may supply a set, and only for rows the
    // upstream left undeclared.
    : observed?.validation === 'validating' && observed.efforts.length > 0
      ? observed.efforts
      : undefined
  if (efforts === undefined) {
    // Undeclared and unobserved (or observed as non-validating): no thinking
    // control, and no `reasoning_effort` on the wire.
    return { reasoning: false }
  }
  const map: Record<ModelThinkingLevel, string | null> = {
    // Probing never grants `off`; only an explicit declaration does.
    //
    // `onlyReasoning` vetoes it even when declared (#87). The CN catalog ships
    // both flags true on `deepseek-v4.1-flash` and `kimi-k2.8-preview`, which
    // cannot both hold — a model that only ever reasons has no non-thinking
    // mode to select — and the endpoint sides with `onlyReasoning`, answering
    // HTTP 400 (「模型不支持该思考强度」) for every `off` request. Offering a
    // level that is certain to fail is worse than not offering it, so the
    // contradiction is resolved toward the flag the wire agrees with.
    //
    // The request layer strips the spelling too (`dropUnsupportedEffort`), so
    // this is defence in depth rather than the only guard: a model whose flags
    // flip between catalog reads still cannot put `off` on the wire.
    off: reasoning.canDisableThinking === true && reasoning.onlyReasoning !== true
      && declared !== undefined && declared.length > 0 ? 'off' : null,
    // `minimal` is not in the upstream effort vocabulary (EFFORT_VALUES), so
    // no declared set — and no probe candidate — can ever contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string, observed?: WorkBuddyProbeRecord, providerId = WORKBUDDY_PROVIDER): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info, observed),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    // pi-ai cannot infer WorkBuddy's field spelling from the shim's random
    // loopback URL, so name the upstream-required field explicitly.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface (root entry, `lib/` deep imports blocked by the
 * exports map, `src/` not shipped), so hand-assembly is the only supported
 * path and every newly required field must be adopted here explicitly —
 * `modelErrors` since 0.1.5-alpha.2 (#12).
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, store, catalog, resolveAttachments, resolveImageAccess, observe, hidden } = options
  const providerId = options.providerId ?? WORKBUDDY_PROVIDER
  const displayName = options.displayName ?? 'WorkBuddy'

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, observe?.(info.id), providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required since 0.1.5-alpha.2; the live catalog only exposes models that
    // probed successfully, so there is never a per-model failure to report.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new WorkBuddyPiAiAdapter(catalog, hidden ?? (() => []), {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    // Every store the adapter hands to pi-ai passes the legacy-budget wrapper:
    // see withLegacyImageBudget — the mismatch it heals depends on which host
    // generation owns the attachment service, not on anything observable here.
    ...resolveAttachments === undefined
      ? {}
      : {
        resolveAttachments: () => {
          const store = resolveAttachments()
          return store === undefined ? undefined : withLegacyImageBudget(store)
        },
      },
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/**
 * The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
 * from the pi-ai descriptors, which carry no billing fact, so the rate is
 * layered on here by looking the model up in the live catalog. Both overrides
 * delegate to `super` and then rewrite only the display fields, so streaming,
 * capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
 * implements them.
 *
 * A model missing from the catalog (an id the shim would serve but the last
 * upstream refresh did not list) falls through with its name untouched rather
 * than being dropped: catalog membership is advisory, and the seam tolerates
 * serving an unlisted id.
 */
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: WorkBuddyCatalog,
    private readonly hidden: () => readonly string[],
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): WorkBuddyModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    // Resolved fresh per call: the picker reads this after every
    // `llm/adapters-updated`, so an account switch or a toggle takes effect on
    // the next read without rebuilding anything.
    const hidden = new Set(this.hidden())
    return models.flatMap(model => {
      // Selectability only — `resolveModel` below deliberately does not apply
      // this filter, so a session already using a hidden model keeps working.
      if (hidden.has(model.id)) return []
      const info = this.infoFor(model.id)
      if (info === undefined) return [model]
      return [{ ...model, name: withCatalogDisplay(model.name, info) }]
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}
