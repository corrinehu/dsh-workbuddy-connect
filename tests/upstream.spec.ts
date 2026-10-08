import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { classifyUpstreamError, extractDisplayErrorMessage, normalizeCredits, parseModelCatalog, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Offline unit tests for WorkBuddyUpstreamClient, mocking the global `fetch`
 * so the multi-layer response parsing and the credit-remain selection logic in
 * `fetchCredits` are covered without a real account or network. This closes a
 * gap that previously relied solely on `scripts/live-e2e.mjs`.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** Build the nested upstream billing document that `fetchCredits` unwraps. */
function billingEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: accounts,
        },
      },
    },
  })
}

/** Minimal Response-like object satisfying `readEnvelope` (which calls `.text()`). */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  /** Build the models-catalog envelope that `fetchModels` unwraps. */
  function modelsEnvelope(models: unknown[], cliIds: string[]): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models,
        agents: [{ name: 'cli', models: cliIds }],
      },
    })
  }

  it('propagates supportsImages per model, treating unknown or disabled as text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-img', name: 'Image Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
      { id: 'm-muted', name: 'Multimodal Switched Off', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true, disabledMultimodal: true },
      { id: 'm-text', name: 'Text Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'm-unknown', name: 'No Modality Field', maxInputTokens: 100_000, maxOutputTokens: 32_000 },
      { id: 'm-noncli', name: 'Not A CLI Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-img', 'm-muted', 'm-text', 'm-unknown']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(models).toHaveLength(4)
    expect(byId.get('m-img')?.supportsImages).toBe(true)
    expect(byId.get('m-muted')?.supportsImages).toBe(false)
    expect(byId.get('m-text')?.supportsImages).toBe(false)
    // Absent field means unknown capability; the conservative answer is text-only.
    expect(byId.get('m-unknown')?.supportsImages).toBe(false)
  })

  it('keeps the catalog shape (name, contextWindow, maxTokens) alongside the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-1', name: 'Model One', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-1']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'm-1',
      name: 'Model One',
      contextWindow: 168_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
      billing: { free: false },
    })
  })

  it('parses reasoning and billing metadata from the upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-reason',
        name: 'Reasoner',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
      },
      {
        id: 'm-free',
        name: 'Freebie',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: { canDisableThinking: false },
        credits: 'x0.00',
        tags: ['craft', 'badge:限时免费:#FF0000'],
      },
      {
        id: 'm-plain',
        name: 'Plain',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
      },
    ], ['m-reason', 'm-free', 'm-plain']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(byId.get('m-reason')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(byId.get('m-free')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    })
    expect(byId.get('m-free')?.billing).toEqual({ credits: 'x0.00', badges: ['限时免费'], free: true })
    // A model with no reasoning or billing fields is explicitly non-reasoning
    // (supports: false) and carries no free/badge facts.
    expect(byId.get('m-plain')?.reasoning).toEqual({
      supports: false,
      onlyReasoning: false,
      canDisableThinking: true,
    })
    expect(byId.get('m-plain')?.billing).toEqual({ free: false })
  })

  it('judges `free` from the normalized multiplier, so `x0.00 credits` counts as free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-suffix', name: 'Suffixed', maxInputTokens: 100_000, maxOutputTokens: 32_000, credits: 'x0.00 credits' },
      { id: 'm-paid-suffix', name: 'Paid Suffixed', maxInputTokens: 100_000, maxOutputTokens: 32_000, credits: 'x0.79 credits' },
    ], ['m-suffix', 'm-paid-suffix']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('m-suffix')?.billing).toEqual({ credits: 'x0.00 credits', free: true })
    expect(byId.get('m-paid-suffix')?.billing).toEqual({ credits: 'x0.79 credits', free: false })
  })
})

