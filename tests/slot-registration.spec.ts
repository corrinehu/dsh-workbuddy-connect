/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { CARD_VARIANTS, WORKBUDDY_BUNDLE } from '../src/client/WorkBuddyPluginCard.tsx'

/**
 * The seat this bundle's page occupies on DSH's Plugins page.
 *
 * DSH 0.1.7 replaced the settings-card model. A card used to be dispatched into
 * `settings.plugin.item` with `entryKey = <settings namespace>`, one per
 * namespace a plugin installed; a namespace is now a profile entry id (one per
 * plugin instance), so there is exactly one page per plugin and it is
 * contributed into `plugins.bundle.config`, keyed by the bundle's PACKAGE NAME.
 * The Plugins page renders it with `entryKey: pkg.name` for each bundle it
 * lists, which is why the key is not free to choose.
 *
 * A keyed slot, so whether the registration is accepted is a property of the
 * real slot registry rather than of this plugin's code. These tests drive the
 * actual `SlotCore` instead of trusting the registration shape.
 *
 * Only the variant ids and the key are needed from the card module (the
 * components themselves cannot render in this Node environment), and the
 * register calls are typed loosely on purpose: the point under test is the
 * registry's behaviour, not the DSH client typings.
 */

/** Minimal component stand-in; the registry only stores the reference. */
const Component = (): null => null

const register = (core: SlotCore, options: Record<string, unknown>): unknown =>
  (core.register as any)(options, Component)

/**
 * Declare `plugins.bundle.config` the way the Plugins page does: its `main`
 * entry contributes a `children` table. `SlotCore` has no standalone declare
 * method — the child spec is owned by the registering entry, which is also why
 * a slot can only be claimed once.
 */
function declareBundleConfig(core: SlotCore): void {
  register(core, {
    name: 'root',
    children: {
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    },
  })
}

const entries = (core: SlotCore): any[] => (core.entries as any)('plugins.bundle.config')

describe('the Plugins page seat for this bundle', () => {
  it('keys the page by the package name, which is what the page dispatches on', () => {
    // The page renders the seat with `entryKey: pkg.name` for every bundle it
    // lists, so a key that names no package registers into the slot but is
    // never rendered — the failure mode this guards against.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
    expect(WORKBUDDY_BUNDLE).toBe(manifest.name)
  })

  it('accepts the bundle page registration', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    expect(() => register(core, { name: 'plugins.bundle.config', key: WORKBUDDY_BUNDLE })).not.toThrow()
    expect(entries(core)).toHaveLength(1)
  })

  it('rejects a second registration for the same bundle at the same priority', () => {
    // One page per package: a duplicate would be a second, competing
    // configuration surface for the same bundle, so the registry fails it loud
    // at load time instead of silently shadowing one.
    const core = new SlotCore()
    declareBundleConfig(core)
    register(core, { name: 'plugins.bundle.config', key: WORKBUDDY_BUNDLE })
    expect(() => register(core, { name: 'plugins.bundle.config', key: WORKBUDDY_BUNDLE }))
      .toThrow(/already has an entry for key/)
  })

  it('requires an explicit key, which is why the page passes one', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    // This is the class of breakage the client entry's try/catch exists for.
    expect(() => register(core, { name: 'plugins.bundle.config' }))
      .toThrow(/requires options.key/)
  })

  it('rejects registering into an undeclared slot', () => {
    const core = new SlotCore()
    expect(() => register(core, { name: 'plugins.bundle.config', key: WORKBUDDY_BUNDLE }))
      .toThrow(/not declared/)
  })

  it('renders both products from the one page', () => {
    // The two variants no longer occupy two slot entries — they are two cards
    // inside this bundle's single page, so what has to hold is that the page
    // owns both and that they stay distinguishable.
    expect(CARD_VARIANTS).toHaveLength(2)
    expect(CARD_VARIANTS.map(variant => variant.id)).toEqual(['workbuddy', 'workbuddy-ai'])
    expect(new Set(CARD_VARIANTS.map(variant => variant.statusPath)).size).toBe(2)
    expect(new Set(CARD_VARIANTS.map(variant => variant.probePath)).size).toBe(2)
  })
})
