import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CARD_VARIANT, WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Card tests. The plugin card had none, which is how a shared `busy` flag ended
 * up driving a per-model button label: pressing one candidate made every button
 * claim it was running. These pin the label to the model actually started.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

describe('WorkBuddy plugin card', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: Record<string, unknown>
  /** Resolvers for in-flight POSTs, so a run can be held open deliberately. */
  let pendingPosts: (() => void)[] = []
  const request = vi.fn()

  function status(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      nickname: '昵称',
      expiresAt: Date.now() + 3_600_000,
      probeKey: 'test-key',
      credits: { total: 100, accounts: [] },
      models: [],
      probe: {
        consent: true,
        running: false,
        candidates: ['hy3', 'glm-5.2', 'minimax-m3'],
        results: [],
        ...overrides,
      },
    }
  }

  beforeEach(() => {
    status()
    pendingPosts = []
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      // Hold the POST open until the test releases it, so "in flight" is
      // observable rather than a race against the microtask queue.
      await new Promise<void>(resolve => { pendingPosts.push(resolve) })
      return { ok: true, json: async () => ({ state: 'ok', validation: 'non-validating', efforts: [] }) }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  /** Mount the card and expand it so the probe section renders. */
  async function mount(variant?: typeof AI_CARD_VARIANT): Promise<void> {
    // The card only reads `t`; the remaining props belong to the slot that
    // mounts it in DSH, so the test supplies the one it uses.
    const props = { t, ...variant === undefined ? {} : { variant } } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
    await act(async () => { view = create(createElement(WorkBuddyPluginCard, props)) })
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
  }

  const buttonLabels = (): string[] => view!.root.findAllByType('button').map(node => node.children.join(''))
  /**
   * Press a button by its label. `nth` disambiguates labels that repeat once
   * every row carries its own button (all idle rows read "Detect").
   */
  const press = async (label: string, nth = 0): Promise<void> => {
    const matches = view!.root.findAllByType('button').filter(entry => entry.children.join('') === label)
    const node = matches[nth]
    if (node === undefined) {
      throw new Error(`no button #${nth} labelled ${label}; have: ${buttonLabels().join(' | ')}`)
    }
    await act(async () => { node.props.onClick() })
  }

  it('labels only the pressed model as running', async () => {
    // Regression: a card-wide `busy` flag drove the label, so starting one
    // detection made all three candidate buttons read "Detecting …".
    await mount()
    await press(en.probeStart, 0)
    await press(en.probeConfirmAction)

    const labels = buttonLabels()
    const running = labels.filter(label => label.startsWith('Detecting'))
    // Exactly one row reports progress, and its label names the model.
    expect(running).toHaveLength(1)
    expect(running[0]).toContain('hy3')
    // The other rows keep their idle label.
    expect(labels.filter(label => label === en.probeStart)).toHaveLength(2)
  })

  it('returns the button to its idle label once the run finishes', async () => {
    await mount()
    await press(en.probeStart, 0)
    await press(en.probeConfirmAction)
    expect(buttonLabels().filter(label => label.startsWith('Detecting'))).toHaveLength(1)

    // Release the held POST; the running label must clear.
    await act(async () => {
      for (const release of pendingPosts.splice(0)) release()
    })
    expect(buttonLabels().filter(label => label.startsWith('Detecting'))).toHaveLength(0)
    expect(buttonLabels().filter(label => label === en.probeStart)).toHaveLength(3)
  })

  it('shows the confirmation inside the row that asked for it', async () => {
    // Rendered after the whole list, the confirmation sat at the bottom of a
    // long candidate list: the question was a screen away from the button.
    status({ candidates: ['hy3', 'glm-5.2', 'minimax-m3'] })
    await mount()

    // Open the confirmation for the FIRST candidate.
    await press(en.probeStart, 0)
    const confirmBody = en.probeConfirmBody.replace('{model}', 'hy3').slice(0, 12)
    expect(JSON.stringify(view!.toJSON())).toContain(confirmBody)

    // It belongs to the first row, i.e. it precedes the later candidates in
    // document order rather than trailing the list.
    const tree = JSON.stringify(view!.toJSON())
    expect(tree.indexOf(confirmBody)).toBeLessThan(tree.indexOf('minimax-m3'))
  })

  it('keeps a detected model in the candidate list, relabelled', async () => {
    // Regression: a detected model used to leave the candidate list, so its
    // button vanished and re-running it meant clearing every other result.
    status({
      candidates: ['hy3', 'glm-5.2'],
      results: [{ id: 'hy3', name: 'Hy3', validation: 'non-validating', efforts: [], probedAt: Date.now() }],
    })
    await mount()
    // Both rows are present. The detected one offers a re-run, the other a
    // first run — and neither row disappeared.
    expect(JSON.stringify(view!.toJSON())).toContain('Hy3')
    expect(JSON.stringify(view!.toJSON())).toContain('glm-5.2')
    expect(buttonLabels()).toContain(en.probeRedetect)
    expect(buttonLabels()).toContain(en.probeStart)
  })

  it('labels a candidate with the served name and rate, not its raw id', async () => {
    // Regression: a candidate with no recorded observation rendered its raw id
    // (`glm-5.3`), so the detection list looked like a different set of models
    // from the picker's. The catalogue in the same status document carries the
    // names — and the suffix is load-bearing: `hy3` and `hy3-x` are both served
    // as "Hy3", so the rate is all that separates the two rows.
    status()
    statusBody.models = [
      { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
      { id: 'hy3', name: 'Hy3', credits: 'x0.00', badges: ['限时免费'] },
      { id: 'hy3-x', name: 'Hy3', credits: 'x0.05' },
    ]
    statusBody.probe = { consent: true, running: false, candidates: ['glm-5.3', 'hy3', 'hy3-x'], results: [] }
    await mount()

    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('GLM-5.3 · x0.79')
    expect(rendered).toContain(`Hy3 · x0.00 · ${en.badgeLimitedFree}`)
    expect(rendered).toContain('Hy3 · x0.05')
  })

  it('lists every served model in the context tab, rate and badge included', async () => {
    // The detection list above carries only models with no declared levels, so
    // a declared model such as `glm-5.3-flashx` is visible in the card only
    // here — and until this tab carried the picker's suffix, "is flashx being
    // served?" could not be answered from the card at all.
    status()
    statusBody.models = [
      { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', credits: 'x0.14', contextWindow: 1_000_000 },
      { id: 'hy3', name: 'Hy3', credits: 'x0.00', badges: ['限时免费'], contextWindow: 192_000 },
    ]
    await mount()
    await press(en.tabContext)

    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('GLM-5.3-FlashX · x0.14')
    expect(rendered).toContain(`Hy3 · x0.00 · ${en.badgeLimitedFree}`)
    expect(rendered).toContain('1M')
  })

  it('shows the same list before and after a detection', async () => {
    status({ candidates: ['hy3', 'glm-5.2'] })
    await mount()
    expect(buttonLabels().filter(label => label === en.probeStart)).toHaveLength(2)

    // Simulate the host reporting a result for hy3 without removing it from
    // the candidate list, which is how the host now behaves.
    status({
      candidates: ['hy3', 'glm-5.2'],
      results: [{ id: 'hy3', name: 'Hy3', validation: 'non-validating', efforts: [], probedAt: Date.now() }],
    })
    await act(async () => { await press(en.refresh) })
    // Still two rows: one re-run, one first run.
    expect(buttonLabels()).toContain(en.probeRedetect)
    expect(buttonLabels().filter(label => label === en.probeStart)).toHaveLength(1)
  })

  it('distinguishes the saved catalog from a live list and the built-in fallback', async () => {
    const fetchedAt = Date.UTC(2026, 8, 12, 8, 30)
    status()
    statusBody.catalog = { source: 'saved', fetchedAt }
    await mount()
    let rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.catalogSaved.split('{time}')[0]!)
    expect(rendered).not.toContain(en.catalogFallback)

    status()
    statusBody.catalog = { source: 'live', fetchedAt }
    await act(async () => { await press(en.refresh) })
    rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.catalogLive.split('{time}')[0]!)

    status()
    statusBody.catalog = { source: 'fallback' }
    await act(async () => { await press(en.refresh) })
    expect(JSON.stringify(view!.toJSON())).toContain(en.catalogFallback)
  })

  it('does not leave whitespace after the English no-nickname label', async () => {
    status()
    delete statusBody.nickname
    await mount()
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('Signed in as')
    expect(rendered).not.toContain('Signed in as ')
  })

  it('keeps the international maximum-window switch available to turn off again', async () => {
    status()
    statusBody.useMaximumContextWindow = false
    statusBody.models = [{
      id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash',
      contextWindow: 300_000, defaultContextWindow: 300_000, maxContextWindow: 1_000_000,
    }]
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      const action = JSON.parse(String(init.body)) as { enabled: boolean }
      statusBody.useMaximumContextWindow = action.enabled
      statusBody.models = [{
        id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash',
        contextWindow: action.enabled ? 1_000_000 : 300_000,
        defaultContextWindow: 300_000, maxContextWindow: 1_000_000,
      }]
      return { ok: true, json: async () => ({ state: 'updated' }) }
    })
    await mount(AI_CARD_VARIANT)
    await press(en.tabContext)
    await act(async () => { view!.root.findByType('input').props.onChange({ currentTarget: { checked: true } }) })
    expect(view!.root.findByType('input').props.checked).toBe(true)
    await act(async () => { view!.root.findByType('input').props.onChange({ currentTarget: { checked: false } }) })
    expect(view!.root.findByType('input').props.checked).toBe(false)
  })

  it.each([[], [{ id: 'plain', name: 'Plain', contextWindow: 300_000 }]])('can disable the preference after alternatives disappear: %j', async (models?: { id: string, name: string, contextWindow: number }) => {
    statusBody.useMaximumContextWindow = true
    statusBody.models = models === undefined ? [] : [models]
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      const action = JSON.parse(String(init.body))
      expect(action).toEqual({ action: 'set-maximum-context-window', enabled: false })
      statusBody = { ...statusBody, useMaximumContextWindow: false }
      return { ok: true, json: async () => ({ state: 'updated' }) }
    })
    await mount(AI_CARD_VARIANT)
    await press(en.tabContext)
    expect(view!.root.findByType('input').props.checked).toBe(true)
    await act(async () => { view!.root.findByType('input').props.onChange({ currentTarget: { checked: false } }) })
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(view!.root.findAllByType('input')).toHaveLength(0)
  })

  it('shows a host-side preference failure instead of silently refreshing', async () => {
    status()
    statusBody.useMaximumContextWindow = false
    statusBody.models = [{
      id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash',
      contextWindow: 300_000, maxContextWindow: 1_000_000,
    }]
    request.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? { ok: true, json: async () => ({ state: 'failed', reason: 'settings are unavailable' }) }
      : { ok: true, json: async () => statusBody })
    await mount(AI_CARD_VARIANT)
    await press(en.tabContext)
    await act(async () => { view!.root.findByType('input').props.onChange({ currentTarget: { checked: true } }) })
    expect(JSON.stringify(view!.toJSON())).toContain('settings are unavailable')
  })

  it('renders an uncapped quota as unlimited rather than as zero', async () => {
    status()
    statusBody.credits = { total: 0, accounts: [], unlimited: true }
    await mount()

    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.creditsTotalUnlimited)
    expect(rendered).not.toContain(en.creditsTotal.replace('{total}', '0'))
  })

  it('renders cycleResetTime when present in credits', async () => {
    status()
    statusBody.credits = { total: 100, accounts: [], cycleResetTime: '2026-10-01T00:00:00Z' }
    await mount()
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.cycleResetAt.split('{time}')[0]!)
  })

  it('renders enterprise quota and handles 0 remaining without hiding row', async () => {
    status()
    statusBody.credits = {
      total: 0,
      accounts: [{ packageName: 'enterprise', remain: 0, size: 500 }],
    }
    await mount()
    await press(en.tabDetails)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.packageEnterprise)
    expect(rendered).toContain('0 / 500')
  })

  it('renders unlimited enterprise quota in details tab', async () => {
    status()
    statusBody.credits = {
      total: 0,
      unlimited: true,
      accounts: [{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true }],
    }
    await mount()
    await press(en.tabDetails)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.packageEnterprise)
    expect(rendered).toContain(en.unlimitedQuota)
  })

  it('does not draw a full bar for an uncapped quota', async () => {
    status()
    statusBody.credits = {
      total: 0,
      unlimited: true,
      accounts: [{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true }],
    }
    await mount()
    await press(en.tabDetails)

    // "Uncapped" is not "100% remaining": asserting a proportion would be a
    // claim the upstream never made, so no numeric value and no fill.
    const bar = view!.root.findAll(node => node.props.role === 'progressbar'
      && node.props['aria-label'] === en.packageEnterprise)[0]
    expect(bar).toBeDefined()
    expect(bar!.props['aria-valuenow']).toBeUndefined()
    expect(bar!.props['aria-valuemin']).toBeUndefined()
    expect(bar!.props['aria-valuemax']).toBeUndefined()
    expect(bar!.props['aria-valuetext']).toBe(en.unlimitedQuota)
    // The track renders no fill child, unlike a known percentage.
    expect(bar!.children).toHaveLength(0)
  })
})