describe('WorkBuddyUpstreamClient.fetchCredits', () => {
  it('unwraps the nested envelope and aggregates total across accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      { PackageName: 'pkg-b', CycleCapacitySize: 200, CycleCapacityRemain: 60 },
    ]))))

    const client = new WorkBuddyUpstreamClient()
    const credits = await client.fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(100)
    expect(credits.accounts).toHaveLength(2)
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg-a', remain: 40, size: 100 })
    expect(credits.accounts[1]).toEqual({ packageName: 'pkg-b', remain: 60, size: 200 })
  })

  it('selects cycle remain when size > 0 (first branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 30, CapacityRemain: 999 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // First branch: size>0 → cycleRemain, ignoring the larger CapacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 30, size: 100 })
  })

  it('selects cycle remain when there is cycle usage even without size (second branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 0, CycleCapacityRemain: 20, CycleCapacityUsed: 5, CapacityRemain: 1 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Second branch: size<=0 but cycleUsed>0 → cycleRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 20, size: 0 })
  })

  it('falls back to capacity remain when no cycle fields (third branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacityRemain: 77 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Third branch: no size, no cycle → capacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 77, size: 0 })
  })

  it('clamps a negative remain to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: -50 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('falls back to CapacitySize for size when cycle size is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacitySize: 500, CapacityRemain: 120 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // size falls back to CapacitySize=500; remain from third branch = 120.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 120, size: 500 })
  })

  it('labels a missing package name as (unnamed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { CycleCapacitySize: 10, CycleCapacityRemain: 5 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.packageName).toBe('(unnamed)')
  })

  it('returns an empty list for an empty Accounts array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([])
  })

  it('skips non-object account entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      null,
      'not-an-object',
      42,
      { PackageName: 'valid', CycleCapacitySize: 10, CycleCapacityRemain: 7 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]!.packageName).toBe('valid')
  })

  it('throws when the upstream business code is non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      JSON.stringify({ code: 1, msg: 'billing error' }),
    )))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/billing error/)
  })

  it('throws when the upstream returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('not json')))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
  })
})

/**
 * CN enterprise accounts are served by a different endpoint than personal
 * ones; asking the personal endpoint for an enterprise account answers with an
 * empty `Accounts` list, which renders as a confident "0 credit" (issue #31).
 *
 * The personal-path expectations above double as the zero-regression guard:
 * they run on `CREDENTIAL`, which carries no `enterpriseId`.
 */
