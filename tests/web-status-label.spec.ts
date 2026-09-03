import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { keyHash, WorkBuddyAccountManager } from '../src/auth.ts'
import { workBuddyWebStatus } from '../src/web-status.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const CLEANUP: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(fn => fn()))
})

it('labels each card row with the md5 storage address and the identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-card-label-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  process.env['DSH_HOME'] = root
  const saved = process.env['DSH_HOME']
  CLEANUP.push(async () => {
    if (saved === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = saved
  })
  const manager = new WorkBuddyAccountManager({
    desktopPath: join(root, 'missing.info'),
    refresh: async credential => credential,
  })
  for (const key of ['jmglsi', 'miaoniang']) {
    await manager.storeFor(key).seedOwn({
      accessToken: `at-${key}`, refreshToken: 'rt', expiresAtMs: Date.now() + 3600_000,
      domain: 'www.workbuddy.cn', uid: `uid-${key}`,
      ...(key === 'miaoniang' ? { nickname: '喵娘_认真看置顶' } : {}),
      source: 'dsh',
    })
  }
  const status = await workBuddyWebStatus({
    store: manager,
    client: { fetchCredits: async () => { throw new Error('credits unavailable in this test') } },
    models: (): WorkBuddyModelInfo[] => [],
  })
  if (status.status !== 'signed-in') throw new Error('expected a signed-in status document')
  const byKey = new Map((status.accounts ?? []).map(account => [account.key, account]))
  expect(byKey.get('jmglsi')?.label).toBe(`${keyHash('jmglsi')} · jmglsi`)
  expect(byKey.get('miaoniang')?.label).toBe(`${keyHash('miaoniang')} · 喵娘_认真看置顶`)
  // And the address matches where the snapshot actually lives on disk.
  expect(keyHash('miaoniang')).toMatch(/^[0-9a-f]{8}$/u)
})
