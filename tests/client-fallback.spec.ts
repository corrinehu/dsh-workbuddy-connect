/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

/**
 * The client entry degrades a slot-API breaking change (the rc.6→rc.7
 * `id`→`key` rename that caused the red "Failed to load plugins" banner)
 * to a console.error, so the host provider keeps working without a banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages); instead we replicate the exact try/catch shape from
 * `src/client/index.tsx` and assert it swallows a simulated throw.
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real
 * `apply()` in `src/client/index.tsx` (see the NOTE on that function). It is
 * NOT the product code, so this test only proves the fallback idea works — it
 * cannot detect a regression in the real entry. If you change the real
 * `apply()`'s guarded body or its `console.error` message, update the mirror
 * here too; a mismatch between the two is invisible to this test.
 */
describe('client card fallback', () => {
  it('swallows a slot registration failure instead of throwing', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    // Simulate a DSH loader that throws on ctx.slots.inject (the rc.7
    // "requires options.key" error). Loose `any` on purpose: we only test
    // the try/catch boundary, not the DSH client API types.
    const fakeCtx: any = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => () => '' },
      slots: {
        inject: () => { throw new Error('keyed slot "settings.plugin.item" requires options.key') },
      },
    }

    // Mirror of src/client/index.tsx apply() body.
    function apply(ctx: any): void {
      try {
        const namespace = 'settings.workbuddy'
        ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-workbuddy-connect: settings copy')
        const t = ctx.locale.bind(namespace)
        ctx.slots.inject('settings.plugin.item', () => {
          throw new Error('not reached')
        })
        void t
      } catch (error: unknown) {
        console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
      }
    }

    // Must not throw — the whole point of the fallback.
    expect(() => apply(fakeCtx)).not.toThrow()

    // The error is visible in the console for developers.
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('client card failed to load')
    expect(String(errors[0])).toContain('requires options.key')

    spy.mockRestore()
  })
})
