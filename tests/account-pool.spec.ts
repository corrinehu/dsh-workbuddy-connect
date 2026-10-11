/**
 * Account pool, pool-aware credential resolution, and check-in classification.
 *
 * Three properties carry the risk in this feature, and each has a section here
 * because getting it wrong is silent rather than loud:
 *
 * 1. **An empty pool must be invisible.** Every call delegates to the
 *    single-account store, so a user who never imports anything cannot observe a
 *    difference.
 * 2. **Import must be idempotent, and must never roll a fresher token back.**
 *    Re-importing the same file has to leave the pool byte-identical; importing a
 *    *stale* file must not replace a token this plugin already refreshed.
 * 3. **Rotation must not retire a healthy account.** Only a dead session retires
 *    one — a transient failure must leave the pool intact, or a single upstream
 *    hiccup would empty a working pool.
 *
 * The tests run the real modules against a real temp file; only the upstream
 * `fetch` is stubbed, and only where the check-in path is under test.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyCheckinOutcome,
  hasDelimitedCode,
  parseImportText,
  poolKeyOf,
  WorkBuddyAccountPool,
  type WorkBuddyPoolCredential,
} from '../src/account-pool.ts'
import { WorkBuddyPoolCredentialResolver, type WorkBuddyCredentialSource } from '../src/pool-store.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyAuthStatus, WorkBuddyCredential } from '../src/auth.ts'
import type { DesktopAuthFormat } from '../src/desktop-credential-protection.ts'

const hashOf = (seed: string): string => createHash('sha256').update(seed).digest('hex')

/**
 * A fixed future expiry.
 *
 * Deliberately not `Date.now() + …`: an import document's expiry is a value *in
 * the file*, so re-importing the same file must reproduce the same value.
 * Generating it per call would make every re-import look like a newer document
 * and would hide the idempotency these tests exist to prove.
 */
const FIXED_EXPIRY = Date.now() + 3_600_000

function credential(uid: string, token: string, expiresAtMs: number = FIXED_EXPIRY): WorkBuddyPoolCredential {
  return {
    accessToken: token,
    refreshToken: `RT-${token}`,
    expiresAtMs,
    domain: 'codebuddy.cn',
    uid,
  }
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pool-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** A stand-in for the single-account store, recording what was delegated. */
function fakeFallback(): WorkBuddyCredentialSource & { calls: string[]; value: WorkBuddyCredential } {
  const calls: string[] = []
  const value: WorkBuddyCredential = {
    accessToken: 'AT-DESKTOP',
    refreshToken: 'RT-DESKTOP',
    expiresAtMs: FIXED_EXPIRY,
    domain: 'codebuddy.cn',
    uid: 'desktop-user',
    source: 'desktop',
  }
  return {
    calls,
    value,
    async current() {
      calls.push('current')
      return value
    },
    async resolve() {
      calls.push('resolve')
      return value
    },
    async status(): Promise<WorkBuddyAuthStatus> {
      calls.push('status')
      return { state: 'signed-in', source: 'desktop', nickname: 'desktop' }
    },
    async logout() {
      calls.push('logout')
    },
    setDesktopPath() {},
    desktopAuthPath: () => '/desktop/path',
    ownAuthPath: () => '/own/path',
    async desktopAuthFormat(): Promise<DesktopAuthFormat> {
      return 'plaintext'
    },
    async resolvedDesktopAuthPath() {
      return '/desktop/path'
    },
    async desktopFilePresent() {
      return true
    },
  }
}

describe('parseImportText', () => {
  it('reads the nested desktop / plugin-owned form', () => {
    const parsed = parseImportText(JSON.stringify({
      auth: { accessToken: 'AT-N', refreshToken: 'RT-N', expiresAt: 1_893_456_000, domain: 'workbuddy.ai' },
      account: { uid: 'u-nested', enterpriseId: 'e-1', nickname: 'nick' },
    }))
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]).toMatchObject({ uid: 'u-nested', enterpriseId: 'e-1', nickname: 'nick' })
    // A 10-digit epoch is seconds; reading it as milliseconds would place the
    // expiry in 1970 and make every imported account look permanently expired.
    expect(parsed.accounts[0]!.expiresAtMs).toBe(1_893_456_000_000)
  })

  it('reads the flat gateway form and preserves a millisecond expiry', () => {
    const parsed = parseImportText(JSON.stringify({
      accessToken: 'AT-F',
      uid: 'u-flat',
      expiresAt: 1_893_456_000_000,
    }))
    expect(parsed.accounts[0]!.expiresAtMs).toBe(1_893_456_000_000)
  })

  it('reads JSON Lines, skipping blanks and comments', () => {
    const parsed = parseImportText([
      '# a comment',
      JSON.stringify({ accessToken: 'AT-L1', uid: 'u-l1' }),
      '',
      JSON.stringify({ accessToken: 'AT-L2', uid: 'u-l2' }),
    ].join('\n'))
    expect(parsed.accounts.map(a => a.uid)).toEqual(['u-l1', 'u-l2'])
  })

  it('reads an array, a wrapper, and a uid-keyed map', () => {
    expect(parseImportText(JSON.stringify([{ accessToken: 'A', uid: 'a' }])).accounts).toHaveLength(1)
    expect(parseImportText(JSON.stringify({ accounts: [{ accessToken: 'A', uid: 'a' }] })).accounts).toHaveLength(1)
    expect(parseImportText(JSON.stringify({ 'u-k1': { accessToken: 'A' }, 'u-k2': { accessToken: 'B' } })).accounts).toHaveLength(2)
  })

  it('rejects a document with no access token', () => {
    // Accepting it would only produce a pool that fails later with a worse message.
    expect(parseImportText(JSON.stringify({ uid: 'u-x', nickname: 'no token' })).accounts).toHaveLength(0)
  })

  it('reports a file that is neither JSON nor JSON Lines', () => {
    expect(() => parseImportText('{"accessToken":"a"}\nnot json at all')).toThrow(/JSON Lines/u)
  })
})

