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
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
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
 * The rate rides the *name* rather than only `description` because the DSH
 * model surfaces disagree about which field they render: the `/model` popup
 * shows `description` but the composer's model seat (`ModelSelect`) renders
 * `model.name` only and never reads `description`. Carrying the rate on the
 * name makes it visible in both.
 *
 * This is display-only and cannot affect routing: the wire request is built
 * from `model.id` (pi-ai's completions API sets `model: model.id`), the
 * selection a picker submits is `{provider, model: id, reasoningEffort}`, and
 * `dsh-llm` validates `name` as a non-empty string without comparing its
 * contents. Nothing in the host resolves a model *by* name.
 */
function withRate(name: string, info: WorkBuddyModelInfo): string {
  const rate = normalizeCredits(info.billing?.credits)
  return rate === undefined ? name : `${name}${RATE_SEPARATOR}${rate}`
}

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * The standard effort ladder for a model that declares no explicit
 * `supportedEfforts`. WorkBuddy's older catalog rows carry only a default
 * `effort` — no capability list — yet still accept the full standard effort
 * ladder on the wire (verified live: `low`/`medium`/`high`/`xhigh`/`max` all
 * return 200). `workbuddy2api` treats such rows as unknown and passes the
 * effort through untouched. Offering the full ladder (minus `off`, which is
 * only selectable when the model explicitly says thinking can be disabled)
 * keeps the DSH picker aligned with what the upstream actually accepts.
 */
const UNSPECIFIED_EFFORTS: readonly ModelThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
 * unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
 *
 * Per-model handling:
 * - A model that declares explicit `supportedEfforts` offers exactly those.
 * - A model that declares none (the older `{effort, summary}` shape) is not
 *   capability-restricted by the upstream, so it offers the full standard
 *   ladder.
 * - `off` is offered only when the model explicitly reports thinking can be
 *   disabled (`canDisableThinking === true`); older rows leave it unsupported,
 *   since the upstream rejects `off` on several of them.
 */
function reasoningFields(info: WorkBuddyModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const efforts = reasoning.supportedEfforts?.length !== undefined && reasoning.supportedEfforts.length > 0
    ? reasoning.supportedEfforts
    : UNSPECIFIED_EFFORTS
  const map: Record<ModelThinkingLevel, string | null> = {
    off: reasoning.canDisableThinking === true ? 'off' : null,
    minimal: efforts.includes('minimal') ? 'minimal' : null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: WORKBUDDY_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, store, catalog, resolveAttachments } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl))
  }

  const base = createProvider({
    id: WORKBUDDY_PROVIDER,
    name: 'WorkBuddy',
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
    provider: WORKBUDDY_PROVIDER,
    displayName: 'WorkBuddy',
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDY_PROVIDER, profile]])

  const adapter = new WorkBuddyPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDY_PROVIDER, profile]])
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
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      const rate = normalizeCredits(info.billing?.credits)
      return {
        ...model,
        name: withRate(model.name, info),
        ...rate === undefined ? {} : { description: rate },
      }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    const rate = normalizeCredits(info.billing?.credits)
    return {
      ...resolved,
      name: withRate(resolved.name, info),
      ...rate === undefined ? {} : { description: rate },
    }
  }
}
