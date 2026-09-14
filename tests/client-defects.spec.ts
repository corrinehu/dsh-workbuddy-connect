import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { WorkBuddyPluginCard, type WorkBuddyCardVariant } from '../src/client/WorkBuddyPluginCard.tsx'
import { WorkBuddyProbeControl, type WorkBuddyProbeControlProps } from '../src/client/WorkBuddyProbeControl.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Regression tests for the browser-half defects confirmed in
 * `docs/client-defect-confirmation.md` (§1–§8, task t4) and fixed by task t5.
 *
 * Each test is written to *fail before its fix and pass after it*: the defect it
 * names must be reachable by driving the component the way the defect document
 * describes, not by asserting an implementation detail. The defect document's
 * §10 lists the observable behaviours these pin.
 *
 * The card and the composer control are driven through `react-test-renderer`
 * with a stubbed `fetch`, exactly as `tests/plugin-card.spec.ts` and
 * `tests/client-variants.spec.ts` do. No request leaves the process.
 */

/** Locale lookup mirroring the injected `t` (params substituted, as the host does). */
const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** Locale-independent expected strings, built the way the component builds them. */
const formatNumber = (value: number): string => new Intl.NumberFormat(undefined).format(value)
const formatPercent = (value: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)

/** `en.statusRefreshFailed` up to its `{message}` slot. */
const NOTICE = en.statusRefreshFailed.split('{message}')[0]!

type Reply = {
  ok?: boolean
  status?: number
  body?: unknown
  /** A 200 whose body is not JSON at all (a proxy page, an HTML fallback). */
  invalidJson?: true
}
/** `{ hang: true }` leaves the request pending, so a test owns when it settles. */
type Step = Reply | { hang: true }

/* -------------------------------------------------------------------------- *
 * Harness: a recording fetch and a controllable `window`
 * -------------------------------------------------------------------------- */

const calls: { url: string, init: RequestInit | undefined }[] = []
const hung = new Map<number, (reply: Reply) => void>()
let statusReply: Step = { ok: true, body: {} }
let writeReply: Step = { ok: true, body: {} }
/** Overrides the default method-based reply, e.g. to answer by arrival order. */
let plan: ((url: string, init: RequestInit | undefined, index: number) => Step) | undefined

const intervals = new Map<number, () => void>()
const clearedHandles: number[] = []
const focusListeners = new Set<() => void>()
let nextHandle = 1

function makeResponse(reply: Reply): Response {
  const ok = reply.ok ?? true
  return {
    ok,
    status: reply.status ?? (ok ? 200 : 500),
    json: async () => {
      if (reply.invalidJson === true) throw new SyntaxError('Unexpected token < in JSON at position 0')
      return reply.body
    },
    text: async () => (reply.invalidJson === true ? '<html>not json</html>' : JSON.stringify(reply.body ?? '')),
  } as unknown as Response
}

/** Record `(url, init)` for every request and answer it in process. */
function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(input), init })
    const step = plan?.(String(input), init, index)
      ?? (init?.method === 'POST' ? writeReply : statusReply)
    if ('hang' in step) {
      return await new Promise<Response>(resolve => {
        hung.set(index, reply => { resolve(makeResponse(reply)) })
      })
    }
    return makeResponse(step)
  }))
}

/** A window stub whose intervals and focus listeners the test can fire itself. */
function stubWindow(): void {
  vi.stubGlobal('window', {
    setInterval: (handler: () => void) => {
      const handle = nextHandle++
      intervals.set(handle, handler)
      return handle
    },
    clearInterval: (handle: number) => {
      clearedHandles.push(handle)
      intervals.delete(handle)
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'focus') focusListeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      focusListeners.delete(listener)
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
}

/** Settle a request that was held open, and flush the state it produces. */
async function release(index: number, reply: Reply): Promise<void> {
  const resolve = hung.get(index)
  if (resolve === undefined) throw new Error(`no request held open at index ${index}`)
  hung.delete(index)
  await act(async () => { resolve(reply) })
}

/** Fire every armed interval once (the card's 60s poll, the control's reconcile timer). */
async function tickIntervals(): Promise<void> {
  const handlers = [...intervals.values()]
  await act(async () => { for (const handler of handlers) handler() })
}

/** Fire the window focus listeners, which is how the control re-reads state. */
async function fireFocus(): Promise<void> {
  const listeners = [...focusListeners]
  await act(async () => { for (const listener of listeners) listener() })
}

/** One signed-in status document, as the host sends it. */
function signedInStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    nickname: 'nick',
    probeKey: 'test-key',
    credits: { total: 15, accounts: [] },
    models: [],
    ...overrides,
  }
}

