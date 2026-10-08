import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import type { WorkBuddyAdapterOptions } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'

afterEach(() => vi.unstubAllGlobals())

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
    // picker. The wire spelling is stripped in *both* regions since #87 — see
    // `dropUnsupportedEffort` and its specs, plus issues #49 and #87.
    // Known limitation that stays: selecting Off does not guarantee thinking is
    // disabled — the field is omitted and the upstream decides.
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

  it('withholds `off` from a model that declares it can only reason (issue #87)', () => {
    // The CN catalog ships both flags true on `deepseek-v4.1-flash` and
    // `kimi-k2.8-preview`, which cannot both hold. The endpoint sides with
    // `onlyReasoning` (400 / 11150 for every `off` request), so the picker must
    // not offer a level that is certain to fail.
    const catalog = new WorkBuddyCatalog([{
      id: 'only-reasoning',
      name: 'Only Reasoning',
      contextWindow: 1_000,
      maxTokens: 128_000,
      supportsImages: false,
      billing: { free: false },
      reasoning: {
        supports: true,
        onlyReasoning: true,
        canDisableThinking: true,
        supportedEfforts: ['low', 'high', 'max'],
      },
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
    const model = snapshot.models.getModel(WORKBUDDY_PROVIDER, 'only-reasoning')
    // `null` keeps Off out of the picker, while the declared efforts survive.
    expect(model?.thinkingLevelMap?.off).toBeNull()
    expect(model?.thinkingLevelMap?.low).toBe('low')
    expect(model?.thinkingLevelMap?.high).toBe('high')
    expect(model?.thinkingLevelMap?.max).toBe('max')
  })
})

describe('request-image contract across host generations', () => {
  /**
   * The exact failure observed on ≤0.1.5 hosts: a
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

  function imageAdapter(
    store: Record<string, unknown>,
    providerId = WORKBUDDY_PROVIDER,
    resolveImageAccess?: WorkBuddyAdapterOptions['resolveImageAccess'],
  ) {
    const catalog = new WorkBuddyCatalog([{
      id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 128_000,
      supportsImages: true, billing: { free: false },
    }])
    return createWorkBuddyAdapter({
      providerId,
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
      resolveAttachments: () => store as never,
      ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
    }).adapter
  }

  async function serializedImageBody(adapter: ReturnType<typeof imageAdapter>, provider: string, message: never = IMAGE_MESSAGE as never) {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    const call = await adapter.prepareCall(provider, 'glm-5.3')
    for await (const _chunk of call.stream({
      provider,
      model: 'glm-5.3',
      messages: [message],
    })) {
      // The serialized request is the contract under test.
    }
    return body
  }

  function textFromRequest(body: Record<string, unknown> | undefined): string {
    const messages = body?.['messages'] as { content?: string | { text?: string }[] }[] | undefined
    return messages?.map(message => typeof message.content === 'string'
      ? message.content
      : message.content?.map(block => block.text ?? '').join('\n') ?? '').join('\n') ?? ''
  }

  it.each([WORKBUDDY_PROVIDER, 'workbuddy-ai'])('serializes mapped image access and keeps image bytes for %s', async provider => {
    const hostPath = 'C:\\Users\\Corrine Hu\\图片\\原图.png'
    const executionPath = 'Z:\\WorkBuddy Data\\模型工具\\图像 "1".png'
    class PrivatePathAttachmentStore {
      #hostPath = hostPath

      imageHostPath() {
        return this.#hostPath
      }

      async readImageRequest() {
        return {
        variantId: 'variant' as never,
        attachment: IMAGE_MESSAGE.content[1]?.type === 'image' ? IMAGE_MESSAGE.content[1].attachment : undefined,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
        } as never
      }
    }
    const store = new PrivatePathAttachmentStore()
    const adapter = imageAdapter(store as unknown as Record<string, unknown>, provider, (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        path => path === hostPath ? executionPath : undefined,
        ref,
      ))

    const body = await serializedImageBody(adapter, provider)
    const modelText = textFromRequest(body)
    const serialized = JSON.stringify(body)
    expect(modelText).toContain(JSON.stringify(executionPath))
    expect(modelText).toContain('Normalized copy (read-only;')
    expect(serialized).toContain('data:image/png;base64,AQID')
    expect(modelText).not.toContain(hostPath)

    const offloaded = {
      ...IMAGE_MESSAGE,
      content: [
        IMAGE_MESSAGE.content[0],
        { type: 'image' as const, attachment: IMAGE_MESSAGE.content[1]?.type === 'image' ? IMAGE_MESSAGE.content[1].attachment : undefined, offloaded: true as const },
      ],
    } as never
    const offloadedBody = await serializedImageBody(adapter, provider, offloaded)
    const offloadedText = textFromRequest(offloadedBody)
    expect(offloadedText).toContain('image omitted to fit request image limits')
    expect(offloadedText).toContain(JSON.stringify(executionPath))
  })

  it('propagates attachment path errors instead of hiding them', async () => {
    const store = {
      imageHostPath: () => { throw new Error('invalid image reference') },
      readImageRequest: async () => ({
        variantId: 'variant' as never,
        attachment: IMAGE_MESSAGE.content[1]?.type === 'image' ? IMAGE_MESSAGE.content[1].attachment : undefined,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }) as never,
    }
    const adapter = imageAdapter(store, WORKBUDDY_PROVIDER, (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, () => undefined, ref))
    const call = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'glm-5.3')
    await expect(async () => {
      for await (const _chunk of call.stream({
        provider: WORKBUDDY_PROVIDER,
        model: 'glm-5.3',
        messages: [IMAGE_MESSAGE as never],
      })) {
        // The attachment failure occurs before the HTTP request.
      }
    }).rejects.toThrow('invalid image reference')
  })

  it('keeps the short handle when the attachment store offers no host path', async () => {
    // Plan §5's second degradation row: the mapper never runs without a host
    // path, so the request must keep the plain handle and the image bytes.
    const store = {
      imageHostPath: () => undefined,
      readImageRequest: async () => ({
        variantId: 'variant' as never,
        attachment: IMAGE_MESSAGE.content[1]?.type === 'image' ? IMAGE_MESSAGE.content[1].attachment : undefined,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }) as never,
    }
    const adapter = imageAdapter(store as unknown as Record<string, unknown>, WORKBUDDY_PROVIDER, (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, () => 'Z:\\would-be-mapping.png', ref))
    const body = await serializedImageBody(adapter, WORKBUDDY_PROVIDER)
    const modelText = textFromRequest(body)
    expect(modelText).not.toContain('Normalized copy (read-only;')
    expect(modelText).not.toContain('Z:\\would-be-mapping.png')
    expect(JSON.stringify(body)).toContain('data:image/png;base64,AQID')
  })

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
