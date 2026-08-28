import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  WORKBUDDY_AUTH_FILE_ENV,
  type WorkBuddyCredential,
} from '../src/auth.ts'

// node:os's ESM namespace rejects vi.spyOn (non-configurable), so homedir is
// mocked at the module level; unset state falls through to the real one.
const fakeOs = vi.hoisted(() => ({
  home: undefined as string | undefined,
  release: undefined as string | undefined,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeOs.home ?? actual.homedir(),
    release: () => fakeOs.release ?? actual.release(),
  }
})

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

describe('Windows default desktop path probing', () => {
  function windowsDoc(token: string): string {
    return JSON.stringify({
      auth: { accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-w', nickname: 'Win 用户' },
    })
  }

  /** Fake a win32 home; probes are mocked in, dirs under a temp root. */
  async function fakeWindowsHome(): Promise<{ home: string, local: string, roaming: string }> {
    const home = await mkdtemp(join(tmpdir(), 'wb-win-'))
    CLEANUP.push(() => rm(home, { recursive: true, force: true }))
    const local = join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    const roaming = join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    return { home, local, roaming }
  }

  /** Run the case body as win32 with the given home; restore on exit. */
  async function asWindows<T>(home: string, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    delete process.env[WORKBUDDY_AUTH_FILE_ENV]
    fakeOs.home = home
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
      fakeOs.home = undefined
      if (savedEnv === undefined) delete process.env[WORKBUDDY_AUTH_FILE_ENV]
      else process.env[WORKBUDDY_AUTH_FILE_ENV] = savedEnv
    }
  }

  it('lists Local before Roaming on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const candidates = defaultDesktopAuthCandidates()
      expect(candidates).toEqual([local, roaming])
    })
  })

  it('reads the Local AppData file when only it exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('falls back to Roaming when only it exists (older desktop builds)', async () => {
    const { home, roaming } = await fakeWindowsHome()
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-roaming', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('prefers Local when both exist', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local' })
    })
  })

  it('reports signed-out and lists both candidates when neither exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.status()).resolves.toMatchObject({ state: 'signed-out' })
      await expect(store.desktopFilePresent()).resolves.toBe(false)
      await expect(store.resolve()).rejects.toThrow(new RegExp(local.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)))
      await expect(store.resolve()).rejects.toThrow(/AppData.*Local[\s\S]*AppData.*Roaming/)
    })
  })

  it('uses an explicit desktopPath verbatim without probing on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    const explicit = join(home, 'explicit.info')
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(explicit, windowsDoc('at-explicit'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        desktopPath: explicit,
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-explicit' })
      expect(store.desktopAuthPath()).toBe(explicit)
      void roaming
    })
  })
})

describe('WSL default desktop path probing', () => {
  const AUTH_TAIL = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

  async function asWsl<T>(options: {
    home: string
    env?: Partial<Record<'APPDATA' | 'LOCALAPPDATA' | 'USERPROFILE', string>>
  }, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = Object.fromEntries(
      ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'WSL_DISTRO_NAME', 'WSL_INTEROP']
        .map(name => [name, process.env[name]]),
    )
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    fakeOs.home = options.home
    fakeOs.release = '6.6.87.2-microsoft-standard-WSL2'
    delete process.env['APPDATA']
    delete process.env['LOCALAPPDATA']
    delete process.env['USERPROFILE']
    delete process.env['WSL_DISTRO_NAME']
    delete process.env['WSL_INTEROP']
    Object.assign(process.env, options.env)
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
      fakeOs.home = undefined
      fakeOs.release = undefined
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  it('probes the matching mounted Windows profile before the Linux path', async () => {
    await asWsl({ home: '/home/alice' }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/mnt/c/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/c/Users/alice/AppData/Roaming', AUTH_TAIL),
        join('/home/alice/.config', AUTH_TAIL),
      ])
    })
  })

  it('uses translated WSL environment paths when the Windows user differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-wsl-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const windowsProfile = join(root, 'Users', 'windows-alice')
    const local = join(windowsProfile, 'AppData', 'Local', AUTH_TAIL)
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, nestedDoc(Date.now() + 3600_000))

    await asWsl({ home: '/home/linux-alice', env: { USERPROFILE: windowsProfile } }, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(root, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      expect(store.desktopAuthPath()).toBe(local)
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    })
  })

  it('converts Windows-form AppData environment paths to WSL mount paths', async () => {
    await asWsl({
      home: '/home/alice',
      env: {
        LOCALAPPDATA: String.raw`D:\Users\alice\AppData\Local`,
        APPDATA: String.raw`D:\Users\alice\AppData\Roaming`,
      },
    }, async () => {
      expect(defaultDesktopAuthCandidates().slice(0, 2)).toEqual([
        join('/mnt/d/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/d/Users/alice/AppData/Roaming', AUTH_TAIL),
      ])
    })
  })
})
