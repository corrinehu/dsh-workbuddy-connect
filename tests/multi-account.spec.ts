import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ownAccountPath,
  snapshotName,
  workbuddyAccountDir,
  WorkBuddyAccountManager,
  WorkBuddyCredentialStore,
  type WorkBuddyCredential,
} from '../src/auth.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function nestedDoc(expiresAt: number, uid = 'uid-1'): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid, enterpriseId: 'ent-1', nickname: `昵称-${uid}` },
  })
}

function credentialWith(expiresAtMs: number, uid = 'uid-1'): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid,
    source: 'desktop',
  }
}

// Force the manager to use a temp DSH home so own files land under it.
async function withTempHome(run: () => Promise<void>): Promise<void> {
  const saved = process.env['DSH_HOME']
  const home = await mkdtemp(join(tmpdir(), 'wb-acct-'))
  CLEANUP.push(() => rm(home, { recursive: true, force: true }))
  process.env['DSH_HOME'] = home
  try {
    await run()
  } finally {
    if (saved === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = saved
  }
}

describe('WorkBuddyAccountManager', () => {
  it('discovers no accounts when the directory is empty', async () => {
    await withTempHome(async () => {
      const manager = new WorkBuddyAccountManager({ refresh: async c => ({ accessToken: c.accessToken }) })
      expect(await manager.listAccounts()).toEqual([])
      expect(await manager.statuses()).toEqual([])
    })
  })

  it('imports the desktop sign-in under a key without writing the desktop file', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-desk-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const desktop = join(dir, 'workbuddy-desktop.info')
      await writeFile(desktop, nestedDoc(Date.now() + 3600_000, 'uid-alice'))
      const manager = new WorkBuddyAccountManager({
        desktopPath: desktop,
        refresh: async c => ({ accessToken: c.accessToken }),
      })
      const info = await manager.importFromDesktop('alice')
      expect(info.key).toBe('alice')
      expect(await manager.listAccounts()).toEqual(['alice'])
      const status = await manager.statusOf('alice')
      expect(status.state).toBe('signed-in')
      expect(status.nickname).toBe('昵称-uid-alice')
      // Desktop file untouched (still single sign-in, not a copy of own doc).
      expect(await readFile(desktop, 'utf8')).toContain('uid-alice')
    })
  })

  it('refuses to overwrite an existing key unless force is set', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-desk-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const desktop = join(dir, 'workbuddy-desktop.info')
      await writeFile(desktop, nestedDoc(Date.now() + 3600_000, 'uid-x'))
      const manager = new WorkBuddyAccountManager({
        desktopPath: desktop,
        refresh: async c => ({ accessToken: c.accessToken }),
      })
      await manager.importFromDesktop('x')
      await expect(manager.importFromDesktop('x')).rejects.toThrow(/already exists/)
      await expect(manager.importFromDesktop('x', { force: true })).resolves.toMatchObject({ key: 'x' })
    })
  })

  it('resolves a stored account credential and refreshes on demand', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-desk-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const desktop = join(dir, 'workbuddy-desktop.info')
      await writeFile(desktop, nestedDoc(Date.now() - 60_000, 'uid-bob')) // expired -> refreshes
      let refreshes = 0
      const manager = new WorkBuddyAccountManager({
        desktopPath: desktop,
        refresh: async () => {
          refreshes += 1
          return { accessToken: 'fresh-bob', refreshToken: 'rt2', expiresInSec: 3600 }
        },
      })
      await manager.importFromDesktop('bob')
      const resolved = await manager.resolve('bob')
      expect(resolved.accessToken).toBe('fresh-bob')
      expect(resolved.source).toBe('dsh')
      expect(refreshes).toBe(1)
      // Persisted copy exists and parses.
      const saved = JSON.parse(await readFile(ownAccountPath('bob'), 'utf8')) as { version: number, credential: { accessToken: string } }
      expect(saved.version).toBe(1)
      expect(saved.credential.accessToken).toBe('fresh-bob')
    })
  })

  it('rejects resolving an unknown account', async () => {
    await withTempHome(async () => {
      const manager = new WorkBuddyAccountManager({ refresh: async c => ({ accessToken: c.accessToken }) })
      await expect(manager.resolve('ghost')).rejects.toThrow(/no such account/)
    })
  })

  it('removes an account copy without touching the desktop file', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-desk-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const desktop = join(dir, 'workbuddy-desktop.info')
      await writeFile(desktop, nestedDoc(Date.now() + 3600_000, 'uid-carol'))
      const manager = new WorkBuddyAccountManager({
        desktopPath: desktop,
        refresh: async c => ({ accessToken: c.accessToken }),
      })
      await manager.importFromDesktop('carol')
      expect(await manager.listAccounts()).toEqual(['carol'])
      await manager.remove('carol')
      expect(await manager.listAccounts()).toEqual([])
      expect(await readFile(desktop, 'utf8')).toContain('uid-carol')
    })
  })

  it('stores accounts under an md5 file name and keeps the key inside', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-name-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const manager = new WorkBuddyAccountManager({
        desktopPath: join(dir, 'missing.info'),
        refresh: async credential => credential,
      })
      // Keys that are not safe file names (Chinese, slashes, dots) must all
      // land as eight hex digits — no escapes, no subdirectories.
      for (const key of ['中文账号', 'a/b', '..', '狗狗朋友圈看置顶', 'with space']) {
        manager.storeFor(key).seedOwn(credentialWith(Date.now() + 3600_000, `uid-${key}`))
      }
      await Promise.all(['中文账号', 'a/b', '..', '狗狗朋友圈看置顶', 'with space']
        .map(key => manager.storeFor(key).seedOwn(credentialWith(Date.now() + 3600_000, `uid-${key}`))))
      const names = (await readdir(workbuddyAccountDir())).filter(name => name.endsWith('.json'))
      expect(names.every(name => /^[0-9a-f]{8}\.json$/u.test(name))).toBe(true)
      expect(new Set(names).size).toBe(5)
      // Discovery reads the key back out of each document.
      expect((await manager.listAccounts()).sort()).toEqual(['..', 'a/b', 'with space', '中文账号', '狗狗朋友圈看置顶'])
    })
  })

  it('still discovers snapshots written before the md5 naming', async () => {
    await withTempHome(async () => {
      const dir = workbuddyAccountDir()
      await mkdir(dir, { recursive: true })
      // Legacy shape: no `key` field, file named after the (encoded) key.
      await writeFile(join(dir, `${encodeURIComponent('中文账号')}.json`), JSON.stringify({
        version: 1,
        credential: credentialWith(Date.now() + 3600_000, 'uid-legacy'),
      }))
      const manager = new WorkBuddyAccountManager({ refresh: async c => c })
      expect(await manager.listAccounts()).toEqual(['中文账号'])
      const credential = await manager.resolve('中文账号')
      expect(credential.uid).toBe('uid-legacy')
      // Migration: the legacy file is gone, replaced by the md5-named copy
      // that carries the key inside.
      const names = (await readdir(workbuddyAccountDir())).filter(name => name.endsWith('.json'))
      expect(names).toEqual([snapshotName('中文账号')])
      const migrated = JSON.parse(await readFile(ownAccountPath('中文账号'), 'utf8')) as { key: string }
      expect(migrated.key).toBe('中文账号')
    })
  })

  it('seedOwn writes a credential verbatim without upstream refresh', async () => {
    await withTempHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-seed-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const store = new WorkBuddyCredentialStore({
        // Point the desktop probe at an absent file so the real desktop
        // sign-in (if any) cannot out-rank the seeded copy in this test.
        desktopPath: join(dir, 'missing.info'),
        ownPath: ownAccountPath('seed'),
        refresh: async () => { throw new Error('should not refresh') },
      })
      await store.seedOwn(credentialWith(Date.now() + 3600_000, 'uid-seed'))
      const status = await store.status()
      expect(status.state).toBe('signed-in')
      expect(status.source).toBe('dsh')
      expect(status.nickname).toBeUndefined()
    })
  })
})
