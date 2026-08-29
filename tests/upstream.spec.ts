import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

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
    })
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
