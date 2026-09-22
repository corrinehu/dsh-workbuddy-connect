/**
 * Browser half: the WorkBuddy account page on DSH's Plugins page, plus the
 * per-model reasoning-effort control in the composer.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WORKBUDDY_BUNDLE, WorkBuddyPluginPage } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginPageInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin page copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'
/**
 * Client services required by this plugin's contributions.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service), so the
 * services here come from narrower packages: the `slots` registry lives in
 * `@deepseek-ai/dsh-client-ui-renderer`, `locale` in
 * `@deepseek-ai/dsh-client-locale`, and the Plugins page's slot contract in
 * `@deepseek-ai/dsh-client-ui-plugin-manager`. The packages are named in this
 * package's `dsh.client.inject` list, so cordis has activated them before this
 * plugin's fiber starts. The slot contributions are additionally registered
 * through `slots.inject`, which waits for the owning page to declare the seat.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Register card copy, the bundle's configuration page, and the composer's
 * reasoning-effort control.
 *
 * The page seat changed in DSH 0.1.7. The Plugins page used to dispatch a
 * settings card by rendering `settings.plugin.item` with `entryKey = <settings
 * namespace>` for each namespace the Host served; a plugin had to install one
 * section per card for its entries to be dispatched at all. That model is gone
 * (a namespace is now a profile entry id, one per plugin instance), and a
 * plugin's own page is contributed once, keyed by its package name, into
 * `plugins.bundle.config`. Both variants therefore render inside one page.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades to a
 * `console.error` instead of throwing into the DSH loader and raising the red
 * "Failed to load plugins" banner. The host provider keeps working: the
 * `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect status`
 * reports host health via the heartbeat file.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginPageInjected['t']
    // One page, keyed by this bundle's package name. `slots.inject` defers the
    // registration until the Plugins page declares the seat, so this plugin
    // loads whether or not that page is part of the composition.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: WORKBUDDY_BUNDLE,
      inject: (): WorkBuddyPluginPageInjected => ({ t }),
    }, WorkBuddyPluginPage))
    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'workbuddy-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, WorkBuddyProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-connect] client page failed to load (host provider unaffected):', error)
  }
}
