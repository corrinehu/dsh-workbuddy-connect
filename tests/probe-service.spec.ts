import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WorkBuddyProbeStore } from '../src/probe-store.ts'
import { WorkBuddyProbeService } from '../src/probe-service.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

describe('manual probe consent and deduplication', () => {
  const paths: string[] = []
  afterEach(() => { paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
  function setup(consent = false) {
    const path = mkdtempSync(join(tmpdir(), 'wb-probe-service-'))
    paths.push(path)
    const catalog = new WorkBuddyCatalog()
    const send = vi.fn(async () => ({ status: 200, streamed: true }))
    const service = new WorkBuddyProbeService({
      catalog,
      store: new WorkBuddyProbeStore({ path: join(path, 'state.json'), pluginVersion: 'test' }),
      credentials: { current: async () => ({}) } as unknown as WorkBuddyCredentialStore,
      client: {} as WorkBuddyUpstreamClient,
      consent: () => consent,
      account: () => 'uid-1:ent-1',
      send: () => send,
    })
    return { service, send }
  }
  it('keeps automatic requests gated but permits one confirmed model without changing consent', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.2')).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
    expect((await service.probe('glm-5.2', true)).state).toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
    expect((await service.probe('auto')).state).toBe('unavailable')
  })
  it('does not spend twice when two conversations submit the same model', async () => {
    const { service, send } = setup()
    const results = await Promise.all([service.probe('glm-5.2', true), service.probe('glm-5.2', true)])
    expect(results.map(result => result.state)).toEqual(['ok', 'ok'])
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('does not make a new account join the previous account\'s pending probe', async () => {
    const path = mkdtempSync(join(tmpdir(), 'wb-probe-service-'))
    paths.push(path)
    const catalog = new WorkBuddyCatalog()
    let account = 'uid-a:ent-1'
    let release: (() => void) | undefined
    let calls = 0
    const send = vi.fn(async () => {
      calls += 1
      if (calls === 1) await new Promise<void>(resolve => { release = resolve })
      return { status: 200, streamed: true }
    })
    const service = new WorkBuddyProbeService({
      catalog,
      store: new WorkBuddyProbeStore({ path: join(path, 'state.json'), pluginVersion: 'test' }),
      credentials: { current: async () => ({}) } as unknown as WorkBuddyCredentialStore,
      client: {} as WorkBuddyUpstreamClient,
      consent: () => false,
      account: () => account,
      send: () => send,
    })

    const probeA = service.probe('glm-5.2', true)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    account = 'uid-b:ent-1'
    const probeB = service.probe('glm-5.2', true)
    release?.()

    await expect(probeA).resolves.toMatchObject({ state: 'unavailable', reason: 'account changed during detection' })
    await expect(probeB).resolves.toMatchObject({ state: 'ok' })
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('runs a fresh probe on each sequential manual confirmation', async () => {
    const { service, send } = setup()
    await service.probe('glm-5.2', true)
    const result = await service.probe('glm-5.2', true)
    expect(result).toMatchObject({ state: 'ok', requests: 2 })
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('still reuses historical results for authorized automatic requests', async () => {
    const { service, send } = setup(true)
    await service.probe('glm-5.2', true)
    expect(await service.probe('glm-5.2')).toMatchObject({ state: 'ok', requests: 0 })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('rejects declared and unknown models before sending', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.3-flash', true)).state).toBe('unavailable')
    expect((await service.probe('not-in-catalog', true)).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
  })
})