beforeEach(() => {
  calls.length = 0
  hung.clear()
  intervals.clear()
  clearedHandles.length = 0
  focusListeners.clear()
  nextHandle = 1
  plan = undefined
  statusReply = { ok: true, body: signedInStatus() }
  writeReply = { ok: true, body: {} }
  stubFetch()
  stubWindow()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* -------------------------------------------------------------------------- *
 * The settings card
 * -------------------------------------------------------------------------- */

describe('WorkBuddyPluginCard', () => {
  let view: ReactTestRenderer | undefined

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
  })

  const rendered = (): string => JSON.stringify(view!.toJSON())
  const buttons = () => view!.root.findAllByType('button')
  const labels = (): string[] => buttons().map(node => node.children.join(''))

  /** Mount the card and expand it: expanding is what starts the first read. */
  async function mount(variant?: WorkBuddyCardVariant): Promise<void> {
    await act(async () => {
      // The card reads `t` and `variant`; the remaining props belong to the slot
      // that mounts it in DSH, so the test supplies only what it uses.
      const props = {
        t: t as Parameters<typeof WorkBuddyPluginCard>[0]['t'],
        ...variant === undefined ? {} : { variant },
      } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
      view = create(createElement(WorkBuddyPluginCard, props))
    })
    await act(async () => { buttons()[0]!.props.onClick() })
  }

  /** Press a button by its label. */
  async function press(label: string): Promise<void> {
    const node = buttons().find(entry => entry.children.join('') === label)
    if (node === undefined) throw new Error(`no button labelled ${label}; have: ${labels().join(' | ')}`)
    await act(async () => { node.props.onClick() })
  }

  describe('#1 unreadable status bodies', () => {
    it('renders an error state for a 200 whose body is literal null, without throwing', async () => {
      // The host answered 200 with `null`: `.json()` resolves to null and the
      // old cast stored it, so the next render dereferenced `status.status`.
      statusReply = { ok: true, body: null }
      await mount()

      expect(rendered()).toContain(en.requestFailed)
      expect(rendered()).toContain(en.statusResponseInvalid)
      // The card stays operable rather than crashing the plugin slot.
      expect(labels()).toContain(en.refresh)
    })

    it('renders an error state for a 200 whose body is not JSON, without throwing', async () => {
      statusReply = { ok: true, invalidJson: true }
      await mount()

      expect(rendered()).toContain(en.requestFailed)
      expect(rendered()).toContain(en.statusResponseInvalid)
      expect(labels()).toContain(en.refresh)
    })

    it('never stores an unreadable body over a document already on screen', async () => {
      // Mid-session a proxy answers the poll with an HTML page. The signed-in
      // document is what the user is reading, so it must survive; the invalid
      // reply is reported beside it.
      await mount()
      expect(rendered()).toContain('nick')

      statusReply = { ok: true, invalidJson: true }
      await tickIntervals()

      expect(rendered()).toContain('nick')
      expect(rendered()).toContain(NOTICE)
      expect(rendered()).toContain(en.statusResponseInvalid)
      expect(rendered()).not.toContain(en.requestFailed)
    })
  })

  describe('#3 a failed read must not discard the document', () => {
    it('keeps every rendered value and adds the notice after a failed poll', async () => {
      const document = signedInStatus({
        nickname: 'nick',
        catalog: { source: 'live', fetchedAt: Date.UTC(2026, 8, 12, 8, 30) },
        credits: { total: 15, accounts: [] },
      })
      statusReply = { ok: true, body: document }
      await mount()
      expect(rendered()).toContain('nick')
      expect(rendered()).toContain(t('creditsTotal', { total: formatNumber(15) }))
      expect(rendered()).toContain(en.catalogLive.split('{time}')[0]!)

      // The poll fails. Before the fix this replaced the document with
      // `{ status: 'error' }`, taking the account, credits and catalog with it.
      statusReply = { ok: false, status: 500, body: {} }
      await tickIntervals()

      const failed = rendered()
      expect(failed).toContain('nick')
      expect(failed).toContain(t('creditsTotal', { total: formatNumber(15) }))
      expect(failed).toContain(en.catalogLive.split('{time}')[0]!)
      expect(failed).toContain(NOTICE)
      expect(failed).toContain('HTTP 500')
      // The label still describes the account, not the failed read.
      expect(failed).not.toContain(en.requestFailed)
    })

    it('clears the notice after the next successful read', async () => {
      await mount()
      statusReply = { ok: false, status: 500, body: {} }
      await tickIntervals()
      expect(rendered()).toContain(NOTICE)

      statusReply = { ok: true, body: signedInStatus({ nickname: 'back' }) }
      await tickIntervals()

      expect(rendered()).toContain('back')
      expect(rendered()).not.toContain(NOTICE)
    })

    it('renders the plain error state when the first read fails — no notice to attach to', async () => {
      // Nothing has succeeded yet, so there is no document to annotate. §3.3
      // keeps today's error state exactly; the notice is only for a failure
      // that follows a successful read.
      statusReply = { ok: false, status: 503, body: {} }
      await mount()

      const text = rendered()
      expect(text).toContain(en.requestFailed)
      expect(text).toContain('HTTP 503')
      expect(text).not.toContain(NOTICE)
      expect(labels()).toContain(en.refresh)
    })

    it('keeps the poll armed after a failed tick and recovers without a manual click', async () => {
      await mount()
      const liveBefore = [...intervals.keys()]
      expect(liveBefore).toHaveLength(1)

      statusReply = { ok: false, status: 500, body: {} }
      await tickIntervals()

      // The interval is still the same handle: a failed read cannot disarm it.
      expect([...intervals.keys()]).toEqual(liveBefore)

      statusReply = { ok: true, body: signedInStatus({ nickname: 'healed' }) }
      await tickIntervals()

      expect(rendered()).toContain('healed')
      expect(rendered()).not.toContain(NOTICE)
    })

    it('keeps the poll armed when the first read fails, so the card heals by itself', async () => {
      // §3.4: the interval is gated on the last successful read, so a failed
      // *initial* read must still leave it armed. Gating on the rendered
      // document instead would disarm it here — there is no document yet — and
      // the card would stay on the error state until the user clicked Refresh.
      statusReply = { ok: false, status: 500, body: {} }
      await mount()
      expect(rendered()).toContain(en.requestFailed)
      expect([...intervals.keys()]).toHaveLength(1)

      statusReply = { ok: true, body: signedInStatus({ nickname: 'healed' }) }
      await tickIntervals()

      expect(rendered()).toContain('healed')
      expect(rendered()).not.toContain(en.requestFailed)
    })

    it('still stops the poll when the upstream answers signed-out', async () => {
      await mount()
      const handle = [...intervals.keys()][0]!
      expect(intervals.size).toBe(1)

      statusReply = { ok: true, body: { status: 'signed-out' } }
      await tickIntervals()

      // A genuine signed-out answer is not a transient failure: the user's
      // Refresh button is the only thing that can change it.
      expect(intervals.size).toBe(0)
      expect(clearedHandles).toContain(handle)
      expect(rendered()).toContain(en.signedOut)
    })
  })

  describe('#4 unknown package size', () => {
    const accounts = [
      { packageName: 'pkg-unknown', remain: 5, size: 0 },
      { packageName: 'pkg-known', remain: 5, size: 10 },
    ]

    /** Open the credit-details tab, where the per-package bars live. */
    async function openDetails(): Promise<void> {
      statusReply = { ok: true, body: signedInStatus({ credits: { total: 10, accounts }, models: [] }) }
      await mount()
      await press(t('tabDetails'))
    }

    const bars = () => new Map(view!.root
      .findAll(node => node.props?.['role'] === 'progressbar')
      .map(node => [String(node.props['aria-label']), node]))

    it('states the remaining share as unknown instead of a fabricated 100%', async () => {
      await openDetails()

      const text = rendered()
      expect(text).toContain(en.percentUnknown)
      // Before the fix the same row printed "100% remaining" above a full bar,
      // claiming an untouched quota the plugin knows nothing about.
      expect(text).not.toContain(t('percentRemaining', { percent: formatPercent(100) }))
      // The honest detail line is unchanged.
      expect(text).toContain(t('creditPackageUnknownSize', { remain: formatNumber(5) }))
    })

    it('draws no fill and announces no numeric value when the size is unknown', async () => {
      await openDetails()

      const unknown = bars().get('pkg-unknown')!
      expect(unknown.props['aria-valuenow']).toBeUndefined()
      expect(unknown.props['aria-valuemin']).toBeUndefined()
      expect(unknown.props['aria-valuemax']).toBeUndefined()
      expect(unknown.props['aria-valuetext']).toBe(t('creditPackageUnknownSize', { remain: formatNumber(5) }))
      // The track renders, the fill inside it does not.
      expect(unknown.children).toHaveLength(0)
    })

    it('is unchanged for a package whose size the upstream reported', async () => {
      await openDetails()

      const text = rendered()
      expect(text).toContain(t('percentRemaining', { percent: formatPercent(50) }))
      expect(text).toContain(t('exactRemaining', { remain: formatNumber(5), size: formatNumber(10) }))

      const known = bars().get('pkg-known')!
      expect(known.props['aria-valuenow']).toBe(50)
      expect(known.children).toHaveLength(1)
    })
  })

  describe('#5 before the first response', () => {
    it('shows the loading label, a pending live region and no signed-out claim', async () => {
      // The first read never settles: the card must say "not read yet", not
      // claim the account is signed out.
      statusReply = { hang: true }
      await mount()

      const text = rendered()
      expect(text).toContain(en.loading)
      expect(text).not.toContain(en.signedOut)
      expect(text).not.toContain(en.signedOutHint)
      expect(text).not.toContain(en.requestFailed)

      const row = view!.root.find(node => node.props?.['role'] === 'status' && node.props?.['aria-busy'] !== undefined)
      expect(row.props['aria-busy']).toBe(true)
      // Neutral dimmed dot: neither the success green nor the error red, and not
      // the signed-out grey that reads as "nothing is wrong".
      const dot = row.findAll(node => node.props?.['aria-hidden'] === 'true')[0]!
      expect(dot.props.style.background).toBe('var(--dsw-alias-label-dimmed, #9aa0a6)')

      // Refresh stays available, under its own label: `busy` still means "an
      // action is in flight".
      const refresh = buttons().find(node => node.children.join('') === en.refresh)!
      expect(refresh.props.disabled).toBe(false)
      expect(labels()).not.toContain(en.refreshing)
    })
  })

  describe('#6 no sequence guard on reads', () => {
    it('keeps the document whose read started last, even when it settles first', async () => {
      // Request 0 hangs; the user's Refresh starts request 1, which is answered
      // in process by the stub.
      plan = (_url, _init, index) => index === 0 ? { hang: true } : statusReply
      statusReply = { ok: true, body: signedInStatus({ nickname: 'newer' }) }
      await mount()
      await press(en.refresh)
      expect(rendered()).toContain('newer')

      // The slow first read now settles with the older document. "Last to
      // settle wins" would revert the card to it.
      await release(0, { ok: true, body: signedInStatus({ nickname: 'older' }) })

      expect(rendered()).toContain('newer')
      expect(rendered()).not.toContain('older')
      expect(rendered()).not.toContain(NOTICE)
    })

    it('drops a superseded failure silently instead of blanking the card', async () => {
      plan = (_url, _init, index) => index === 0 ? { hang: true } : statusReply
      statusReply = { ok: true, body: signedInStatus({ nickname: 'newer' }) }
      await mount()
      await press(en.refresh)
      expect(rendered()).toContain('newer')

      // The superseded read fails. It has no claim on the card: no error state,
      // no notice, no label change.
      await release(0, { ok: false, status: 500, body: {} })

      expect(rendered()).toContain('newer')
      expect(rendered()).not.toContain(NOTICE)
      expect(rendered()).not.toContain(en.requestFailed)
    })
  })

  describe('#11 a failed write reports beside the document (review §11)', () => {
    it('keeps the account and credits on screen when the write is rejected, and clears the notice after a good read', async () => {
      // The write paths (`refreshModels`, `control`) apply the same policy as a
      // failed read: the reason is attached beside the document, never in place
      // of it. A rejected "Refresh model list" must not take the account and
      // credit figures away over one failed action, and abort cannot reach here.
      statusReply = {
        ok: true,
        body: signedInStatus({
          nickname: 'nick',
          credits: { total: 15, accounts: [] },
          catalog: { source: 'live', fetchedAt: Date.UTC(2026, 8, 12, 8, 30) },
        }),
      }
      await mount()
      expect(rendered()).toContain('nick')
      expect(rendered()).toContain(t('creditsTotal', { total: formatNumber(15) }))

      writeReply = { ok: false, status: 500, body: {} }
      await press(en.refreshModels)

      const failed = rendered()
      expect(failed).toContain(NOTICE)
      expect(failed).toContain('HTTP 500')
      // The document survives the rejected write, and the label still describes
      // the account rather than the failed action.
      expect(failed).toContain('nick')
      expect(failed).toContain(t('creditsTotal', { total: formatNumber(15) }))
      expect(failed).not.toContain(en.requestFailed)

      // A successful read clears it, exactly as it clears a read failure.
      statusReply = { ok: true, body: signedInStatus({ nickname: 'back' }) }
      await tickIntervals()

      expect(rendered()).toContain('back')
      expect(rendered()).not.toContain(NOTICE)
    })
  })
})

