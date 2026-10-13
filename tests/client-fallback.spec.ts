/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_NAME } from '../src/client/index.tsx'

/**
 * Per-contribution error isolation of the REAL client entry.
 *
 * Every browser-side contribution is guarded at both boundaries where it can
 * throw — the eager `ctx.slots.inject(...)` call and the deferred callback the
 * slot runtime invokes later — so one failing registration never takes the
 * others with it, and nothing ever throws into the DSH loader (the red
 * "Failed to load plugins" banner). These specs drive the real `apply()`
 * directly: its only runtime imports are React and local modules (every DSH
 * import is type-only and erased), so unlike the old hand-copied mirror there
 * is no drift risk between this spec and the implementation.
 *
 * The fake context simulates a host whose slots are all already declared, so
 * each `ctx.slots.inject(name, cb)` runs `cb` synchronously — exercising both
 * guarded boundaries in one pass. Failure injection happens at the register
 * or inject call, matching where a slot-API breakage or a bad registration
 * actually throws.
 */

/** One registration the fake slot registry accepted: slot name and key/id. */
interface RecordedRegistration {
  name: string
  key?: string
  id?: string
}

/** Everything a driven `apply()` did, for assertions. */
interface Harness {
  ctx: any
  /** Slot names passed to `ctx.slots.inject`, in call order. */
  injectedSlots: string[]
  /** Accepted registrations, in order. */
  registered: RecordedRegistration[]
  /** Whether the `modelDirectories` scope was entered. */
  enteredModelDirectories: () => boolean
  /** Captured console.error arguments, one entry per degraded contribution. */
  errors: unknown[][]
}

/** Which slot registrations exist as declarations (callback fires at inject). */
const ALL_SLOTS = [
  'settings.plugin.item',
  'plugins.bundle.config',
  'conversation.input.right',
  'conversation.chat.turnTail',
  'shell.overlay',
]

/**
 * Build the fake host context. `failInject` throws from a `ctx.slots.inject`
 * call for a slot name; `failRegister` throws from the deferred
 * `ctx.slots.register` for a slot name; `failLocale` throws from the locale
 * registration.
 */
function harness(options: {
  failInject?: (name: string) => string | undefined
  failRegister?: (name: string, key?: string, id?: string) => string | undefined
  failLocale?: boolean
  declared?: readonly string[]
} = {}): Harness {
  const declared = new Set(options.declared ?? ALL_SLOTS)
  const injectedSlots: string[] = []
  const registered: RecordedRegistration[] = []
  const errors: unknown[][] = []
  let enteredModelDirectories = false
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

  const slots: any = {
    inject: (name: string, callback: () => void) => {
      const failure = options.failInject?.(name)
      if (failure !== undefined) throw new Error(failure)
      injectedSlots.push(name)
      if (declared.has(name)) callback()
    },
    register: (slotOptions: any) => {
      const failure = options.failRegister?.(slotOptions.name, slotOptions.key, slotOptions.id)
      if (failure !== undefined) throw new Error(failure)
      registered.push({ name: slotOptions.name, key: slotOptions.key, id: slotOptions.id })
    },
  }

  const ctx: any = {
    effect: (fn: () => unknown) => { fn(); return () => {} },
    locale: {
      register: () => {
        if (options.failLocale === true) throw new Error('locale service is broken')
        return () => {}
      },
      bind: () => (key: string) => key,
    },
    slots,
    inject: (_names: string[], callback: (scope: any) => void) => {
      enteredModelDirectories = true
      callback({
        modelDirectories: { directoryFor: () => ({ store: {} }) },
        slots,
      })
    },
  }

  return {
    ctx,
    injectedSlots,
    registered,
    enteredModelDirectories: () => enteredModelDirectories,
    errors,
  }
}