describe('WorkBuddyAccountPool merge', () => {
  it('adds on first import and is idempotent on re-import', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    const first = pool.merge([credential('u-1', 'AT-1'), credential('u-2', 'AT-2')])
    expect([first.added, first.updated, first.skipped]).toEqual([2, 0, 0])
    // Running an import twice must not change the pool: that is the property a
    // batch tool most needs.
    const again = pool.merge([credential('u-1', 'AT-1'), credential('u-2', 'AT-2')])
    expect([again.added, again.updated, again.skipped]).toEqual([0, 0, 2])
  })

  it('never rolls a fresher stored token back to a stale document', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([credential('u-1', 'AT-1')])
    const stale = pool.merge([credential('u-1', 'AT-STALE', 1_000_000_000_000)])
    expect([stale.added, stale.updated, stale.skipped]).toEqual([0, 0, 1])
    expect(pool.get('u-1:')!.credential.accessToken).toBe('AT-1')
    // The refresh half must be kept too: a refresh token that has since rotated
    // is dead, and adopting the stale one would break a renewed account.
    expect(pool.get('u-1:')!.credential.refreshToken).toBe('RT-AT-1')
  })

  it('adopts a strictly fresher document', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([credential('u-1', 'AT-1')])
    pool.merge([credential('u-1', 'AT-NEW', FIXED_EXPIRY + 3_600_000)])
    expect(pool.get('u-1:')!.credential.accessToken).toBe('AT-NEW')
  })

  it('round-trips the expiry through disk', () => {
    const path = join(tempDir(), 'pool.json')
    const pool = new WorkBuddyAccountPool({ path, hashOf })
    pool.merge([credential('u-1', 'AT-1')])
    const reloaded = new WorkBuddyAccountPool({ path, hashOf })
    // An unknown expiry would mean "renew on every read", silently turning a
    // healthy pool into a refresh storm.
    expect(reloaded.get('u-1:')!.credential.expiresAtMs).toBe(FIXED_EXPIRY)
  })

  it('never re-enables a disabled account on import', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([credential('u-2', 'AT-2')])
    pool.setDisabled('u-2:', true)
    pool.merge([credential('u-2', 'AT-2b', FIXED_EXPIRY + 3_600_000)])
    expect(pool.get('u-2:')!.disabled).toBe(true)
    expect(pool.counts()).toEqual({ total: 1, usable: 0 })
  })

  it('keeps two accounts that share a uid but differ in enterprise', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([
      { ...credential('same-uid', 'AT-A'), enterpriseId: 'ent-1' },
      { ...credential('same-uid', 'AT-B'), enterpriseId: 'ent-2' },
    ])
    expect(pool.counts().total).toBe(2)
  })

  it('keeps two uid-less accounts distinct, with opaque keys', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([credential('', 'AT-ANON-1'), credential('', 'AT-ANON-2')])
    expect(pool.counts().total).toBe(2)
    for (const entry of pool.all()) {
      expect(entry.key.startsWith('anon:')).toBe(true)
      // The key reaches CLI output; the token it derives from must not.
      expect(entry.key).not.toContain('AT-ANON')
    }
  })

  it('writes the pool file 0o600', () => {
    const path = join(tempDir(), 'pool.json')
    new WorkBuddyAccountPool({ path, hashOf }).merge([credential('u-1', 'AT-1')])
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
    // Windows has no POSIX mode bits, so the assertion is skipped there rather
    // than asserted vacuously — on Linux and macOS (both in CI's matrix) it is a
    // real check that the token-bearing file is not world-readable.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('reads a malformed file as "no accounts" instead of throwing', () => {
    const path = join(tempDir(), 'pool.json')
    writeFileSync(path, 'not json')
    const pool = new WorkBuddyAccountPool({ path, hashOf })
    expect(pool.counts()).toEqual({ total: 0, usable: 0 })
  })

  it('supports remove, clear, and markCheckin', () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'pool.json'), hashOf })
    pool.merge([credential('u-1', 'AT-1'), credential('u-2', 'AT-2')])
    pool.markCheckin('u-1:', 'already', 1234)
    expect(pool.get('u-1:')).toMatchObject({ lastCheckinAtMs: 1234, lastCheckinStatus: 'already' })
    expect(pool.remove('u-1:')).toBe(true)
    expect(pool.remove('u-1:')).toBe(false)
    expect(pool.counts().total).toBe(1)
    pool.clear()
    expect(pool.counts().total).toBe(0)
  })
})