/* -------------------------------------------------------------------------- *
 * The composer control
 * -------------------------------------------------------------------------- */

describe('WorkBuddyProbeControl', () => {
  let view: ReactTestRenderer | undefined
  let state: ReturnType<WorkBuddyProbeControlProps['directory']['getSnapshot']>
  const listeners = new Set<() => void>()
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as WorkBuddyProbeControlProps['directory']

  beforeEach(() => {
    state = { current: { provider: 'workbuddy', model: 'glm-5.2' }, status: 'ready', groups: [], failures: [], error: null, routable: true }
  })

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
    listeners.clear()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      view = create(createElement(WorkBuddyProbeControl, { directory, t: t as WorkBuddyProbeControlProps['t'] }))
    })
  }

  const controlButton = () => view!.root.findAllByType('button')[0]!

  it('#2 survives a status body of literal null without tearing the control down', async () => {
    // `resultFor` dereferences `status.status` on every render, so a null body
    // stored unchecked threw inside the composer slot. A crashed render unmounts
    // the root and leaves `toJSON()` null as well, so liveness — not the null
    // output — is what this pins.
    statusReply = { ok: true, body: null }
    await mount()

    expect(view!.toJSON()).toBeNull()
    expect(() => view!.root).not.toThrow()
  })

  it('#2 recovers on the next readable document', async () => {
    statusReply = { ok: true, body: null }
    await mount()
    expect(view!.toJSON()).toBeNull()

    statusReply = {
      ok: true,
      body: signedInStatus({
        probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] },
      }),
    }
    await fireFocus()

    // A control that had crashed on the bad document could never get here: the
    // failed render unmounts the tree and every later read is dropped.
    expect(view!.toJSON()).not.toBeNull()
    expect(controlButton().props['aria-label']).toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))
  })

  it('#7 reports a recorded result instead of a remembered failure', async () => {
    statusReply = {
      ok: true,
      body: signedInStatus({
        probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] },
      }),
    }
    // The detection this control starts fails.
    writeReply = { ok: false, status: 500, body: { error: 'probe failed' } }
    await mount()
    expect(controlButton().props['aria-label']).toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))

    await act(async () => { controlButton().props.onClick() })
    const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { confirm.props.onClick() })
    expect(controlButton().props['aria-label']).toBe(en.probeTooltipRetry)

    // A status read now carries a recorded, verified result for the same model
    // (a detection run from the settings card, or a finished sweep). The levels
    // the user paid for outrank the stale failure.
    statusReply = {
      ok: true,
      body: signedInStatus({
        probe: {
          consent: true,
          running: false,
          candidates: ['glm-5.2'],
          results: [{
            id: 'glm-5.2',
            name: 'GLM-5.2',
            validation: 'validating',
            efforts: ['low', 'high'],
            probedAt: Date.now(),
          }],
        },
      }),
    }
    await fireFocus()

    const label = t('probeTooltipVerified', { levels: 'low / high' })
    expect(controlButton().props['aria-label']).toBe(label)
    // The same string is the button's accessible name, so it must not still
    // announce the failure.
    expect(controlButton().props['aria-label']).not.toBe(en.probeTooltipRetry)
  })

  it('#7 clears the remembered failure once a result lands, so it cannot resurface', async () => {
    // §7.2: the flag is dropped when a read supplies a result, so it can never
    // outlive the state it contradicts. This is the half of the fix that the
    // tooltip ordering cannot compensate for on its own — the host clearing its
    // recorded results must not resurrect a failure the user already resolved.
    statusReply = {
      ok: true,
      body: signedInStatus({ probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] } }),
    }
    writeReply = { ok: false, status: 500, body: { error: 'probe failed' } }
    await mount()
    await act(async () => { controlButton().props.onClick() })
    const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { confirm.props.onClick() })
    expect(controlButton().props['aria-label']).toBe(en.probeTooltipRetry)

    const recorded = {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      validation: 'validating',
      efforts: ['low', 'high'],
      probedAt: Date.now(),
    }
    statusReply = {
      ok: true,
      body: signedInStatus({ probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [recorded] } }),
    }
    await fireFocus()
    expect(controlButton().props['aria-label']).toBe(t('probeTooltipVerified', { levels: 'low / high' }))

    // The host clears its results again. The failure was about a run whose
    // answer has since arrived, so the control goes back to idle, not to retry.
    statusReply = {
      ok: true,
      body: signedInStatus({ probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] } }),
    }
    await fireFocus()
    expect(controlButton().props['aria-label']).toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))
  })

  describe('#7.1 tooltip precedence order', () => {
    /** A signed-in document whose probe section carries `results` for the selected model. */
    const withResults = (results: unknown[]): { ok: true, body: unknown } => ({
      ok: true,
      body: signedInStatus({
        probe: { consent: true, running: false, candidates: ['glm-5.2'], results },
      }),
    })

    const recorded = (validation: string, efforts: string[]): Record<string, unknown> => ({
      id: 'glm-5.2', name: 'GLM-5.2', validation, efforts, probedAt: Date.now(),
    })

    /** The two clicks that start a detection: the control, then the bubble's Confirm. */
    async function detect(): Promise<void> {
      await act(async () => { controlButton().props.onClick() })
      const confirm = view!.root.findAllByType('button')
        .find(node => node.children.join('') === en.probeConfirmAction)!
      await act(async () => { confirm.props.onClick() })
    }

    it('ranks busy above a recorded result, and the result above a stale failure', async () => {
      // §7.1 (normative order): `busy` → recorded `result` → `failed` → idle.
      // The reachable state the order decides: a result is ALREADY on screen
      // when a fresh detection of the same model fails. No read intervenes, so
      // `result` never changes identity, the clearing effect never runs, and
      // `failed && result !== undefined` holds — nothing but the branch order
      // can keep the levels on screen.
      statusReply = withResults([recorded('validating', ['low', 'high'])])
      await mount()

      const verified = t('probeTooltipVerified', { levels: 'low / high' })
      // Rung 2: a recorded result is described, not the idle copy.
      expect(controlButton().props['aria-label']).toBe(verified)
      expect(controlButton().props['aria-label']).not.toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))

      // Hold the POST open so the busy rung is observable with a result present:
      // §7.1 puts `busy` above the recorded result, so the running copy wins.
      plan = (_url, init) => (init?.method === 'POST' ? { hang: true } : statusReply)
      await detect()
      expect(controlButton().props['aria-label']).toBe(t('probeRunning', { model: 'glm-5.2' }))
      expect(controlButton().props['aria-label']).not.toBe(verified)

      // The run fails. Before §7.1 the failure copy was returned first and the
      // levels the user had already paid for disappeared behind
      // "Detection did not complete · click to retry".
      await release(1, { ok: false, status: 500, body: { error: 'probe failed' } })

      expect(controlButton().props['aria-label']).toBe(verified)
      expect(controlButton().props['aria-label']).not.toBe(en.probeTooltipRetry)
    })

    it('ranks a non-validating result above the remembered failure too', async () => {
      // The result rung outranks `failed` as a whole, not only its verified
      // sub-branch: swapping those two branches must fail here as well.
      statusReply = withResults([recorded('non-validating', [])])
      writeReply = { ok: false, status: 500, body: { error: 'probe failed' } }
      await mount()
      expect(controlButton().props['aria-label']).toBe(en.probeTooltipNotValidating)

      await detect()

      expect(controlButton().props['aria-label']).toBe(en.probeTooltipNotValidating)
      expect(controlButton().props['aria-label']).not.toBe(en.probeTooltipRetry)
    })

    it('keeps the failure copy for a failure with no result, and the idle copy for neither', async () => {
      // Rungs 3 and 4: the failure copy is what remains when there is no result
      // to report (§7.1.4), and idle is what remains when nothing happened.
      statusReply = withResults([])
      await mount()
      expect(controlButton().props['aria-label']).toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))

      writeReply = { ok: false, status: 500, body: { error: 'probe failed' } }
      await detect()

      expect(controlButton().props['aria-label']).toBe(en.probeTooltipRetry)
      expect(controlButton().props['aria-label']).not.toBe(t('probeTooltipIdle', { model: 'glm-5.2' }))
    })
  })
})