/** The registrations a fully successful `apply()` makes, in order. */
const ALL_REGISTRATIONS: RecordedRegistration[] = [
  { name: 'shell.overlay', id: 'workbuddy-update' },
  { name: 'settings.plugin.item', key: 'workbuddy' },
  { name: 'settings.plugin.item', key: 'workbuddy-ai' },
  { name: 'plugins.bundle.config', key: BUNDLE_NAME },
  { name: 'conversation.input.right', id: 'workbuddy-probe' },
  { name: 'conversation.chat.turnTail', id: 'workbuddy-turn-spend' },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('client contribution isolation', () => {
  it('registers every contribution on a healthy host', () => {
    const h = harness()
    expect(() => apply(h.ctx)).not.toThrow()
    expect(h.registered).toEqual(ALL_REGISTRATIONS)
    expect(h.injectedSlots).toEqual([
      'shell.overlay', 'settings.plugin.item', 'settings.plugin.item', 'plugins.bundle.config',
      'conversation.input.right', 'conversation.chat.turnTail',
    ])
    expect(h.enteredModelDirectories()).toBe(true)
    expect(h.errors).toHaveLength(0)
  })

  it('keeps the second card and both other seams when the first card registration throws', () => {
    // The deferred register for the FIRST legacy card breaks (e.g. its key
    // collides); the isolation contract: the second card, the Plugins-page
    // entry, and the probe control all still register.
    const h = harness({ failRegister: (name, key) => name === 'settings.plugin.item' && key === 'workbuddy'
      ? 'keyed slot already has an entry for key workbuddy'
      : undefined })
    expect(() => apply(h.ctx)).not.toThrow()
    expect(h.registered).toEqual([
      { name: 'shell.overlay', id: 'workbuddy-update' },
      { name: 'settings.plugin.item', key: 'workbuddy-ai' },
      { name: 'plugins.bundle.config', key: BUNDLE_NAME },
      { name: 'conversation.input.right', id: 'workbuddy-probe' },
      { name: 'conversation.chat.turnTail', id: 'workbuddy-turn-spend' },
    ])
    expect(h.errors).toHaveLength(1)
    expect(String(h.errors[0])).toContain('settings.plugin.item card "workbuddy"')
    expect(String(h.errors[0])).toContain('host provider unaffected')
  })

  it('keeps the probe control when the plugins.bundle.config registration throws', () => {
    const h = harness({ failRegister: name => name === 'plugins.bundle.config'
      ? 'keyed slot "plugins.bundle.config" requires options.key'
      : undefined })
    expect(() => apply(h.ctx)).not.toThrow()
    expect(h.registered).toEqual([
      { name: 'shell.overlay', id: 'workbuddy-update' },
      { name: 'settings.plugin.item', key: 'workbuddy' },
      { name: 'settings.plugin.item', key: 'workbuddy-ai' },
      { name: 'conversation.input.right', id: 'workbuddy-probe' },
      { name: 'conversation.chat.turnTail', id: 'workbuddy-turn-spend' },
    ])
    expect(h.errors).toHaveLength(1)
    expect(String(h.errors[0])).toContain('plugins.bundle.config page')
  })

  it('keeps both settings seams when the probe contribution throws', () => {
    // The probe seat's slots.inject itself breaks — inside the
    // modelDirectories scope, i.e. the deferred half of that contribution.
    const h = harness({ failInject: name => name === 'conversation.input.right'
      ? 'slot conversation.input.right is not declared'
      : undefined })
    expect(() => apply(h.ctx)).not.toThrow()
    // The footer is a separate contribution from the probe seat: breaking the
    // probe's inject must not also hide the transcript figure.
    expect(h.registered).toEqual([
      { name: 'shell.overlay', id: 'workbuddy-update' },
      { name: 'settings.plugin.item', key: 'workbuddy' },
      { name: 'settings.plugin.item', key: 'workbuddy-ai' },
      { name: 'plugins.bundle.config', key: BUNDLE_NAME },
      { name: 'conversation.chat.turnTail', id: 'workbuddy-turn-spend' },
    ])
    expect(h.enteredModelDirectories()).toBe(true)
    expect(h.errors).toHaveLength(1)
    expect(String(h.errors[0])).toContain('conversation probe control')
  })

  it('keeps every other contribution when the locale registration throws', () => {
    const h = harness({ failLocale: true })
    expect(() => apply(h.ctx)).not.toThrow()
    expect(h.registered).toEqual(ALL_REGISTRATIONS)
    expect(h.errors).toHaveLength(1)
    expect(String(h.errors[0])).toContain('settings copy')
  })

  it('degrades every contribution independently under a total slot-API breakage', () => {
    // The rc.6→rc.7-style API break: every slots.inject throws. Each of the
    // four contributions logs its own degradation, none rethrows into the
    // loader, and the locale copy still lands.
    const h = harness({ failInject: () => 'slots.inject is not a function' })
    expect(() => apply(h.ctx)).not.toThrow()
    expect(h.registered).toEqual([])
    expect(h.injectedSlots).toEqual([])
    expect(h.enteredModelDirectories()).toBe(true)
    expect(h.errors).toHaveLength(6)
  })
})
