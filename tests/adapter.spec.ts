import { describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { reasoningFields } from '../src/adapter.ts'

/**
 * `reasoningFields` is the pure mapping from a catalog row to pi-ai's reasoning
 * descriptor, and that descriptor is the exact input to the model picker's
 * effort control. These assertions therefore describe the real contract the
 * user sees, without standing up a shim or a host.
 */
describe('WorkBuddy thinking-effort mapping', () => {
  function reasoningOf(id: string, catalog = new WorkBuddyCatalog()): {
    reasoning: boolean
    thinkingLevelMap?: Record<string, string | null>
  } {
    const info = catalog.current().find(model => model.id === id)
    expect(info, `model ${id} is not in the catalog`).toBeDefined()
    return reasoningFields(info!)
  }

  it('offers a thinking control to a reasoning model with no declared effort set', () => {
    // glm-5.2 declares only `{effort, summary}` upstream, yet the ladder is
    // offered so the picker is not silently left without a control.
    const model = reasoningOf('glm-5.2')
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toMatchObject({
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    })
    // `off` is never offered on an undeclared row: the upstream rejects it for
    // some of those models and the row does not say which.
    expect(model.thinkingLevelMap?.['off']).toBeNull()
    expect(model.thinkingLevelMap?.['minimal']).toBeNull()
  })

  it('offers the same ladder to every undeclared reasoning model', () => {
    // The ladder is a property of the row shape, not of the individual model,
    // so every `{effort, summary}` row renders identically in the picker.
    const ladder = ['high', 'low', 'max', 'medium', 'xhigh']
    for (const id of ['auto', 'hy3', 'glm-5.2', 'glm-5.1', 'minimax-m3', 'kimi-k2.6', 'deepseek-v4-pro']) {
      const model = reasoningOf(id)
      expect(model.reasoning, `${id} should reason`).toBe(true)
      const offered = Object.entries(model.thinkingLevelMap ?? {})
        .filter(([, wire]) => wire !== null)
        .map(([level]) => level)
      expect(offered.sort(), `${id} ladder`).toEqual(ladder)
    }
  })

  it('offers no control to a model that does not reason', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.set([{
      id: 'plain', name: 'Plain', contextWindow: 1_000, maxTokens: 100, supportsImages: false,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: false },
    }])
    const model = reasoningOf('plain', catalog)
    expect(model.reasoning).toBe(false)
    expect(model.thinkingLevelMap).toBeUndefined()
  })

  it('keeps a declared set exact', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.set([{
      id: 'narrow', name: 'Narrow', contextWindow: 1_000, maxTokens: 100, supportsImages: false,
      reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low'], defaultEffort: 'high', canDisableThinking: false },
    }])
    const model = reasoningOf('narrow', catalog)
    expect(model.thinkingLevelMap).toMatchObject({ low: 'low', medium: null, high: null, xhigh: null, max: null })
  })

  it('admits off only for a declared set that also allows disabling thinking', () => {
    // glm-5.3 declares `canDisableThinking: true` alongside its set.
    expect(reasoningOf('glm-5.3').thinkingLevelMap?.['off']).toBe('off')
    // hy4-preview declares a set but cannot be switched off.
    expect(reasoningOf('hy4-preview').thinkingLevelMap?.['off']).toBeNull()
  })
})