/* -------------------------------------------------------------------------- *
 * The fallback catalog
 * -------------------------------------------------------------------------- */

describe('#8 fallback catalog display names', () => {
  it('gives every CN fallback row a distinct name and keeps both hybrid ids', () => {
    const names = FALLBACK_WORKBUDDY_MODELS.map(model => model.name)
    // Before the fix `hy3` and `hy3-x` both read "Hy3": the picker showed one
    // bare and one suffixed entry, and the context table two identical rows.
    expect(new Set(names).size).toBe(names.length)

    const byId = new Map(FALLBACK_WORKBUDDY_MODELS.map(model => [model.id, model]))
    // The ids are the wire contract and must not move.
    expect(byId.has('hy3')).toBe(true)
    expect(byId.has('hy3-x')).toBe(true)
    expect(byId.get('hy3')?.name).toBe('Hy3')
    expect(byId.get('hy3-x')?.name).toBe('Hy3-X')
  })

  it('leaves the international fallback names alone', () => {
    const names = FALLBACK_WORKBUDDY_AI_MODELS.map(model => model.name)
    expect(new Set(names).size).toBe(names.length)
    expect(FALLBACK_WORKBUDDY_AI_MODELS.find(model => model.id === 'hy3')?.name).toBe('Hy3')
  })
})
