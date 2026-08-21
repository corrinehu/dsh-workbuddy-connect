import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
} from '../src/host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('host heartbeat', () => {
  it('writes, reads, and clears a heartbeat under $DSH_HOME', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-'))
    vi.stubEnv('DSH_HOME', root)

    // Before write: absent.
    expect(await readHostHeartbeat()).toBeUndefined()

    await writeHostHeartbeat()

    // After write: present and well-formed.
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.package).toBe('dsh-workbuddy-connect')
    expect(heartbeat!.pid).toBe(process.pid)
    expect(typeof heartbeat!.registeredAt).toBe('number')
    expect(heartbeat!.pluginVersion).toBe(WORKBUDDY_CONNECT_VERSION)

    // The file lives at the expected path.
    expect(workbuddyHostHeartbeatPath()).toBe(join(root, WORKBUDDY_HOST_HEARTBEAT_FILENAME))

    // Live PID is detectable.
    expect(isHeartbeatProcessAlive(heartbeat!)).toBe(true)

    // A fake PID that cannot exist is detected as dead.
    const fakeHeartbeat = { ...heartbeat!, pid: 999_999 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Clear removes the file.
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('detects a recycled PID as dead (registeredAt after this process started)', async () => {
    // The current process started at some point in the past. If a stale
    // heartbeat claims a `registeredAt` that is *older* than this process's
    // own start time, the PID cannot be the original host — it has been
    // recycled by an unrelated process. Even though `kill(pid, 0)` says the
    // PID is alive, the age check must report dead.
    const startAtMs = processStartTimeMs(process.pid)
    expect(startAtMs).toBeDefined()

    // A heartbeat registered *before* this process began (the recycled-PID case).
    const recycled = {
      version: 1 as const,
      package: 'dsh-workbuddy-connect' as const,
      pluginVersion: '0.0.0-test',
      registeredAt: (startAtMs as number) - 60_000, // 1 min before this process started
      pid: process.pid,
    }
    expect(isHeartbeatProcessAlive(recycled)).toBe(false)

    // A heartbeat registered *after* this process started (a genuine host on
    // this very PID) is alive.
    const genuine = { ...recycled, registeredAt: Date.now() }
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)
  })

  it('treats a malformed heartbeat file as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-malformed-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(workbuddyHostHeartbeatPath(), '{ not json', 'utf8')
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a heartbeat with the wrong format version', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-wrongver-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      workbuddyHostHeartbeatPath(),
      JSON.stringify({ version: 99, package: 'dsh-workbuddy-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })
})
