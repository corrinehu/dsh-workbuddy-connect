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
 * Whether the heartbeat's PID is still alive. A stale heartbeat (process
 * crashed without clearing the file) is distinguished from a live host by
 * checking `process.kill(pid, 0)` — signal 0 tests existence without
 * sending a signal.
 */
export function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
    return true
  } catch {
    return false
  }
}
