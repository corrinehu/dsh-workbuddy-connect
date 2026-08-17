import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  type WorkBuddyCredential,
} from '../src/auth.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称' },
  })
}

describe('parseWorkBuddyAuth', () => {
  it('reads the desktop nested form with millisecond expiry', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236_868))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.refreshToken).toBe('rt')
    expect(credential?.expiresAtMs).toBe(1_792_128_236_868)
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.enterpriseId).toBe('ent-1')
    expect(credential?.nickname).toBe('昵称')
  })

  it('normalizes second-precision expiry to milliseconds', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236))
    expect(credential?.expiresAtMs).toBe(1_792_128_236_000)
  })

  it('reads the flat panel form', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 0,
      domain: '',
      uid: 'uid-2',
    }))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-2')
    expect(credential?.expiresAtMs).toBe(0)
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: { refreshToken: 'rt' } }))).toBeUndefined()
  })
})

function credentialWith(expiresAtMs: number): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'desktop',
  }
}

describe('WorkBuddyCredentialStore', () => {
  it('serves a fresh desktop credential without refreshing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 3600_000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'new' }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    expect(refreshes).toBe(0)
  })

  it('refreshes an expiring credential, persists the copy, and serves it next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    const own = join(dir, 'own.json')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh', source: 'dsh' })
    const saved = JSON.parse(await readFile(own, 'utf8')) as { version: number, credential: { accessToken: string } }
    expect(saved.version).toBe(1)
    expect(saved.credential.accessToken).toBe('fresh')
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
  })

  it('still returns a not-yet-expired token when refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 60_000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refreshMarginMs: 5 * 60_000,
      refresh: async () => {
        throw new Error('refresh endpoint down')
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('fails loudly when nothing is signed in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'missing.info'),
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('applies a desktop-path repoint on the next read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const first = join(dir, 'workbuddy-a.info')
    const second = join(dir, 'workbuddy-b.info')
    await writeFile(first, nestedDoc(Date.now() + 3600_000))
    await writeFile(second, JSON.stringify({
      auth: { accessToken: 'at-b', refreshToken: 'rt', expiresAt: Date.now() + 7200_000, domain: '' },
      account: { uid: 'uid-b', nickname: 'B' },
    }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: first,
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    store.setDesktopPath(second)
    expect(store.desktopAuthPath()).toBe(second)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-b', nickname: 'B' })
  })
})