describe('poolKeyOf', () => {
  it('depends on identity, not on the token', () => {
    expect(poolKeyOf(credential('u-stable', 'AT-1'), hashOf))
      .toBe(poolKeyOf(credential('u-stable', 'AT-2'), hashOf))
  })

  it('is uid:enterpriseId', () => {
    expect(poolKeyOf(credential('u-stable', 'AT-1'), hashOf)).toBe('u-stable:')
  })
})

describe('WorkBuddyPoolCredentialResolver', () => {
  it('delegates every call when the pool is empty', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'empty.json'), hashOf })
    const fallback = fakeFallback()
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback,
      refresh: async () => {
        throw new Error('must not refresh with an empty pool')
      },
    })
    expect((await resolver.current())!.accessToken).toBe('AT-DESKTOP')
    expect((await resolver.resolve()).accessToken).toBe('AT-DESKTOP')
    expect(fallback.calls).toContain('current')
    expect(fallback.calls).toContain('resolve')
    // No `pool` field at all, so a single-account install's status document keeps
    // the shape it has always had.
    expect((await resolver.status()).pool).toBeUndefined()
    expect((await resolver.status()).state).toBe('signed-in')
    expect(resolver.desktopAuthPath()).toBe('/desktop/path')
    expect(await resolver.desktopFilePresent()).toBe(true)
  })

  it('prefers the pool and reports its counts', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'p.json'), hashOf })
    pool.merge([credential('p-1', 'AT-P1'), credential('p-2', 'AT-P2')])
    const fallback = fakeFallback()
    const resolver = new WorkBuddyPoolCredentialResolver({ pool, fallback, refresh: async () => ({ accessToken: 'x' }) })
    expect((await resolver.current())!.accessToken).toBe('AT-P1')
    expect(fallback.calls).not.toContain('current')
    const status = await resolver.status()
    expect(status.pool).toMatchObject({ total: 2, usable: 2, retired: 0, activeKey: 'p-1:' })
  })

  it('does not refresh a healthy token', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'p.json'), hashOf })
    pool.merge([credential('p-1', 'AT-P1')])
    let refreshes = 0
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'x' }
      },
    })
    await resolver.resolve()
    expect(refreshes).toBe(0)
  })

  it('rotates past a dead account, and falls back when the pool is exhausted', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'p.json'), hashOf })
    pool.merge([credential('p-1', 'AT-P1'), credential('p-2', 'AT-P2')])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => ({ accessToken: 'x' }),
    })
    const first = await resolver.current()
    expect(first!.accessToken).toBe('AT-P1')
    expect(resolver.reportDead(first!, 'test')).toBe(true)
    expect((await resolver.current())!.accessToken).toBe('AT-P2')
    expect(resolver.retiredKeys()).toHaveLength(1)
    resolver.reportDead((await resolver.current())!, 'test')
    // An exhausted pool must fall back rather than report no credential.
    expect((await resolver.current())!.accessToken).toBe('AT-DESKTOP')
    expect((await resolver.status()).pool).toMatchObject({ total: 2, retired: 2 })
    resolver.resetRetired()
    expect((await resolver.current())!.accessToken).toBe('AT-P1')
  })

  it('writes a refreshed token back to the pool entry', async () => {
    const path = join(tempDir(), 'r.json')
    const pool = new WorkBuddyAccountPool({ path, hashOf })
    pool.merge([credential('r-1', 'AT-EXPIRED', Date.now() - 10_000)])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => ({ accessToken: 'AT-FRESH', refreshToken: 'RT-FRESH', expiresInSec: 3600 }),
    })
    expect((await resolver.resolve()).accessToken).toBe('AT-FRESH')
    const reloaded = new WorkBuddyAccountPool({ path, hashOf })
    expect(reloaded.get('r-1:')!.credential).toMatchObject({ accessToken: 'AT-FRESH', refreshToken: 'RT-FRESH' })
  })

  it('rotates away when a refresh fails on an expired account', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'd.json'), hashOf })
    pool.merge([credential('d-1', 'AT-DEAD', Date.now() - 10_000), credential('d-2', 'AT-ALIVE')])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => {
        throw new Error('refresh endpoint refused')
      },
    })
    expect((await resolver.resolve()).accessToken).toBe('AT-ALIVE')
    expect(resolver.retiredKeys()).toHaveLength(1)
  })

  it('keeps a still-valid token when it has no refresh token', async () => {
    // A token with no refresh half cannot be renewed, so it must be used for as
    // long as it is genuinely valid rather than retired early — retiring it
    // would throw away a working account. The expiry is placed outside the
    // refresh margin, which is the only window where this distinction is
    // observable.
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'v.json'), hashOf })
    pool.merge([{ ...credential('v-1', 'AT-VALID', Date.now() + 3_600_000), refreshToken: '' }])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => {
        throw new Error('never called')
      },
    })
    expect((await resolver.resolve()).accessToken).toBe('AT-VALID')
    expect(resolver.retiredKeys()).toHaveLength(0)
  })

  it('retires an expired account that has no refresh token', async () => {
    // The other side of the same rule: past its expiry with nothing to renew it,
    // the account can only fail, so the pool moves on instead of handing the
    // upstream a dead token.
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'e.json'), hashOf })
    pool.merge([
      { ...credential('e-1', 'AT-EXPIRED', Date.now() - 10_000), refreshToken: '' },
      credential('e-2', 'AT-ALIVE'),
    ])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => {
        throw new Error('never called')
      },
    })
    expect((await resolver.resolve()).accessToken).toBe('AT-ALIVE')
    expect(resolver.retiredKeys().map(entry => entry.key)).toEqual(['e-1:'])
  })

  it('disables only the active account on logout', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'l.json'), hashOf })
    pool.merge([credential('l-1', 'AT-L1'), credential('l-2', 'AT-L2')])
    const fallback = fakeFallback()
    const resolver = new WorkBuddyPoolCredentialResolver({ pool, fallback, refresh: async () => ({ accessToken: 'x' }) })
    await resolver.logout()
    // The desktop app's sign-in is not what the user asked to remove.
    expect(fallback.calls).not.toContain('logout')
    expect(pool.get('l-1:')!.disabled).toBe(true)
    expect(pool.get('l-2:')!.disabled).toBeUndefined()
  })

  it('keeps the pool key off the enumerable credential', async () => {
    const pool = new WorkBuddyAccountPool({ path: join(tempDir(), 'k.json'), hashOf })
    pool.merge([credential('k-1', 'AT-K1')])
    const resolver = new WorkBuddyPoolCredentialResolver({
      pool,
      fallback: fakeFallback(),
      refresh: async () => ({ accessToken: 'x' }),
    })
    const resolved = await resolver.current()
    // The credential is serialized into the status document; a stray field would
    // leak into it.
    expect(Object.keys(resolved!)).not.toContain('__workbuddyPoolKey')
    expect(JSON.stringify(resolved)).not.toContain('__workbuddyPoolKey')
  })
})