describe('WorkBuddyUpstreamClient.fetchCredits (CN enterprise)', () => {
  const ENTERPRISE: WorkBuddyCredential = { ...CREDENTIAL, enterpriseId: 'ent-1' }

  /** The enterprise answer: a single cycle quota, not a package list. */
  function enterpriseEnvelope(fields: Record<string, unknown>): string {
    return JSON.stringify({ code: 0, msg: 'OK', data: fields })
  }

  it('requests the enterprise endpoint instead of the personal one', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage')
    expect(url).not.toContain('get-user-resource')
  })

  it('sends the enterprise identity headers and an empty body', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string>; body: string }
    expect(init.headers['X-Enterprise-Id']).toBe('ent-1')
    expect(init.headers['X-Tenant-Id']).toBe('ent-1')
    // Identity travels in the headers only; the body stays an empty object.
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('reads camelCase quota fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
    expect(credits.unlimited).toBeUndefined()
  })

  it('reads snake_case quota fields (the app has both spellings)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limit_num: 500, used_num: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
  })

  it('marks limitNum -1 as unlimited rather than a negative balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
    // Never a negative number, and never a zero that reads as "exhausted".
    expect(credits.total).toBe(0)
    expect(credits.accounts[0]!.remain).toBe(0)
  })

  it('clamps remaining quota to zero when usage exceeds limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 600 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 0, size: 500 }])
  })

  it('parses cycleResetTime when present in the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({
      limitNum: 500, credit: 120, cycleResetTime: '2026-10-01T00:00:00Z',
    }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.cycleResetTime).toBe('2026-10-01T00:00:00Z')
  })

  it('throws a diagnosable error when no quota field is recognised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ unexpected: 'shape' }))))

    // Must be a hard error: silently returning 0 is what hid issue #31.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised quota field/)
  })

  it('throws when a limit arrives without any recognised usage field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500 }))))

    // Defaulting the missing usage to 0 would render a confident "500 remaining"
    // from a half-read response: the same wrong-but-plausible number the
    // enterprise branch exists to prevent.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('throws when the usage field is present but not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: '120' }))))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('reports the received fields when the usage field is missing, without values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ limitNum: 500, secretUsed: 4242 }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    expect(error?.message).toContain('secretUsed:number')
    expect(error?.message).not.toContain('4242')
  })

  it('still accepts an explicit zero usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 0 }))))

    // Zero used is a real reading and must not be mistaken for a missing field.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(500)
    expect(credits.unlimited).toBeUndefined()
  })

  it('does not require a usage field when the quota is uncapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1 }))))

    // An uncapped reading has no balance to subtract, so a missing used amount
    // is not a parse failure here.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
  })

  it('names the received fields in that error, without their values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ secretQuota: 998877, accountLabel: 'should-not-leak' }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    // Field names and types are the diagnostic; values must not travel, since
    // this message reaches the browser and describes the account's usage.
    expect(error?.message).toContain('secretQuota:number')
    expect(error?.message).not.toContain('998877')
    expect(error?.message).not.toContain('should-not-leak')
  })

  it('keeps a personal credential on the personal endpoint', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('get-user-resource')
    expect(credits.total).toBe(40)
  })

  it('keeps an international credential on the personal endpoint even with an enterpriseId', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    // The global enterprise endpoint is unverified, so the region gate must
    // hold: an international credential stays on the measured personal path.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits({
      ...CREDENTIAL,
      domain: 'www.workbuddy.ai',
      enterpriseId: 'ent-global',
    })

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('workbuddy.ai')
    expect(url).toContain('get-user-resource')
    expect(url).not.toContain('get-enterprise-user-usage')
    expect(credits.total).toBe(40)
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier untouched', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.00')).toBe('x0.00')
  })

  it('strips a trailing credits unit word', () => {
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 credits')).toBe('x1.62')
    expect(normalizeCredits('x0.79 CREDITS')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or empty values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})

describe('CN catalog: /v3/config roster, badge merge, and fallback consistency', () => {
  /**
   * The CN roster comes from the `/v3/config` product document — the same one
   * the desktop App's own selector reads — and the roster churns day to day,
   * so the static fallback in `catalog.ts` is only a boot-time placeholder.
   * This suite pins the mechanism (roster ∩ usable rows, badges merged from
   * the console document) and pins the fallback table itself to the same
   * parse, so the two cannot drift apart silently.
   */

  /** Raw `/v3/config` rows for the 2026-09-23 CN roster, verbatim from the live document. */
  const LIVE_ROWS: readonly Record<string, unknown>[] = [
    { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['high'] }, credits: 'x0.29 credits' },
    { id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.00 credits' },
    { id: 'hy3-x', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.05 credits' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.03 credits' },
    { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.06 credits' },
    { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.71 credits' },
    { id: 'minimax-m3', name: 'MiniMax-M3', maxInputTokens: 512_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.25 credits' },
    { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.19 credits' },
    { id: 'kimi-k3-1', name: 'Kimi-K3', maxInputTokens: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x1.62 credits' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.77 credits' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.57 credits' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.52 credits' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.51 credits' },
  ]
  const LIVE_ROSTER = LIVE_ROWS.map(row => String(row['id']))
  /** Badge tags live only in the console document; verbatim from the same day. */
  const CONSOLE_BADGES = new Map<string, readonly string[]>([
    ['hy4-preview', ['badge:夜间免费:#FF0000']],
    ['hy3', ['badge:限时免费:#FF0000']],
    ['glm-5.2', ['badge:夜间折扣:#1E90FF']],
    ['deepseek-v4.1-flash', ['badge:独家优惠:#FF0000']],
  ])

  it('membership is the cli roster intersected with usable rows', () => {
    // A retired roster id with no row, a disabled row, and a zero-capped row
    // must all drop out; published-but-unservable ids never reach the picker.
    const document = {
      models: [
        ...LIVE_ROWS,
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5', maxInputTokens: 200_000, maxOutputTokens: 48_000, disabled: true, supportsReasoning: true, onlyReasoning: true },
        { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', maxInputTokens: 0, maxOutputTokens: 0 },
      ],
      agents: [{ name: 'cli', models: [...LIVE_ROSTER, 'kimi-k2.5'] }],
    }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models.map(model => model.id)).toEqual(LIVE_ROSTER)
  })

  it('merges the console document’s badge tags without trusting it for anything else', () => {
    const document = {
      models: LIVE_ROWS.filter(row => row['id'] === 'hy3'),
      agents: [{ name: 'cli', models: ['hy3'] }],
    }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })
  })

  it('the static fallback equals the live parse of the day it was captured', () => {
    // THE CONSISTENCY PIN: the fallback table must equal what the parser
    // produces from the raw document the table was transcribed from, on every
    // stable field — membership, order, metadata, credits, free flag.
    // Promotional badges are the deliberate exception: they are dynamic
    // console-side promotions, so they ride the live merge only and are
    // stripped here before the comparison. (The other deviation is
    // display-only: the fallback renames `hy3-x`, which the document names
    // "Hy3", and the parse cannot know to do that.)
    const document = { models: LIVE_ROWS, agents: [{ name: 'cli', models: LIVE_ROSTER }] }
    const parsed = parseModelCatalog(document, false, CONSOLE_BADGES)
    const stable = parsed.map(model => {
      const { badges: _badges, ...billing } = model.billing ?? {}
      return { ...model, billing }
    })
    const fallback = FALLBACK_WORKBUDDY_MODELS.map(model => model.id === 'hy3-x' ? { ...model, name: 'Hy3' } : model)
    expect(stable).toEqual(fallback)
    // The badges themselves stay live-only, never baked into the fallback.
    expect(FALLBACK_WORKBUDDY_MODELS.every(model => model.billing?.badges === undefined)).toBe(true)
    expect(parsed.filter(model => model.billing?.badges !== undefined).map(model => model.id).sort())
      .toEqual(['deepseek-v4.1-flash', 'glm-5.2', 'hy3', 'hy4-preview'])
  })
})

describe('WorkBuddyUpstreamClient.fetchModels badge merge', () => {
  it('reads the console document once for badges and ships without them when it fails', async () => {
    const calls: string[] = []
    const configEnvelope = JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        models: [{ id: 'm-1', name: 'Model One', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsReasoning: true, onlyReasoning: true, credits: 'x0.00 credits' }],
        agents: [{ name: 'cli', models: ['m-1'] }],
      },
    })
    const consoleEnvelope = JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm-1', tags: ['badge:限时免费:#FF0000', 'not-a-badge'] }] },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url instanceof Request ? url.url : url))
      return fakeResponse(calls.length === 1 ? configEnvelope : consoleEnvelope)
    }))
    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    // Second request is the console badge read, against the same CN base.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('/console/enterprises/personal/models')
    expect(calls[0]).toContain('/v3/config')
    expect(models[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })

    // A console failure costs the badge, never the catalog.
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url instanceof Request ? url.url : url))
      if (calls.length === 1) return fakeResponse(configEnvelope)
      throw new Error('console endpoint offline')
    }))
    const withoutBadges = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(calls).toHaveLength(2)
    expect(withoutBadges.map(model => model.id)).toEqual(['m-1'])
    expect(withoutBadges[0]?.billing).toEqual({ credits: 'x0.00 credits', free: true })
  })
})

