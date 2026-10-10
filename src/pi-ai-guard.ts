/**
 * Confirm the pi-ai copy this plugin actually loaded is the generation the DSH
 * 0.2.0-rc.2 host was built against.
 *
 * #92's failure mode: a pnpm profile with `nodeLinker: hoisted` and
 * `autoInstallPeers: false` installs no peer for us, so a co-installed
 * plugin's older pi-ai sits at the profile root and wins bare-specifier
 * resolution. The host then adds a system message (pi-ai 0.87's
 * `collapseSystemMessages`) and the older copy answers `estimateMessageTokens`
 * by reading `.length` off a block it does not model — every request dies at
 * `PI_AI_ERROR` before any upstream HTTP. Declaring pi-ai as a regular
 * dependency (package.json) is the fix; this module exists so a future
 * regression reports *what* it loaded instead of that opaque crash.
 *
 * It is deliberately a warning, not a throw. The plugin is mid-load at this
 * point, and a hard failure here would take down a host that may still be able
 * to serve other providers. The message is the product; the operator decides.
 *
 * @module dsh-workbuddy-connect/pi-ai-guard
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The pi-ai generation this plugin is built and tested against. */
export const REQUIRED_PI_AI_VERSION = '0.87.1'

/**
 * Read the version of the pi-ai copy Node resolves for *this* module.
 *
 * The package's exports map does not open `./package.json`, so the manifest
 * cannot be imported. Instead the module's own specifier is resolved and the
 * resulting file is walked up to the directory whose `package.json` names
 * `@earendil-works/pi-ai`. That reads the copy actually loaded rather than a
 * guess from the install tree.
 *
 * @returns The resolved version, or undefined when it cannot be determined.
 */
export function resolvedPiAiVersion(): string | undefined {
  let entry: string
  try {
    entry = import.meta.resolve('@earendil-works/pi-ai')
  } catch {
    return undefined
  }
  let dir = dirname(fileURLToPath(entry))
  // The entry sits at <package>/dist/index.js, so the manifest is one or two
  // levels up; a few extra steps keep this working if that layout shifts.
  for (let step = 0; step < 5; step += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === '@earendil-works/pi-ai' && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // No manifest here, or not readable: keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * One line describing a pi-ai copy that is not the required generation, or
 * undefined when the resolved version matches or cannot be read.
 *
 * The cause is left open on purpose. A hoisted profile root is the case #92
 * measured, but an updater or installer can just as easily leave the wrong copy
 * in place, and this diagnostic cannot tell them apart from a version string.
 * Naming both versions and the remedy is what the reader can act on; naming only
 * versions and the fix also keeps any filesystem path out of logs and reports.
 *
 * Carries no plugin prefix: callers log it under their own.
 *
 * @param resolved - Version to report on. Read from the live module graph when
 * omitted; pass it explicitly to describe a hypothetical copy.
 */
export function piAiVersionWarning(resolved?: string | undefined): string | undefined {
  const version = arguments.length === 0 ? resolvedPiAiVersion() : resolved
  if (version === undefined || version === REQUIRED_PI_AI_VERSION) return undefined
  return `loaded @earendil-works/pi-ai ${version}, but this plugin is built for `
    + `${REQUIRED_PI_AI_VERSION}. The wrong copy is being resolved — check the `
    + 'profile\'s pi-ai install (a pnpm profile with nodeLinker "hoisted" and '
    + `autoInstallPeers false can expose another package's older copy). Reinstalling the `
    + `plugin so it installs its own ${REQUIRED_PI_AI_VERSION} copy resolves it`
}
