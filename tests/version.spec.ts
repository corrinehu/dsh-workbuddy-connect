import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract:
 * - the build-time define injects package.json's version into src/version.ts;
 * - if that define is ever dropped, version.ts falls back to '0.0.0-dev' and
 *   this test goes red, flagging the regression (and the drift it would cause
 *   in heartbeat / CLI output).
 */
describe('package version sync', () => {
  it('WORKBUDDY_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(WORKBUDDY_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(WORKBUDDY_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so a release that bumps the
   * version after building ships artifacts reporting the old one (issue #1:
   * v0.2.2 bundles said 0.2.1). The version literal lands in the
   * host-heartbeat chunk (bin.js imports it from there); when lib/ artifacts
   * are present, that chunk must carry the current version. Skipped on a
   * fresh clone before the first build.
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const chunks = readdirSync(libDir).filter(f => /^host-heartbeat-.*\.js$/.test(f))
    expect(chunks.length, 'host-heartbeat chunk missing from lib/ — update this guard if the build layout changed').toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(readFileSync(new URL(`../lib/${chunk}`, import.meta.url), 'utf8'), `${chunk} is stale — rebuild before committing or publishing`).toContain(`"${pkg.version}"`)
    }
  })
})