describe('chatStream wire effort by region (issue #49)', () => {
  /**
   * THE REGION-SPLIT ACCEPTANCE: judged on the request that actually leaves
   * `chatStream`, not on any intermediate helper. Both regions drop the
   * adapter's own `off` spelling and nothing else — the CN half used to be
   * exempt by an explicit scope decision, which #87 invalidated.
   */
  const AI_CREDENTIAL: WorkBuddyCredential = { ...CREDENTIAL, domain: 'www.workbuddy.ai' }

  /** Capture the body chatStream sends for one credential + effort value. */
  async function wireEffort(credential: WorkBuddyCredential, effort: string | undefined): Promise<unknown> {
    const calls: { body?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return fakeResponse('')
    }))
    const body: Record<string, unknown> = {
      model: 'probe-model',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
    }
    if (effort !== undefined) body['reasoning_effort'] = effort
    const result = await new WorkBuddyUpstreamClient().chatStream(credential, JSON.stringify(body))
    expect(result.ok).toBe(true)
    return calls[0]?.body === undefined ? undefined : (calls[0].body as Record<string, unknown>)['reasoning_effort']
  }

  it('drops the `off` spelling in both regions (issue #49 for global, #87 for CN)', async () => {
    // CN used to pass `off` through by an explicit scope decision. #87 measured
    // that endpoint rejecting it on `deepseek-v4.1-flash` (400 / 11150), which
    // invalidated the premise, so the strip is no longer region-scoped.
    expect(await wireEffort(CREDENTIAL, 'off')).toBeUndefined()
    expect(await wireEffort(AI_CREDENTIAL, 'off')).toBeUndefined()
  })

  it('omits the field entirely for `off` rather than substituting another spelling', async () => {
    // `none` is the tempting substitute and is *not* safe: accepted by the
    // GPT-5.6 family and GLM, rejected by `gpt-6-astra` (#49).
    const captured: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return fakeResponse('')
    }))
    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, JSON.stringify({
      model: 'probe-model',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    expect(result.ok).toBe(true)
    expect('reasoning_effort' in (captured[0] ?? {})).toBe(false)
    expect(captured[0]?.['model']).toBe('probe-model')
  })

  it('declared spellings and `none` are untouched in both regions', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      expect(await wireEffort(CREDENTIAL, effort)).toBe(effort)
      expect(await wireEffort(AI_CREDENTIAL, effort)).toBe(effort)
    }
  })
})

