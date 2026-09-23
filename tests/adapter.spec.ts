import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'

/** The pi-ai collection built by an adapter exposes the exact model descriptor it consumes. */
interface AdapterSnapshot {
  models: {
    getModel(provider: string, model: string): {
      compat?: { maxTokensField?: string }
      thinkingLevelMap?: Partial<Record<string, string | null>>
    } | undefined
  }
}

describe('WorkBuddy adapter model descriptors', () => {
  it('uses WorkBuddy\'s max_tokens output-cap field', () => {
    const catalog = new WorkBuddyCatalog([{
      id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 128_000,
      supportsImages: false, billing: { free: false },
    }])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })

    // `current()` is private in the adapter's public API, but this is the
    // descriptor seam pi-ai reads before it serializes a request.
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(snapshot.models.getModel(WORKBUDDY_PROVIDER, 'model')?.compat?.maxTokensField).toBe('max_tokens')
  })

  it('keeps the `off` thinking level selectable when thinking can be disabled', () => {
    // `off` must stay pinned to a string: pi-ai exposes a level only when its
    // `thinkingLevelMap` entry is a string, and `null` would drop it from the
    // picker. The wire spelling is then normalized in `prepareChatBody` — see
    // `dropUnsupportedEffort` and its spec, plus issue #49.
    const catalog = new WorkBuddyCatalog([{
      id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 128_000,
      supportsImages: false, billing: { free: false },
      reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true, supportedEfforts: ['low', 'high', 'max'] },
    }])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })

    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    const model = snapshot.models.getModel(WORKBUDDY_PROVIDER, 'model')
    expect(model?.thinkingLevelMap?.off).toBe('off')
    // A model without the declaration still offers no `off` at all.
    const bare = new WorkBuddyCatalog([{
      id: 'bare', name: 'Bare', contextWindow: 1_000, maxTokens: 8_000,
      supportsImages: false, billing: { free: false },
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false, supportedEfforts: ['high'] },
    }])
    const second = createWorkBuddyAdapter({
      catalog: bare,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })
    const bareSnapshot = (second.adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(bareSnapshot.models.getModel(WORKBUDDY_PROVIDER, 'bare')?.thinkingLevelMap?.off).toBeNull()
  })
})

describe('request-image contract across host generations', () => {
  /**
   * The exact failure from docs/image-request-maxpixels-2026-09-23.md: a
   * link-installed plugin runs the pi-ai it was built with (0.1.6, which hands
   * `readImageRequest` a per-image target with no `maxPixels`) against a host
   * attachment service from ≤0.1.5 (which validates `maxPixels` and throws
   * otherwise). The adapter must fill its own route budget into a
   * pixel-less policy before the store sees it.
   */
  const IMAGE_MESSAGE = {
    id: 'test-message' as never,
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [
      { type: 'text' as const, text: 'describe' },
      { type: 'image' as const, attachment: { attachmentId: 'sha256:test', mediaType: 'image/png', width: 1, height: 1, bytes: 70 } },
    ],
  }

  function imageAdapter(store: Record<string, unknown>) {
    const catalog = new WorkBuddyCatalog([{
      id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 128_000,
      supportsImages: true, billing: { free: false },
    }])
    return createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
      resolveAttachments: () => store as never,
    }).adapter
  }

  it('fills the route pixel budget for a store that validates maxPixels (≤0.1.5 hosts)', async () => {
    let observed: unknown
    const store = {
      readImageRequest(_ref: unknown, policy: { maxPixels?: number }) {
        // The ≤0.1.5 contract, verbatim in spirit.
        if (!Number.isSafeInteger(policy.maxPixels) || (policy.maxPixels ?? 0) <= 0) {
          throw new Error('Image request maxPixels must be a positive integer.')
        }
        observed = policy
        // Sentinel past validation: proves the request survived the contract.
        throw new Error('PAST_VALIDATION')
      },
    }
    const adapter = imageAdapter(store)
    const call = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'glm-5.3')
    // The message rides dsh-llm's branded ids/media types; the test's interest
    // is the policy at the attachment boundary, not Message branding.
    const messages = [IMAGE_MESSAGE as never]
    await expect(async () => {
      for await (const _chunk of call.stream({ provider: WORKBUDDY_PROVIDER, model: 'glm-5.3', messages })) {
        // drain; the store's sentinel is expected to end the iteration
      }
    }).rejects.toThrow('PAST_VALIDATION')
    expect(observed).toMatchObject({ maxPixels: 4_194_304 })
  })

  it('passes a policy that already carries maxPixels through untouched', async () => {
    let observed: unknown
    const store = {
      readImageRequest(_ref: unknown, policy: Record<string, unknown>) {
        observed = policy
        throw new Error('PAST_VALIDATION')
      },
    }
    const adapter = imageAdapter(store)
    const call = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'glm-5.3')
    const messages = [IMAGE_MESSAGE as never]
    await expect(async () => {
      for await (const _chunk of call.stream({ provider: WORKBUDDY_PROVIDER, model: 'glm-5.3', messages })) {
        // drain
      }
    }).rejects.toThrow('PAST_VALIDATION')
    // The 0.1.6 target shape reached the store with only the budget added.
    expect(observed).toMatchObject({ width: 1, height: 1, maxBytes: 1_048_576, maxPixels: 4_194_304 })
  })

  it('replaces a present-but-non-positive maxPixels with the route budget', async () => {
    // The ≤0.1.5 store accepts only a *positive* safe integer; 0 and negatives
    // are safe integers and would slip through an isSafeInteger-only guard,
    // then be rejected by the store — so the wrapper replaces them too.
    // Called directly on the wrapped store (pi-ai itself always sends a
    // pixel-less target, so only a future pi-ai could produce these shapes).
    let observed: { maxPixels?: number } | undefined
    const store = {
      readImageRequest(_ref: unknown, policy: { maxPixels?: number }) {
        if (!Number.isSafeInteger(policy.maxPixels) || (policy.maxPixels ?? 0) <= 0) {
          throw new Error('Image request maxPixels must be a positive integer.')
        }
        observed = policy
        return Promise.resolve({ bytes: 1 })
      },
    }
    const adapter = imageAdapter(store)
    const wrapped = (adapter as unknown as {
      config: { resolveAttachments: () => { readImageRequest: (ref: unknown, policy: unknown, signal?: AbortSignal) => Promise<unknown> } }
    }).config.resolveAttachments()
    for (const invalid of [0, -1]) {
      observed = undefined
      await wrapped.readImageRequest(
        { attachmentId: 'sha256:test', mediaType: 'image/png', width: 1, height: 1, bytes: 70 },
        { width: 1, height: 1, maxBytes: 1_048_576, maxPixels: invalid },
      )
      expect(observed).toMatchObject({ maxPixels: 4_194_304 })
    }
    // A positive value is forwarded exactly as received.
    await wrapped.readImageRequest(
      { attachmentId: 'sha256:test', mediaType: 'image/png', width: 1, height: 1, bytes: 70 },
      { maxPixels: 999 },
    )
    expect(observed).toMatchObject({ maxPixels: 999 })
  })
})
