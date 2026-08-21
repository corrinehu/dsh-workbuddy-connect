/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported
 * only through `console.error` on failure (see `src/client/index.tsx`).
 * This asymmetry is intentional: the host is the load-bearing half, and
 * a missing heartbeat unambiguously means the host never started.
 *
 * @module dsh-workbuddy-connect/host-heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY_HOST_HEARTBEAT_FILENAME = '.workbuddy-host-heartbeat.json'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** On-disk shape of the heartbeat. */
export interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: 'dsh-workbuddy-connect'
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
}

/** Absolute path of the host heartbeat file. */
export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME)
}

/**
 * Write (or overwrite) the heartbeat after the host bundle registered the
 * provider. A failed write is non-fatal: the host is already running, and
 * the status CLI will simply report "heartbeat missing" rather than failing.
 */
export async function writeHostHeartbeat(): Promise<void> {
  const document: WorkBuddyHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-workbuddy-connect',
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(document), 'utf8')
  } catch {
    // Non-fatal: the CLI status will show "heartbeat missing".
  }
}

/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
export async function clearHostHeartbeat(): Promise<void> {
  try {
    await rm(workbuddyHostHeartbeatPath(), { force: true })
  } catch {
    // Best-effort cleanup; a stale heartbeat is harmless (PID mismatch is detected by the reader).
  }
}

/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
export async function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined> {
  let raw: string
  try {
    raw = await readFile(workbuddyHostHeartbeatPath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkBuddyHostHeartbeat>
    if (
      parsed.version === HEARTBEAT_FORMAT_VERSION
      && parsed.package === 'dsh-workbuddy-connect'
      && typeof parsed.registeredAt === 'number'
      && typeof parsed.pid === 'number'
    ) {
      return {
        version: HEARTBEAT_FORMAT_VERSION,
        package: 'dsh-workbuddy-connect',
        pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
        registeredAt: parsed.registeredAt,
        pid: parsed.pid,
      }
    }
  } catch {
    // Malformed JSON; treat as absent.
  }
  return undefined
}

/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
 *   `Date.UTC`, again comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `processid=${pid}`, 'get', 'CreationDate'],
        { encoding: 'utf8', windowsHide: true },
      )
      const m = out.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/)
      if (m === null) return undefined
      const [, y, mo, d, h, mi, s] = m
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      return Number.isFinite(ms) ? ms : undefined
    }
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    ).trim()
    if (out === '') return undefined
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file)
 * is distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it,
 *    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID
 * to an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
export function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startAtMs = processStartTimeMs(heartbeat.pid)
  if (startAtMs === undefined) return true // platform cannot read start time; PID alive is the best signal
  return startAtMs <= heartbeat.registeredAt
}
