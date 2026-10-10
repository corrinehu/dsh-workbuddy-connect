/**
 * First-turn regression for the CN `off` wire defect (#87 family).
 *
 * @qiwuyi's report on #87 is the case these cover: a brand-new session, first
 * message, reasoning level never touched — and the request still fails. The
 * level was never chosen, so nothing in the picker can be blamed; the plugin's
 * own `thinkingLevelMap.off` supplies a spelling for a request that carries no
 * explicit effort, and pi-ai sends it.
 *
 * **What layer this captures.** The `fetch` these tests stub is the adapter's
 * own outbound hop: the plugin POSTs to the loopback shim, and the shim is what
 * calls `chatStream` and applies `prepareCnChatBody`. So the body asserted here
 * is the **pre-shim** body — the plugin's last word before the shim, not the
 * bytes that reach WorkBuddy. The final wire body is covered separately, by
 * `tests/upstream.spec.ts` (the `chatStream` body) and `tests/prepare.spec.ts`
 * (the region-scoped strip). Both layers are asserted here so the split is
 * explicit rather than implied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCatalog as WorkBuddyCatalogType, WorkBuddyModelInfo } from '../src/catalog.ts'
import { prepareCnChatBody, prepareInternationalChatBody } from '../src/upstream.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyRegion } from '../src/upstream.ts'

afterEach(() => vi.unstubAllGlobals())

/**
 * CN's `deepseek-v4.1-flash` as #87/@qiwuyi observed it on 2026-10-09:
 * `onlyReasoning: true` **and** `canDisableThinking: true` — a self-contradicting
 * pair — with three offered levels.
 *
 * `canDisableThinking: true` is load-bearing here. It is what makes
 * `reasoningFields` put a non-null `off` in the map; with `false` the map's
 * `off` is null and pi-ai has no `off` spelling to send, so a "no explicit
 * effort" request would carry no `reasoning_effort` even WITHOUT the region
 * veto. Writing `false` would therefore let the first test pass for the wrong
 * reason. The live row's value is `true`, and this fixture matches it.
 */
const CN_FLASH: WorkBuddyModelInfo = {
  id: 'deepseek-v4.1-flash',
  name: 'Deepseek-V4.1-Flash',
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  supportsImages: true,
  reasoning: {
    supports: true,
    onlyReasoning: true,
    supportedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    canDisableThinking: true,
  },
  billing: { free: false },
}

/**
 * A CN row whose declaration is internally consistent: it can be disabled and
 * does not claim to only reason. CN's veto has no reason to fire, so `off` is a
 * real, offerable level here — the "legitimate level must survive" case.
 */
const CN_FLASH_DECLARED: WorkBuddyModelInfo = {
  ...CN_FLASH,
  reasoning: {
    supports: true,
    onlyReasoning: false,
    supportedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    canDisableThinking: true,
  },
}

function adapterFor(model: WorkBuddyModelInfo, region: WorkBuddyRegion) {
  const catalog: WorkBuddyCatalogType = new WorkBuddyCatalog([model])
  return createWorkBuddyAdapter({
    providerId: WORKBUDDY_PROVIDER,
    region,
    catalog,
    store: {} as WorkBuddyCredentialStore,
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'test-token',
      close: async () => {},
    } as WorkBuddyShim,
    resolveAttachments: () => ({}) as never,
  }).adapter
}

/**
 * Send one first-turn request that names no reasoning level, and return the
 * serialized body the plugin would put on the wire.
 */
async function firstTurnBody(
  model: WorkBuddyModelInfo,
  region: WorkBuddyRegion,
  streamOptions: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const adapter = adapterFor(model, region)
  let body: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const call = await adapter.prepareCall(WORKBUDDY_PROVIDER, model.id)
  for await (const _chunk of call.stream({
    provider: WORKBUDDY_PROVIDER,
    model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...streamOptions,
  })) {
    // The serialized request is the contract under test.
  }
  if (body === undefined) throw new Error('the adapter never reached fetch')
  return body
}

/** The thinking-level map the adapter hands pi-ai for its single catalog row. */
function thinkingLevelMapFor(
  model: WorkBuddyModelInfo,
  region: WorkBuddyRegion,
): Partial<Record<string, string | null>> | undefined {
  const adapter = adapterFor(model, region)
  const snapshot = (adapter as unknown as {
    current(): {
      models: {
        getModel(provider: string, id: string): {
          thinkingLevelMap?: Partial<Record<string, string | null>>
        } | undefined
      }
    }
  }).current()
  return snapshot.models.getModel(WORKBUDDY_PROVIDER, model.id)?.thinkingLevelMap
}

describe('first-turn requests with no reasoning level chosen', () => {
  it('sends no reasoning_effort for the CN contradictory row (#87, @qiwuyi)', async () => {
    // The user touched nothing: no `reasoningEffort` is passed in. Without the
    // fix, the map's `off` entry turns into `reasoning_effort: "off"` here.
    const body = await firstTurnBody(CN_FLASH, 'cn')
    expect('reasoning_effort' in body).toBe(false)
  })

  it('offers no Off level for that row, so the picker cannot select one', async () => {
    // The capability layer half of the fix. `onlyReasoning` wins the
    // contradiction, which is what the CN endpoint enforces.
    expect(thinkingLevelMapFor(CN_FLASH, 'cn')?.['off']).toBeNull()
  })

  it('keeps a declared level on the wire when the caller does choose one', async () => {
    // The fix must not flatten every request to "no effort": an explicit,
    // legal level still travels.
    const body = await firstTurnBody(CN_FLASH_DECLARED, 'cn', { reasoningEffort: 'high' })
    expect(body['reasoning_effort']).toBe('high')
  })

  it('never puts the off spelling on the wire even if it is requested', async () => {
    // The adapter hands pi-ai the spelling (`off` is a declared level on this
    // row), and the request layer is what removes it before the upstream sees
    // it. Assert both halves, since that split is the fix.
    const body = await firstTurnBody(CN_FLASH_DECLARED, 'cn', { reasoningEffort: 'off' })
    expect(body['reasoning_effort']).toBe('off')
    const wire = JSON.parse(prepareCnChatBody(JSON.stringify(body))) as Record<string, unknown>
    expect('reasoning_effort' in wire).toBe(false)
  })

  it('applies the same request-layer strip on the Global region', async () => {
    // Global keeps its Off level in the picker (#49's scope decision) but must
    // not put the spelling on the wire either.
    const body = await firstTurnBody(CN_FLASH_DECLARED, 'global', { reasoningEffort: 'off' })
    expect(body['reasoning_effort']).toBe('off')
    const wire = JSON.parse(
      prepareInternationalChatBody(JSON.stringify(body)),
    ) as Record<string, unknown>
    expect('reasoning_effort' in wire).toBe(false)
  })

  it('keeps Global offering Off while CN hides it', async () => {
    // Guards the region scoping itself: a future edit that applies the CN veto
    // globally would silently remove a level Global models can still use. The
    // row here declares `canDisableThinking`, so CN's veto is the only reason
    // the two regions disagree.
    const coherent: WorkBuddyModelInfo = {
      ...CN_FLASH_DECLARED,
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        canDisableThinking: true,
      },
    }
    expect(thinkingLevelMapFor(coherent, 'cn')?.['off']).toBeNull()
    expect(thinkingLevelMapFor(coherent, 'global')?.['off']).toBe('off')
  })
})
