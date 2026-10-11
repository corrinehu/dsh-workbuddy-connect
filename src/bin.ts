#!/usr/bin/env node
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, workbuddyOwnAuthPath } from './auth.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from './catalog.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'
import { atRestKeyProviderFor } from './desktop-credential-protection.ts'
import { CN_VARIANT, variantFor, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'
import { resolveAppVersion } from './app-version.ts'
import { POOL_ACTIONS, runPoolCommand } from './pool-cli.ts'

type Action = 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-workbuddy-connect <command> [options]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, remaining WorkBuddy credit, and host-bundle health',
    '  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)',
    '',
    'Account pool (bulk import, rotation, daily check-in):',
    '  import <path...>   merge accounts from files or directories into the pool',
    '                     accepts the desktop auth document, the flat gateway auth,',
    '                     an array, a uid-keyed map, or JSON Lines',
    '  accounts           list the pool (never prints a token)',
    '  checkin            claim the daily credit grant for every usable account',
    '  use <key>          make one account the active one',
    '  enable|disable <key>   include or exclude one account from rotation',
    '  remove <key>       delete one account from the pool',
    '  clear              empty the pool (falls back to the desktop sign-in)',
    '',
    '  --provider  which product to inspect; defaults to workbuddy',
    `              one of: ${WORKBUDDY_VARIANTS.map(variant => variant.id).join(', ')}`,
    '  --json      emit one secret-free JSON document (all commands)',
    '  --pool      pool file path (defaults to the plugin-owned file under $DSH_HOME)',
    '  --replace   import: replace the pool instead of merging into it',
    '  --credits   checkin: also read each account\'s remaining credit',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * One variant's store plus the client that performs its refreshes.
 *
 * The key provider is built by the same shared helper the plugin host uses,
 * so the CLI's `doctor`/`status` and the browser card can never disagree
 * about which product's Electron a variant resolves.
 */
function makeStore(variant: WorkBuddyVariant): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({
    variant,
    refresh: credential => client.refreshToken(credential),
    keyProvider: atRestKeyProviderFor(variant),
  })
}

/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant: WorkBuddyVariant): string {
  return makeStore(variant).ownAuthPath()
}

/** Fallback roster size for one variant. */
function fallbackCount(variant: WorkBuddyVariant): number {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length
}

async function doctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const status = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const desktopFormat = await store.desktopAuthFormat()
  // Name the file that was actually hit (e.g. the XDG data-home copy on
  // UOS/deepin, issue #43), falling back to the first *possible* location
  // when none exists so the hint still says where to point WORKBUDDY_AUTH_FILE.
  const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  // Only the international variant needs a UA, and reading it is how `doctor`
  // answers "where would the catalog version come from" without guessing.
  const appVersion = variant.region === 'global' ? await resolveAppVersion() : undefined
  // A signed-out state beside an encrypted file usually means the unlock
  // failed, not that nobody is signed in: the status reason carries the real
  // cause, it is promoted to the first hint, and the generic "sign in again"
  // hint is suppressed — sending the user to re-login would be the wrong fix.
  const decryptionNote = status.state === 'signed-out' && desktopFormat === 'encrypted' && status.reason !== undefined
    ? `Encrypted desktop credential could not be used: ${status.reason}`
    : undefined
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-workbuddy-connect',
    version: WORKBUDDY_CONNECT_VERSION,
    node: process.version,
    provider: variant.id,
    displayName: variant.displayName,
    desktopAuthFile: {
      path: desktopPath ?? `(no platform default; set ${variant.env})`,
      present: desktopPresent,
      // How the file reads on disk: absent | plaintext | encrypted |
      // unrecognized. WorkBuddy 5.6 seals its token fields, so "encrypted"
      // is a healthy state, not an error — the unlock is attempted (and its
      // failure explained) by the sign-in state below.
      format: desktopFormat,
    },
    ownAuthFile: ownAuthPath(variant),
    ...appVersion === undefined ? {} : {
      catalogUserAgent: {
        version: appVersion.version,
        source: appVersion.source,
        ...appVersion.bundle === undefined ? {} : { bundle: appVersion.bundle },
      },
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    fallbackModels: fallbackCount(variant),
    hints: [
      ...decryptionNote !== undefined ? [decryptionNote]
        : status.state === 'signed-out' ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
      ...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson({ ...report, ...decryptionNote === undefined ? {} : { decryptionNote } })
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} — ${desktopFormat} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...appVersion === undefined ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && desktopPresent ? 0 : 1
}

async function status(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const client = new WorkBuddyUpstreamClient()
  const authStatus = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    if (jsonOutput) {
      printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-workbuddy-connect', version: WORKBUDDY_CONNECT_VERSION, provider: variant.id, status: 'signed-out', hostBundle: hostState })
    } else {
      process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`)
    }
    return 1
  }
  let credits: { total: number; unlimited?: true; error?: string } | undefined
  try {
    const credential = await store.current()
    if (credential !== undefined) {
      const fetched = await client.fetchCredits(credential)
      credits = {
        total: fetched.total,
        ...fetched.unlimited === true ? { unlimited: true } : {},
      }
    }
  } catch (error: unknown) {
    credits = { total: 0, error: safeMessage(error) }
  }
  const expiresAt = authStatus.expiresAtMs !== undefined ? new Date(authStatus.expiresAtMs).toISOString() : undefined
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy-connect',
      version: WORKBUDDY_CONNECT_VERSION,
      provider: variant.id,
      status: 'signed-in',
      ...expiresAt === undefined ? {} : { accessTokenExpires: expiresAt },
      ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
      ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
      source: authStatus.source,
      credits: credits?.total,
      ...credits?.unlimited === true ? { creditsUnlimited: true } : {},
      ...credits?.error === undefined ? {} : { creditsError: credits.error },
      hostBundle: hostState,
    })
    return 0
  }
  process.stdout.write([
    `${variant.displayName} Connect: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    credits?.error !== undefined
      ? `Remaining credit: unavailable (${credits.error})`
      // An uncapped quota has no balance to print; showing the placeholder 0
      // would read as "exhausted".
      : credits?.unlimited === true
        ? 'Remaining credit: unlimited'
        : `Remaining credit: ${credits?.total ?? 'unknown'}`,
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
    '',
  ].join('\n'))
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  // The pool subcommands are routed before the single-account actions so their
  // argument grammar stays self-contained (see `pool-cli.ts`).
  if (POOL_ACTIONS.has(rawAction!)) return await runPoolCommand(argv)
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-workbuddy-connect: expected doctor, logout, status, or one of ${[...POOL_ACTIONS].sort().join(', ')}; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the CN provider, so
  // every existing invocation keeps its behaviour.
  let providerId: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CN_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  const unknown = rest.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await status(jsonOutput, variant)
      case 'logout': {
        const store = makeStore(variant)
        // Only this variant's plugin-owned copy is removed: the desktop app's
        // own sign-in is never touched, and the model group is not promised to
        // disappear (the desktop file may still supply a credential).
        await store.logout()
        process.stdout.write(
          `${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`,
        )
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
