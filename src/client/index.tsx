/** Browser half: WorkBuddy account status inside Plugin configuration. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/** Register card copy and the WorkBuddy card under Plugin configuration. */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.workbuddy'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
  const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'workbuddy',
    order: 30,
    inject: (): WorkBuddyPluginCardInjected => ({ t }),
  }, WorkBuddyPluginCard))
}
