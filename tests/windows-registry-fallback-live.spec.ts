import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WINDOWS_POWERSHELL_QUERY_COMMAND,
  WINDOWS_REGISTRY_QUERY_ROOT_ENV,
} from '../src/desktop-credential-protection.ts'

/**
 * The fallback, driven through a real interpreter.
 *
 * `windows-registry-tool.spec.ts` mocks `node:child_process` and asserts the
 * argv the tool builds. That shape encoded a wrong assumption — that a trailing
 * `-Root <value>` pair binds `param($Root)` — and a mock cannot disagree with
 * the assumption it was written from, so the defect survived a spec named after
 * the very behaviour that was broken. Only a real interpreter distinguishes
 * "bound by PowerShell" from "appended to the command text as another
 * statement", so this spec spawns one instead of describing it.
 *
 * Windows-only: the fallback exists to re-read the Windows registry through
 * PowerShell's Unicode API, which has no meaning elsewhere.
 */

const POWERSHELL_RELATIVE_PATH = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/**
 * A root that exists on every Windows install, so the happy path does not
 * depend on what happens to be registered.
 */
const EXISTING_ROOT = 'HKCU\\Software'
const MISSING_ROOT = 'HKCU\\Software\\DSH-WorkBuddy-Connect-No-Such-Key'

interface RunResult {
  code: number | undefined
  stdout: string
  stderr: string
}

function runCommand(root: string): Promise<RunResult> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return new Promise<RunResult>(resolve => {
    execFile(
      join(systemRoot, POWERSHELL_RELATIVE_PATH),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWERSHELL_QUERY_COMMAND],
      {
        timeout: 3_000,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, [WINDOWS_REGISTRY_QUERY_ROOT_ENV]: root },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : undefined,
          stdout,
          stderr,
        })
      },
    )
  })
}

describe.runIf(process.platform === 'win32')('Windows registry fallback, real interpreter', () => {
  it('reads the root the command text takes from the environment', async () => {
    const { code, stderr, stdout } = await runCommand(EXISTING_ROOT)
    // Exit 3 is the "root unreadable" branch, and it is exactly what an unbound
    // `$Root` produces: `$path` collapses to `Registry::` itself, which passes
    // the `Test-Path` guard and then fails the `Get-Item` probe. The caller
    // turns that into an unfinished search, so the app is never located and the
    // encrypted sign-in is never readable.
    expect(stderr).not.toContain('root unreadable')
    expect(stderr).not.toContain('root absent')
    expect(code).toBe(0)
    const parsed: unknown = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('tells an absent root apart from an unreadable one', async () => {
    // The discriminating case. Both branches report "root unreadable" once the
    // argument is lost, so a spec that only exercised a root that exists could
    // not tell a working binding from the original defect.
    const { code, stderr } = await runCommand(MISSING_ROOT)
    expect(stderr).toContain('root absent')
    expect(code).toBe(2)
  })
})
