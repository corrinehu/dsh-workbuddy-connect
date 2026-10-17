/**
 * Resolve the version of the package copy this module was loaded from.
 *
 * `version.ts` carries a build-time constant injected by tsdown's `define`
 * from package.json. That is exact for a packaged release, but it goes stale
 * in a source checkout the moment package.json is bumped without rebuilding
 * the bundle — the plugin then reports the previous version while the host
 * (and the update reminder) reads the new one. Issue #149 is exactly that
 * split: an installed `v0.7.6` shown as `当前 0.7.5`.
 *
 * The host-side entries therefore prefer the manifest that sits next to the
 * loaded module and fall back to the build-time constant only when the
 * manifest cannot be read. The browser bundle keeps using the constant
 * directly: it cannot read the filesystem, and the update store receives the
 * host's answer anyway.
 *
 * @module dsh-workbuddy-connect/version-resolve
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** The package name to look for while walking up from the module. */
const PACKAGE_NAME = 'dsh-workbuddy-connect'

/**
 * Read `package.json` walking up from one module URL.
 *
 * The package's exports map does not open `./package.json`, so the manifest
 * cannot be imported; the loaded file is walked up instead. That reads the
 * copy actually in use rather than a guess from the install tree, and shares
 * the approach `pi-ai-guard.ts` uses for the pi-ai copy.
 *
 * @param entryUrl - URL of a module inside the package (`import.meta.url` by default).
 * @returns The declared version, or undefined when no matching manifest is readable.
 */
export function resolvePackageVersion(entryUrl: string): string | undefined {
  let dir: string
  try {
    dir = dirname(fileURLToPath(entryUrl))
  } catch {
    return undefined
  }
  for (let step = 0; step < 5; step += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string' && manifest.version !== '') {
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
 * Version to report for this copy: the manifest's when it can be read, else
 * the build-time constant.
 *
 * @param entryUrl - Module URL to resolve from; tests pass a temp manifest.
 */
export function resolveConnectVersion(entryUrl: string = import.meta.url): string {
  return resolvePackageVersion(entryUrl) ?? WORKBUDDY_CONNECT_VERSION
}

/** Version every host-side entry reports. */
export const CONNECT_VERSION: string = resolveConnectVersion()

/**
 * One line for a build whose constant no longer matches its manifest, or
 * undefined when they agree (or the manifest is unreadable).
 *
 * This is a diagnostic, not a failure: the loaded code still works, it just
 * came from an older build. Naming both versions tells the operator what to
 * rebuild.
 */
export function versionDriftWarning(resolved: string | undefined): string | undefined {
  if (resolved === undefined || resolved === WORKBUDDY_CONNECT_VERSION) return undefined
  return `loaded build reports ${WORKBUDDY_CONNECT_VERSION}, but its package.json says `
    + `${resolved}. The bundle is stale — rebuild the package (\`pnpm run build\`) so the `
    + 'reported version matches the installed one.'
}
