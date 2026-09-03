/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers the `workbuddy` provider; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 * @module dsh-workbuddy-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyAccountManager, WorkBuddyCredential, WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import type { WorkBuddyStatusRouteOptions } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyAccountManager,
  WorkBuddyCredentialStore,
  workbuddyAccountDir,
  workbuddyOwnAuthPath,
  type WorkBuddyAccountInfo,
  type WorkBuddyAccountStatus,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** Settings namespace reserved for the future configuration card. */
export const WORKBUDDY_SETTINGS_NS = settingsNamespace('workbuddy')

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /**
   * Multi-account mode. When omitted or empty, the plugin serves the single
   * desktop sign-in (legacy behavior). Each listed key must be imported first
   * via the CLI (`dsh-workbuddy-connect import <key>`); one provider is
   * registered per key, displayed as `WorkBuddy · <key>`.
   */
  accounts?: string[]
  /** Account key whose credential seeds the shared dynamic model catalog. */
  defaultAccount?: string
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  accounts: z.array(z.string()).description('Account keys to expose as separate providers (import each via the CLI first)'),
  defaultAccount: z.string().description('Account key used to refresh the shared model catalog'),
})

/**
 * Start the loopback endpoint, register the `workbuddy` provider, and
 * refresh the model catalog from the upstream once credentials allow it.
 * The static fallback catalog serves from the first moment, so an offline
 * upstream never leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const catalog = new WorkBuddyCatalog()
  let stopped = false
  /** Effective config: the settings scope value once the section joins, else the plugin config. */
  let current: () => Config = () => config
  let store: WorkBuddyCredentialStore | WorkBuddyAccountManager | undefined
  let shim: ReturnType<typeof createWorkBuddyShim> | undefined
  let invalidate: (() => void) | undefined

  ctx.effect(() => () => {
    stopped = true
    void shim?.close()
    void clearHostHeartbeat()
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file path live across edits. Its first
  // onChange() fires once the settings service has joined the persisted
  // scope values, so `current()` then reflects settings.yaml — that value,
  // not the raw plugin config, decides multi-account mode. The runtime is
  // booted from that callback; the promise merely lets the registration
  // path wait for it deterministically.
  const settingsReady = new Promise<void>(resolve => {
    installSettingsSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        const next = current().authFile
        if (store instanceof WorkBuddyCredentialStore) store.setDesktopPath(next)
        resolve()
      },
    })
  })

  const start = (active: Config): void => {
    // Normalize the effective accounts config into provider entries.
    const accountEntries: readonly { key: string }[] = (active.accounts ?? [])
      .filter(key => key.trim() !== '')
      .map(key => ({ key: key.trim() }))

    const multiAccount = accountEntries.length > 0

    // Single store (legacy) vs. multi-account manager. Both feed the shim,
    // which discriminates by instance type.
    const activeStore = multiAccount
      ? new WorkBuddyAccountManager({
        ...active.authFile === undefined ? {} : { desktopPath: active.authFile },
        refresh: credential => client.refreshToken(credential),
      })
      : new WorkBuddyCredentialStore({
        ...active.authFile === undefined ? {} : { desktopPath: active.authFile },
        refresh: credential => client.refreshToken(credential),
      })
    store = activeStore

    shim = createWorkBuddyShim({ store: activeStore, client, catalog, logger: ctx.logger })

    // Same-origin status route backing the Plugin-configuration card; the
    // webServer service is optional (a headless profile serves no browser).
    // Multi-account mode also exposes removal: deleting a snapshot and, in the
    // same breath, dropping the key from the persisted accounts list so the
    // next start does not resurrect a provider for a deleted credential.
    const routeOptions: WorkBuddyStatusRouteOptions = {
      store: activeStore,
      client,
      models: () => catalog.current(),
    }
    if (multiAccount) {
      routeOptions.remove = async (key: string) => {
        if (!(activeStore instanceof WorkBuddyAccountManager)) return
        await activeStore.remove(key)
        const remaining = (current().accounts ?? []).filter(entry => entry !== key)
        try {
          await ctx.settings?.update(WORKBUDDY_SETTINGS_NS, { accounts: remaining })
        } catch (error: unknown) {
          // The snapshot is already gone; a stale accounts entry only means
          // the next start logs a missing-credential warning for that key.
          ctx.logger.warn('dsh-workbuddy-connect: could not sync the accounts list after removal', error)
        }
      }
    }
    ctx.inject(['webServer'], webCtx => registerWorkBuddyStatusRoute(webCtx, routeOptions))

    void shim.ready
      .then(async () => {
        if (stopped) return

        // Prefer each account's snapshot nickname in the provider display
        // name (the picker then shows e.g. `WorkBuddy · 喵娘_认真看置顶`
        // instead of the raw import key); keys stay the routing identity, so
        // a missing nickname simply falls back to the key.
        const nicknameByKey = new Map<string, string>()
        if (activeStore instanceof WorkBuddyAccountManager) {
          try {
            for (const status of await activeStore.statuses()) {
              if (status.nickname !== undefined) nicknameByKey.set(status.key, status.nickname)
            }
          } catch {
            // Display names fall back to keys; registration must not depend on it.
          }
        }

        let registrations: Array<() => void> = []
        const registerOne = (
          providerId: string,
          displayName: string,
          accountKey: string | undefined,
        ): void => {
          const workbuddy = createWorkBuddyAdapter({
            shim: shim!,
            store: activeStore,
            catalog,
            providerId,
            displayName,
            ...accountKey === undefined ? {} : { accountKey },
            resolveAttachments: () => ctx.get('attachments'),
          })
          invalidate = workbuddy.invalidate
          const releaseAdapter = ctx.llm.registerAdapter([providerId], workbuddy.adapter)
          const releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: providerId,
            displayName,
            settingsNs: WORKBUDDY_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
          registrations.push(releaseAdapter, releaseDirectory)
        }

        if (!multiAccount) {
          registerOne(WORKBUDDY_PROVIDER, 'WorkBuddy', undefined)
        } else {
          for (const entry of accountEntries) {
            const providerId = `${WORKBUDDY_PROVIDER}:${entry.key}`
            const nickname = nicknameByKey.get(entry.key)
            registerOne(providerId, `WorkBuddy · ${nickname ?? entry.key}`, entry.key)
          }
        }

        try {
          ctx.effect(() => () => {
            for (const release of registrations) release()
          })
        } catch {
          for (const release of registrations) release()
        }

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()

        void (async () => {
          try {
            // Seed the dynamic catalog from the default (or first) account.
            let credential: WorkBuddyCredential | undefined
            if (activeStore instanceof WorkBuddyAccountManager) {
              const key = active.defaultAccount
                ?? accountEntries[0]?.key
              if (key !== undefined) credential = await activeStore.resolve(key)
            } else {
              credential = await activeStore.current()
            }
            if (credential === undefined || stopped) return
            const models = await client.fetchModels(credential)
            if (stopped) return
            catalog.set([...models])
            invalidate?.()
          } catch (error: unknown) {
            ctx.logger.warn(
              'dsh-workbuddy-connect: dynamic model catalog unavailable; serving the static fallback list',
              error,
            )
          }
        })()
      })
      .catch((error: unknown) => {
        ctx.logger.error('dsh-workbuddy-connect: loopback endpoint failed to start; provider not registered', error)
      })
  }

  void settingsReady.then(() => {
    if (!stopped) start(current())
  })
}