describe('extractDisplayErrorMessage (PR #58)', () => {
  it('extracts zh displayMsg from structured JSON', () => {
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      displayMsg: {
        zh: '内容未通过安全审核，请调整后重试。',
        en: 'The content did not pass the safety review. Please adjust and retry.',
      },
    })
    expect(extractDisplayErrorMessage(raw)).toBe('内容未通过安全审核，请调整后重试。')
  })

  it('falls back to en displayMsg when zh is missing', () => {
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      displayMsg: { en: 'The content did not pass the safety review. Please adjust and retry.' },
    })
    expect(extractDisplayErrorMessage(raw)).toBe('The content did not pass the safety review. Please adjust and retry.')
  })

  it('falls back to msg when displayMsg is absent', () => {
    const raw = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' })
    expect(extractDisplayErrorMessage(raw)).toBe('Illegal API invocation from an unapproved channel')
  })

  it('returns undefined for non-JSON or malformed bodies', () => {
    expect(extractDisplayErrorMessage('502 Bad Gateway')).toBeUndefined()
    expect(extractDisplayErrorMessage('')).toBeUndefined()
    expect(extractDisplayErrorMessage('{ invalid json')).toBeUndefined()
  })
})

describe('auth-failure classification beside the status-note policy (PR #58 review)', () => {
  it('classifies every 401 as session_dead even without a body marker', () => {
    // The status-note policy hides `401`/`403` from business errors; a bare
    // 401 must therefore never fall through to `client`, or its error text
    // would lose the AUTH signal the host keys on.
    expect(classifyUpstreamError(401, 'whatever the body says')).toBe('session_dead')
    expect(classifyUpstreamError(401, '')).toBe('session_dead')
  })

  it('still classifies a markerless 403 as a business error', () => {
    expect(classifyUpstreamError(403, JSON.stringify({ code: 11140, msg: 'request illegal' }))).toBe('client')
  })

  it('still recognises dead sessions carried by markers on other statuses', () => {
    expect(classifyUpstreamError(403, 'Offline user session not found')).toBe('session_dead')
    expect(classifyUpstreamError(200, JSON.stringify({ code: 12153 }))).toBe('session_dead')
  })
})
