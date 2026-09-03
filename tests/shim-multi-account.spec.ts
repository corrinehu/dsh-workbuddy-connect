import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownAccountPath, WorkBuddyAccountManager, type WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface MultiHarness {
  shim: WorkBuddyShim
  seenCredentials: WorkBuddyCredential[]
}

/**
 * Start a manager-backed shim with two pre-seeded accounts. The accounts are
 * written directly in the owned format, the way a refresh or an import leaves
 * them on disk.
 */
async function startMultiShim(): Promise<MultiHarness> {
  const home = await mkdtemp(join(tmpdir(), 'wb-shim-multi-'))
  CLEANUP.push(() => rm(home, { recursive: true, force: true }))
  const savedDshHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  CLEANUP.push(async () => {
    if (savedDshHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = savedDshHome
  })
  const authDir = join(home, '.workbuddy-auth')
  await mkdir(authDir, { recursive: true })
  const seed = (key: string, token: string, uid: string): string => JSON.stringify({
    version: 1,
    key,
    credential: {
      accessToken: token,
      refreshToken: 'rt',
      expiresAtMs: Date.now() + 3600_000,
      domain: 'www.codebuddy.cn',
      uid,
    },
  })
  await writeFile(ownAccountPath('alice'), seed('alice', 'at-alice', 'uid-alice'))
  await writeFile(ownAccountPath('bob'), seed('bob', 'at-bob', 'uid-bob'))

  const harness: MultiHarness = { shim: undefined as unknown as WorkBuddyShim, seenCredentials: [] }
  const manager = new WorkBuddyAccountManager({
    refresh: async credential => ({ accessToken: credential.accessToken }),
  })
  harness.shim = createWorkBuddyShim({
    store: manager,
    catalog: new WorkBuddyCatalog(),
    client: {
      async chatStream(credential): Promise<WorkBuddyChatResult> {
        harness.seenCredentials.push(credential)
        return {
          ok: true,
          response: new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        }
      },
    },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

describe('WorkBuddy shim multi-account routing', () => {
  it('routes /v1/<key>/chat/completions to that account credential', async () => {
    const harness = await startMultiShim()
    for (const [key, token] of [['alice', 'at-alice'], ['bob', 'at-bob']] as const) {
      const response = await fetch(`${harness.shim.baseUrl()}/v1/${key}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(harness.seenCredentials.map(credential => credential.accessToken)).toEqual(['at-alice', 'at-bob'])
    expect(harness.seenCredentials.map(credential => credential.uid)).toEqual(['uid-alice', 'uid-bob'])
  })

  it('answers 401 for an unknown account key', async () => {
    const harness = await startMultiShim()
    const response = await fetch(`${harness.shim.baseUrl()}/v1/ghost/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_signed_in')
    expect(harness.seenCredentials).toEqual([])
  })

  it('refuses the bare chat path when backed by the manager', async () => {
    const harness = await startMultiShim()
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    await response.text()
    expect(harness.seenCredentials).toEqual([])
  })
})
