import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
} from '../src/host-heartbeat.ts'

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
    expect(heartbeat!.pluginVersion).toBe('0.1.0')

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