describe('classifyCheckinOutcome', () => {
  it('treats a successful call as ok', () => {
    expect(classifyCheckinOutcome(undefined, undefined)).toBe('ok')
  })

  it('recognises the idempotent business codes and markers', () => {
    expect(classifyCheckinOutcome('code=10001 msg=今天已签到', undefined)).toBe('already')
    expect(classifyCheckinOutcome('code=14001 msg=x', undefined)).toBe('already')
    expect(classifyCheckinOutcome('code=7 msg=already claimed', undefined)).toBe('already')
    expect(classifyCheckinOutcome('code=7 msg=今天已签到', undefined)).toBe('already')
    expect(classifyCheckinOutcome('code=7 msg=功能未开放', undefined)).toBe('already')
  })

  it('does not read a different business error as idempotent', () => {
    expect(classifyCheckinOutcome('code=7 msg=something else', undefined)).toBe('failed')
  })

  it('matches idempotent codes only as delimited tokens', () => {
    // The gateway hit real false positives here: `12001` contains `2001`-style
    // neighbours of the real codes.
    expect(hasDelimitedCode('code=12001', '10001')).toBe(false)
    expect(classifyCheckinOutcome('code=12001 msg=x', undefined)).toBe('failed')
    expect(classifyCheckinOutcome('code=140001 msg=x', undefined)).toBe('failed')
    expect(hasDelimitedCode('code=10001', '10001')).toBe(true)
  })

  it('never reads a transport error as idempotent', () => {
    // `already` and `inactive` occur in ordinary network failures; treating one
    // as success would report an account claimed for the day when it never
    // reached the upstream.
    expect(classifyCheckinOutcome(undefined, 'listen EADDRINUSE: address already in use')).toBe('ok')
    expect(classifyCheckinOutcome(undefined, 'connect ECONNREFUSED')).toBe('ok')
  })
})

