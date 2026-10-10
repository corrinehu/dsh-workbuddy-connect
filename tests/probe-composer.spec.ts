import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyProbeControl, type WorkBuddyProbeControlProps } from '../src/client/WorkBuddyProbeControl.tsx'
import { en, zh } from '../src/client/locales.ts'

/**
 * Composer-entry tests. The interaction these pin down:
 *
 * - the inline label is a *static* feature name, never a state readout (the
 *   verified levels belong to the model dropdown, not to composer chrome);
 * - a hover/focus tooltip carries the state and the click's purpose;
 * - the confirmation is an in-page bubble, not `window.confirm` — and cancelling
 *   it sends nothing, because probing spends the user's credit.
 */

describe('Composer model probe', () => {
  let view: ReactTestRenderer | undefined
  let provider: string
  let model: string
  let state: ReturnType<WorkBuddyProbeControlProps['directory']['getSnapshot']>
  let statusBody: Record<string, unknown>
  const listeners = new Set<() => void>()
  const request = vi.fn()
  /** Backing map for the stubbed localStorage. */
  let seenStore = new Map<string, string>()
  /** Captured `focus` listeners, so a reconcile can be fired on demand. */
  let focusHandlers: (() => void)[] = []
  /** Captured `setInterval` callbacks; the manual-refresh design registers none. */
  let intervalHandlers: (() => void)[] = []
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as WorkBuddyProbeControlProps['directory']
  const t: WorkBuddyProbeControlProps['t'] = (key, params = {}) =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  function select(nextProvider: string, nextModel: string) {
    provider = nextProvider
    model = nextModel
    state = { current: { provider, model }, status: 'ready', groups: [], failures: [], error: null, routable: true }
    listeners.forEach(listener => listener())
  }

  /** The status document, with the probe section's fields overridable. */
  function probeStatus(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: ['glm-5.2', 'auto'], results: [], ...overrides },
    }
  }

  /** Display name the stubbed status document would report for a model id. */
  function nameFor(model: string): string {
    return model === 'auto' ? 'Auto' : 'GLM-5.2'
  }

  beforeEach(() => {
    probeStatus()
    select('workbuddy', 'glm-5.2')
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      // A successful probe writes a result that the next status read reports,
      // the way the host does. Without that the control would refresh and see
      // the same candidate list, and there would be no outcome to announce.
      const probed = JSON.parse(String(init.body)) as { model: string }
      const probe = statusBody['probe'] as Record<string, unknown>
      const name = nameFor(probed.model)
      probe['candidates'] = (probe['candidates'] as string[]).filter(id => id !== probed.model)
      probe['results'] = [
        { id: probed.model, name, validation: 'non-validating', efforts: [], probedAt: Date.now() },
        ...(probe['results'] as unknown[]),
      ]
      return { ok: true, json: async () => ({ state: 'ok', validation: 'non-validating', efforts: [] }) }
    })
    vi.stubGlobal('fetch', request)
    // Minimal in-memory localStorage: the "already read" marks are persisted
    // there precisely so a reload cannot replay an old detection as news.
    seenStore = new Map()
    focusHandlers = []
    intervalHandlers = []
    vi.stubGlobal('window', {
      setInterval: (fn: () => void) => { intervalHandlers.push(fn); return 1 },
      clearInterval: () => {},
      addEventListener: (name: string, handler: () => void) => { if (name === 'focus') focusHandlers.push(handler) },
      removeEventListener: () => {},
      localStorage: {
        getItem: (key: string) => seenStore.get(key) ?? null,
        setItem: (key: string, value: string) => { seenStore.set(key, value) },
        removeItem: (key: string) => { seenStore.delete(key) },
      },
    })
  })
  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
    listeners.clear()
  })

  async function mount() {
    await act(async () => { view = create(createElement(WorkBuddyProbeControl, { directory, t })) })
  }

  const posts = () => request.mock.calls.filter(([, init]) => init?.method === 'POST')
  const button = () => view!.root.findAllByType('button')
  /** The probe entry: the only control here carrying aria-expanded. */
  const probeButton = () => button().find(node => 'aria-expanded' in node.props)!
  /** The badge's \u21bb, for driving the manual credit refresh. */
  const refreshButton = () => button().find(node => node.props['aria-label'] === en.composerCreditRefresh)!
  const buttonLabels = () => button().map(node => node.children.join(''))
  const tooltips = () => view!.root.findAllByProps({ role: 'tooltip' })

  it('does not read status or show an entry for another provider', async () => {
    select('other', 'glm-5.2')
    await mount()
    expect(view?.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('hides declared or non-candidate models', async () => {
    select('workbuddy', 'glm-5.3')
    await mount()
    // No probe entry for a non-candidate model. (With credits the seat shows
    // the balance; without, only the ↻ remains for a manual reconcile.)
    expect(view!.root.findAll(node => 'aria-expanded' in node.props)).toHaveLength(0)
  })

  it('keeps the newer status when an older read returns late', async () => {
    // Two reads can now overlap only through the user's own actions: the
    // trailing read a finished probe fires, and the ↻ the user clicks while
    // that read is still outstanding. The older response must not clobber the
    // newer one — the guard that used to be exercised by the focus poll.
    const oldStatus = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: [], results: [] },
    }
    let statusReads = 0
    let resolveSecond: ((value: Record<string, unknown>) => void) | undefined
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ state: 'ok', validation: 'non-validating', efforts: [] }) }
      }
      if (statusReads++ === 1) {
        // The trailing post-probe read: slow, carrying the older document.
        const value = await new Promise<Record<string, unknown>>((resolve) => {
          resolveSecond = resolve
        })
        return { ok: true, json: async () => value }
      }
      return { ok: true, json: async () => statusBody }
    })

    await mount()
    await act(async () => { probeButton().props.onClick() })
    await act(async () => {
      button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick()
    })
    // The ↻ lands while the trailing read is still outstanding: a newer
    // document arrives and wins.
    await act(async () => { refreshButton().props.onClick() })
    expect(probeButton()!.props['aria-label']).toBe(en.probeTooltipIdle.replace('{model}', 'glm-5.2'))

    await act(async () => {
      resolveSecond!(oldStatus)
    })
    expect(probeButton()!.props['aria-label']).toBe(en.probeTooltipIdle.replace('{model}', 'glm-5.2'))
  })

  it('shows a static feature label that never carries state', async () => {
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    // A detection result must not turn the label into a state readout; the
    // entry stays visible for the detected model, label unchanged.
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await act(async () => { listeners.forEach(listener => listener()) })
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    expect(JSON.stringify(view!.toJSON())).not.toContain('low / high')
  })

  it('explains the click in a tooltip on hover, not a native title', async () => {
    await mount()
    expect(tooltips()).toHaveLength(0)
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('glm-5.2')
    // The tooltip is the accessible description; no `title` attribute is used.
    expect(probeButton()!.props.title).toBeUndefined()
    expect(probeButton()!.props['aria-describedby']).toBeTruthy()
  })

  it('does not announce a result that predates this page', async () => {
    // The note is for "you just ran a detection, here is the outcome". A stored
    // result the user never saw announced here is recorded as read silently, so
    // neither a reload nor a model switch replays it as news.
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await mount()
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)
    // The result is still discoverable: the tooltip reports it on hover.
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('low / high')
  })

  it('does not re-announce after switching models away and back', async () => {
    probeStatus({
      candidates: ['glm-5.2', 'auto'],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low'], probedAt: Date.now() }],
    })
    await mount()
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)
    await act(async () => { select('workbuddy', 'auto') })
    await act(async () => { select('workbuddy', 'glm-5.2') })
    // Switching is not a reason to repeat something already on record.
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)
  })

  it('opens an in-page confirmation instead of window.confirm', async () => {
    await mount()
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    await act(async () => { probeButton()!.props.onClick() })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(buttonLabels()).toEqual(expect.arrayContaining([en.cancel, en.probeConfirmAction]))
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const cancel = button().find(node => node.children.join('') === en.cancel)!
    await act(async () => { cancel.props.onClick() })
    expect(posts()).toHaveLength(0)
    // The bubble is gone again, leaving only the trigger (and the ↻).
    expect(button().filter(node => !('aria-label' in node.props && node.props['aria-label'] === en.composerCreditRefresh))).toHaveLength(1)
  })

  it('confirms the newly selected model and sends only that id, without automatic consent', async () => {
    await mount()
    await act(async () => { select('workbuddy', 'auto') })
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ action: 'probe', model: 'auto' })
    expect(posts()[0]![1].headers['X-WorkBuddy-Probe-Key']).toBe('test-key')
  })

  it('blocks double clicks before the request finishes', async () => {
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick(); detect.props.onClick() })
    expect(posts()).toHaveLength(1)
  })

  it('closes the confirmation once the request completes', async () => {
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // The confirmation is gone — replaced by the outcome note, which is a
    // different bubble. Only Cancel/Detect disappear.
    expect(buttonLabels()).not.toContain(en.probeConfirmAction)
    expect(buttonLabels()).not.toContain(en.cancel)
  })

  it('announces the outcome of a detection this control started', async () => {
    // The self-initiated path still announces: the user just spent a request
    // and needs to know what came back.
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // The POST answer is reported by the note.
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })

  it('announces a cached result even if its timestamp predates the click', async () => {
    probeStatus({ candidates: [], results: [{ id: 'glm-5.2', name: 'GLM-5.2',
      validation: 'validating', efforts: ['low', 'high'], probedAt: 1 }] })
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true, json: async () => init?.method === 'POST'
        ? { state: 'ok', validation: 'validating', efforts: ['low', 'high'], requests: 0 }
        : statusBody,
    }))
    await act(async () => { probeButton()!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(JSON.stringify(view!.toJSON())).toContain('low / high')
  })

  it('shows completion without waiting for a hung credit/status refresh', async () => {
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Promise(() => {})
      return { ok: true, json: async () => ({ state: 'ok', validation: 'validating', efforts: ['high'] }) }
    })
    await act(async () => { probeButton()!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(probeButton()!.props['aria-busy']).toBe(false)
  })

  it('keeps a successful result when the following status request fails', async () => {
    await mount()
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') throw new Error('credit unavailable')
      return { ok: true, json: async () => ({ state: 'ok', validation: 'validating', efforts: ['high'] }) }
    })
    await act(async () => { probeButton()!.props.onClick() })
    await act(async () => { button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick() })
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
    expect(probeButton()!.props['aria-label']).not.toBe(en.probeTooltipRetry)
  })

  it('reports a non-validating outcome instead of verified levels', async () => {
    // The stubbed POST answers `non-validating`.
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeNoteNotValidating)
  })

  it('still announces when a manual re-read lands mid-flight', async () => {
    // A ↻ re-read can land while the user's own probe POST is still running
    // (there is no poll anymore — a click is the only other way a document
    // arrives). That used to consume the "I started this" flag, so the real
    // outcome was filed as read and no note appeared. The re-read is driven
    // for real here: the POST is held, the ↻ click's GET lands mid-flight,
    // and only then is the POST released.
    await mount()

    // Hold the probe POST so "mid-flight" is real.
    let releasePost!: () => void
    const postGate = new Promise<void>((resolve) => { releasePost = resolve })
    request.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { await postGate; return { ok: true, json: async () => ({ state: 'ok', validation: 'validating', efforts: ['low'] }) } }
      return { ok: true, json: async () => statusBody }
    })

    await act(async () => { probeButton().props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!

    // The re-read's document reports another model's result — the interference
    // that used to consume the "I started this" flag.
    statusBody['probe'] = {
      ...(statusBody['probe'] as Record<string, unknown>),
      results: [{ id: 'auto', name: 'Auto', validation: 'validating', efforts: ['low'], probedAt: Date.now() }],
    }
    // Start the probe (POST held), then land a real manual GET mid-flight.
    await act(async () => { detect.props.onClick() })
    const getsBefore = request.mock.calls.filter(([, init]) => init?.method !== 'POST').length
    await act(async () => { refreshButton().props.onClick() })
    expect(request.mock.calls.filter(([, init]) => init?.method !== 'POST').length).toBe(getsBefore + 1)

    // Only now does the probe POST finish.
    await act(async () => { releasePost() })

    // The user's own detection is still announced.
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })

  it('persists the dismissal so it survives a remount', async () => {
    await mount()
    await act(async () => { probeButton()!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    const dismiss = button().find(node => node.children.join('') === en.probeNoteDismiss)!
    await act(async () => { dismiss.props.onClick() })
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)

    // A fresh mount stands in for a reload or restart: the mark is on disk, so
    // the same outcome must not be announced again.
    const probedAt = Date.now()
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'non-validating', efforts: [], probedAt }],
    })
    await mount()
    expect(buttonLabels()).not.toContain(en.probeNoteDismiss)
  })

  describe('credit badge (#99)', () => {
    /** Every string child the rendered tree carries, flattened per node. */
    const spanTexts = () => view!.root.findAllByType('span')
      .flatMap(node => node.children.filter(child => typeof child === 'string') as string[])
    /** The status GETs the control made (the badge must add none of its own). */
    const statusGets = () => request.mock.calls.filter(([, init]) => init?.method !== 'POST')

    /** Put a credits section into the stubbed status document. */
    function withCredits(total: number, unlimited = false): void {
      statusBody['credits'] = unlimited ? { total, unlimited: true } : { total }
    }

    /** The badge's number, formatted the way the control formats it. */
    const number = (value: number) =>
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)

    it('shows the CN balance beside the probe entry', async () => {
      withCredits(3401)
      await mount()
      expect(spanTexts()).toContain(`WB.${number(3401)} credits`)
      // The probe entry it shares the seat with is untouched.
      expect(spanTexts()).toContain(en.probeLabel)
    })

    it('shows the AI prefix and reads only the AI status route', async () => {
      withCredits(95)
      select('workbuddy-ai', 'auto')
      await mount()
      expect(spanTexts()).toContain(`WB AI.${number(95)} credits`)
      expect(statusGets().every(([url]) => url === '/plugins/dsh-workbuddy-connect/ai/status')).toBe(true)
    })

    it('shows the balance for a model with nothing to probe', async () => {
      withCredits(120)
      select('workbuddy', 'glm-5.3')
      await mount()
      // Non-candidate: badge + ↻, no probe entry on the seat.
      expect(spanTexts()).toContain(`WB.${number(120)} credits`)
      expect(button().some(node => 'aria-expanded' in node.props)).toBe(false)
    })

    it('shows a zero balance — zero is a real number, not "unknown"', async () => {
      withCredits(0)
      await mount()
      expect(spanTexts()).toContain(`WB.${number(0)} credits`)
    })

    it('renders unlimited as ∞, never as 0', async () => {
      withCredits(-1, true)
      await mount()
      expect(spanTexts()).toContain('WB.∞ credits')
      expect(spanTexts().join(' ')).not.toContain('WB.0')
    })

    it('hides the badge when signed out, keeping only the manual re-read', async () => {
      withCredits(3401)
      statusBody = { status: 'signed-out' }
      await mount()
      // No balance and no probe entry — but the ↻ stays, so signing in inside
      // the desktop app is one click away from showing here.
      expect(spanTexts().join(' ')).not.toContain('credits')
      expect(button().some(node => 'aria-expanded' in node.props)).toBe(false)
      expect(refreshButton()).toBeDefined()
    })

    it('hides the badge when the document carries no credits', async () => {
      await mount()
      expect(spanTexts().join(' ')).not.toContain('credits')
      // The probe entry still works on the same document.
      expect(spanTexts()).toContain(en.probeLabel)
    })

    it('hides the badge when credits errored, instead of showing 0', async () => {
      statusBody['creditsError'] = 'HTTP 500'
      await mount()
      expect(spanTexts().join(' ')).not.toContain('credits')
    })

    it('hides the badge even for a malformed document carrying both fields', async () => {
      // The status guard does not validate optional fields, so a document with
      // BOTH `creditsError` and `credits` is not rejected at the boundary — the
      // badge must not read the numbers of a read the host itself called
      // failed. No known backend produces this; the check is cheap insurance.
      statusBody['creditsError'] = 'HTTP 500'
      statusBody['credits'] = { total: 3401 }
      await mount()
      expect(spanTexts().join(' ')).not.toContain('credits')
    })

    it('keeps only the manual re-read for an error document', async () => {
      statusBody = { status: 'error', message: 'upstream down' }
      await mount()
      expect(button().some(node => 'aria-expanded' in node.props)).toBe(false)
      expect(refreshButton()).toBeDefined()
    })

    it('leaves nothing behind when the selection moves to another provider', async () => {
      withCredits(3401)
      await mount()
      expect(spanTexts()).toContain(`WB.${number(3401)} credits`)
      select('other', 'glm-5.2')
      await act(async () => {})
      expect(view?.toJSON()).toBeNull()
      // The switch away reads nothing either.
      expect(statusGets()).toHaveLength(1)
    })

    it('re-reads the balance when the model changes under the same provider', async () => {
      withCredits(3401)
      await mount()
      statusBody['credits'] = { total: 12 }
      await act(async () => { select('workbuddy', 'glm-5.3') })
      expect(spanTexts()).toContain(`WB.${number(12)} credits`)
      expect(spanTexts().join(' ')).not.toContain(number(3401))
    })

    it('adds no request of its own', async () => {
      await mount()
      const withoutCredits = statusGets().length
      act(() => { view?.unmount() })
      request.mockClear()
      seenStore.clear()
      select('workbuddy', 'glm-5.2')
      withCredits(3401)
      await mount()
      // One status GET per mount before the badge existed, one after: the badge
      // rides the mount read the probe entry already runs.
      expect(statusGets()).toHaveLength(withoutCredits)
    })

    it('registers no timer and no focus listener', async () => {
      await mount()
      // The manual-refresh design: the only automatic read is the mount one.
      // If either registration comes back, billing is being queried behind the
      // user's back again.
      expect(intervalHandlers).toHaveLength(0)
      expect(focusHandlers).toHaveLength(0)
    })

    it('refreshes on demand through the same status route', async () => {
      withCredits(3401)
      await mount()
      expect(spanTexts()).toContain(`WB.${number(3401)} credits`)
      statusBody['credits'] = { total: 12 }
      expect(statusGets()[0]![1]!.cache).toBe('no-store')
      await act(async () => { refreshButton().props.onClick() })
      expect(statusGets()).toHaveLength(2)
      expect(spanTexts()).toContain(`WB.${number(12)} credits`)
    })

    it('dedupes concurrent manual refreshes', async () => {
      withCredits(3401)
      await mount()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      request.mockImplementation(async () => { await gate; return { ok: true, json: async () => statusBody } })
      await act(async () => {
        refreshButton().props.onClick()
        refreshButton().props.onClick()
      })
      expect(statusGets()).toHaveLength(2)
      await act(async () => { release() })
      expect(refreshButton().props.disabled).toBe(false)
    })

    it('hides the balance when a manual refresh fails, instead of faking success', async () => {
      withCredits(3401)
      await mount()
      request.mockImplementationOnce(async () => { throw new Error('HTTP 500') })
      await act(async () => { refreshButton().props.onClick() })
      // The old number is gone, not presented as current; the ↻ stays as retry.
      expect(spanTexts().join(' ')).not.toContain(number(3401))
      expect(refreshButton().props.disabled).toBe(false)
      // A later successful read brings it back.
      await act(async () => { refreshButton().props.onClick() })
      expect(spanTexts()).toContain(`WB.${number(3401)} credits`)
    })

    it('keeps the manual re-read available for every document state', async () => {
      // Signed-out and error included: the ↻ is the seat's one re-read, and it
      // is how the control picks up a sign-in that happened in the desktop app.
      statusBody = { status: 'signed-out' }
      await mount()
      expect(refreshButton().props.disabled).toBe(false)
      statusBody = { status: 'error', message: 'upstream down' }
      await act(async () => { select('workbuddy', 'glm-5.2') })
      expect(refreshButton().props.disabled).toBe(false)
    })

    it('keeps the probe flow working alongside the badge', async () => {
      withCredits(3401)
      await mount()
      await act(async () => { probeButton()!.props.onClick() })
      expect(spanTexts()).toContain(en.probeBubbleBody)
    })

    it('pins the badge copy in both locales', () => {
      // The Chinese form is the user-facing spec: "WB.3,401（积分）".
      expect(zh.composerCredit).toBe('{prefix}{total}（积分）')
      expect(en.composerCredit).toBe('{prefix}{total} credits')
    })

    describe('read-order races', () => {
      /**
       * Mount normally (the mount read answers at once), then hold every later
       * status GET until released. Returns the release function; the oldest
       * held read is released first. A `{ ok: false }` outcome fails that read.
       */
      async function mountThenHoldReads(): Promise<
        (index: number, outcome: { ok: true, body: Record<string, unknown> } | { ok: false }) => Promise<void>
      > {
        withCredits(3401)
        await mount()
        const held: { resolve: (reply: { ok: true, body: Record<string, unknown> } | { ok: false }) => void }[] = []
        request.mockImplementation(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') return { ok: true, json: async () => ({ state: 'ok', validation: 'non-validating', efforts: [] }) }
          return await new Promise((resolve) => {
            held.push({ resolve: (outcome) => resolve(outcome.ok
              ? { ok: true, json: async () => outcome.body }
              : { ok: false, json: async () => ({}) }) })
          })
        })
        return async (index, outcome) => {
          const entry = held[index]
          if (entry === undefined) throw new Error(`no held read at ${index}`)
          await act(async () => { entry.resolve(outcome) })
        }
      }

      it('an older failed manual read must not hide a newer successful balance', async () => {
        // The manual ↻ read goes out first and is held; a probe's trailing read
        // (newer) lands a fresh balance; then the held manual read FAILS. That
        // stale failure must not hide the fresh balance the newer read just
        // delivered — readSeq decides, not arrival order.
        const release = await mountThenHoldReads()
        await act(async () => { refreshButton().props.onClick() })
        statusBody['credits'] = { total: 12 }
        await act(async () => { probeButton().props.onClick() })
        await act(async () => {
          button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick()
        })
        await release(1, { ok: true, body: { ...statusBody } })
        expect(spanTexts()).toContain(`WB.${number(12)} credits`)
        await release(0, { ok: false })
        expect(spanTexts()).toContain(`WB.${number(12)} credits`)
      })

      it('an older successful manual read must not overwrite a newer one', async () => {
        // The manual ↻ read goes out first (held, will answer a stale 9999);
        // a probe's trailing read (newer) lands 12. The late stale answer must
        // not clobber it.
        const release = await mountThenHoldReads()
        await act(async () => { refreshButton().props.onClick() })
        statusBody['credits'] = { total: 12 }
        await act(async () => { probeButton().props.onClick() })
        await act(async () => {
          button().find(node => node.children.join('') === en.probeConfirmAction)!.props.onClick()
        })
        await release(1, { ok: true, body: { ...statusBody } })
        expect(spanTexts()).toContain(`WB.${number(12)} credits`)
        await release(0, { ok: true, body: { ...statusBody, credits: { total: 9999 } } })
        expect(spanTexts()).toContain(`WB.${number(12)} credits`)
        expect(spanTexts().join(' ')).not.toContain(number(9999))
      })
    })
  })
})
