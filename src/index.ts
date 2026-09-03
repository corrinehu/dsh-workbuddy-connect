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

  // Normalize the accounts config into provider entries.
  const accountEntries: readonly { key: string }[] = (config.accounts ?? [])
    .filter(key => key.trim() !== '')
    .map(key => ({ key: key.trim() }))

  const multiAccount = accountEntries.length > 0

  // Single store (legacy) vs. multi-account manager. Both feed the shim, which
  // discriminates by instance type.
  const store: WorkBuddyCredentialStore | WorkBuddyAccountManager = multiAccount
    ? new WorkBuddyAccountManager({
      ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
      refresh: credential => client.refreshToken(credential),
    })
    : new WorkBuddyCredentialStore({
      ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
      refresh: credential => client.refreshToken(credential),
    })

  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })

  // Same-origin status route backing the Plugin-configuration card; the
  // webServer service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx => registerWorkBuddyStatusRoute(webCtx, { store, client, models: () => catalog.current() }))

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file path live across edits.
  let current = () => config
  installSettingsSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
    setSource(source) { current = source },
    onChange() {
      const next = current().authFile
      if (store instanceof WorkBuddyCredentialStore) store.setDesktopPath(next)
    },
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(() => {
      if (stopped) return

      let invalidate: (() => void) | undefined
      try {
        const registrations: Array<() => void> = []
        const registerOne = (
          providerId: string,
          displayName: string,
          accountKey: string | undefined,
        ): void => {
          const workbuddy = createWorkBuddyAdapter({
            shim,
            store,
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
            registerOne(providerId, `WorkBuddy · ${entry.key}`, entry.key)
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
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy-connect: provider registration failed', error)
        return
      }

      void (async () => {
        try {
          // Seed the dynamic catalog from the default (or first) account.
          let credential: WorkBuddyCredential | undefined
          if (store instanceof WorkBuddyAccountManager) {
            const key = config.defaultAccount
              ?? accountEntries[0]?.key
            if (key !== undefined) credential = await store.resolve(key)
          } else {
            credential = await store.current()
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