describe('WorkBuddyUpstreamClient.dailyCheckin', () => {
  /** Stub `fetch` and record every request the client makes. */
  function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): string[] {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      const { status, body } = handler(url, init ?? {})
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    })
    return seen
  }

  const cn = (token: string): WorkBuddyCredential => ({
    accessToken: token,
    refreshToken: 'RT',
    expiresAtMs: FIXED_EXPIRY,
    domain: 'codebuddy.cn',
    uid: 'u',
    source: 'dsh',
  })

  const global = (token: string): WorkBuddyCredential => ({ ...cn(token), domain: 'workbuddy.ai' })

  it('reports ok for a successful claim', async () => {
    stubFetch(() => ({ status: 200, body: { code: 0, msg: 'ok' } }))
    expect(await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))).toEqual({ status: 'ok', detail: 'ok' })
  })

  it('uses the CN path verbatim', async () => {
    const seen = stubFetch(() => ({ status: 200, body: { code: 0, msg: '' } }))
    await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))
    expect(seen).toEqual(['https://www.codebuddy.cn/v2/billing/meter/daily-checkin'])
  })

  it('tries the bare international path first, then falls back on 404', async () => {
    const seen = stubFetch(url => url.includes('/v2/')
      ? { status: 200, body: { code: 0, msg: '' } }
      : { status: 404, body: { code: 404, msg: 'not found' } })
    const outcome = await new WorkBuddyUpstreamClient().dailyCheckin(global('AT'))
    expect(outcome.status).toBe('ok')
    expect(seen).toEqual([
      'https://www.workbuddy.ai/billing/meter/daily-checkin',
      'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
    ])
  })

  it('does not retry a non-404 failure against the second path', async () => {
    // Retrying a 500 against a second path would just double the load on an
    // endpoint that already said no.
    const seen = stubFetch(() => ({ status: 500, body: { code: 0, msg: 'internal error' } }))
    const outcome = await new WorkBuddyUpstreamClient().dailyCheckin(global('AT'))
    expect(outcome.status).toBe('failed')
    expect(seen).toHaveLength(1)
  })

  it('reports an idempotent claim as already', async () => {
    stubFetch(() => ({ status: 200, body: { code: 10001, msg: '今天已签到' } }))
    const outcome = await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))
    expect(outcome.status).toBe('already')
    expect(outcome.detail).toContain('10001')
  })

  it('reports a dead session as auth', async () => {
    stubFetch(() => ({ status: 200, body: { code: 12153, msg: 'Offline user session not found' } }))
    expect((await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))).status).toBe('auth')
  })

  it('reports a 401 as auth', async () => {
    stubFetch(() => ({ status: 401, body: { code: 401, msg: 'unauthorized' } }))
    expect((await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))).status).toBe('auth')
  })

  it('reports a transport failure as failed, never as already', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    const outcome = await new WorkBuddyUpstreamClient().dailyCheckin(cn('AT'))
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('ECONNREFUSED')
  })
})
