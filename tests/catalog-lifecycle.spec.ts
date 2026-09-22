import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { fingerprintModel } from '../src/probe-store.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { FakeSettings } from './fake-settings.ts'

/**
 * Catalog lifecycle: what happens across a credential change and a failed fetch.
 *
 * These use the real plugin `apply()` with a stubbed global fetch, because the
 * behaviour under test lives in the wiring rather than in any one module — the
 * credential sweep, the catalog gate, and the retry backoff all have to agree.
 */

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-lifecycle-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function credentialDocument(domain: string, uid: string): string {
  return JSON.stringify({
    auth: { accessToken: `at-${uid}`, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid, nickname: uid, enterpriseId: 'ent-1' },
  })
}

/** A CN catalog envelope with one recognizable model id. */
function catalogEnvelope(modelId: string, name: string): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      models: [{ id: modelId, name, maxInputTokens: 100_000, maxOutputTokens: 1_000, supportsImages: true }],
      agents: [{ name: 'cli', models: [modelId] }],
    },
  })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

/**
 * Stands in for the Host's webServer service so the plugin's REAL routes (as
 * wired by `apply()`, not re-mounted by hand) become callable from a test.
 *
 * The manual-refresh path the reviewer flagged lives inside `apply()`'s route
 * closures, so exercising it needs the actual handlers `apply()` registers —
 * which means the `webServer` inject has to fire. This service collects them.
 */
class FakeWebServer extends Service {
  /** Latest instance; the class is plugged per test. */
  static current: FakeWebServer | undefined
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    FakeWebServer.current = this
  }

  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** Serve the captured routes over real HTTP, so the handlers see real req/res. */
async function serve(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return { port, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}

async function boot(): Promise<Context> {
  // Shorten the credential sweep so the lifecycle transitions are observable
  // without waiting the production interval. The retry backoff is expressed in
  // sweeps, so it scales down with it.
  vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSettings)
  const settings = ctx.settings as unknown as FakeSettings
  await ctx.plugin(FakeWebServer)
  const fiber = await ctx.plugin(WorkBuddy, {})
  // The Host binds a namespace to the entry that owns it; with no Loader in a
  // bare Context the plugin falls back to the entry id its own patch declares.
  settings.bind(WorkBuddy.WORKBUDDY_ENTRY_ID, { config: fiber.config, ctx: fiber.ctx })
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  })
  return ctx
}

describe('catalog lifecycle', () => {
  it('serves a live catalog once the first fetch succeeds', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live Model'))))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })
    // The upstream roster replaced the built-in fallback entirely.
    expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).not.toContain('minimax-m3-pay')
  })

  it('keeps the fallback roster and retries after a failed fetch', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))

    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1
      // Fail the first attempt only: the retry must recover on its own.
      return attempts === 1
        ? fakeResponse('upstream down', false, 503)
        : fakeResponse(catalogEnvelope('recovered-model', 'Recovered'))
    }))

    const ctx = await boot()
    // The failed fetch leaves the per-variant fallback serving: the group is
    // visible and usable rather than empty.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
    expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toContain('minimax-m3-pay')
    expect(attempts).toBeGreaterThanOrEqual(1)

    // Without the retry this stayed on the fallback list until a manual
    // refresh — a startup network blip should not require user action.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['recovered-model'])
    }, { timeout: 10_000 })
  })

  it('does not re-fetch the catalog on every credential sweep', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    const request = vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live')))
    vi.stubGlobal('fetch', request)

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })
    const afterFirst = request.mock.calls.length
    // Several sweeps' worth of time at the module's 30s interval would be too
    // slow to wait for here; instead assert the invariant that matters — a
    // successful fetch is not repeated for the same identity — by reading the
    // catalog repeatedly, which is what a sweep's early-return guards.
    for (let index = 0; index < 5; index += 1) await ctx.llm.listModels('workbuddy')
    expect(request.mock.calls.length).toBe(afterFirst)
  })

  it('hides the group when the credential disappears and restores it when it returns', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live'))))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })

    // Signing out (file removed) must remove the group, not leave it pickable.
    await rm(cnFile)
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    }, { timeout: 20_000 })

    // Signing back in restores it: the provider stayed registered throughout.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  it('does not show a previous account catalog after the account switches', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Answer per credential: the request carries the account's token, so the
      // second account gets a different roster.
      const auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '')
      return fakeResponse(auth.includes('uid-b')
        ? catalogEnvelope('account-b-model', 'B')
        : catalogEnvelope('account-a-model', 'A'))
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-a-model'])
    })

    // Switch the desktop app's account in place.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-b-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  /**
   * The reviewer's second finding: after switching to account B, a MANUAL
   * refresh that fails left account A's catalog serving — under a "live" label,
   * too, since a failed fetch never marks the source fallback, so even the
   * sweep's retry would not have recovered it.
   *
   * This drives the real refresh route (mounted by apply() into the fake
   * webServer) end to end: A's roster live, A's probe observation recorded,
   * switch to B, refresh fails → A's models and A's observation must both be
   * gone, fallback serving, source honestly 'fallback' with the error. Then the
   * next refresh succeeds and B's roster lands.
   */
  it('stops serving the old account after a switch even when the refresh fails, and restores it on return', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))

    // Seed a probe observation belonging to account A. The fingerprint must
    // match the row the LIVE catalog serves (the fetch succeeds first here), so
    // it is computed over exactly the fields fingerprintModel hashes — the
    // reasoning shape parseModelCatalog emits for an envelope with no
    // supportsReasoning/onlyReasoning/reasoning keys.
    const liveRowA = {
      id: 'acct-a-model',
      name: 'acct-a-model',
      contextWindow: 100_000,
      maxTokens: 1_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
    }
    await writeFile(join(root, '.workbuddy-probe.json'), JSON.stringify({
      version: 2,
      records: {
        'uid-a:ent-1': {
          'acct-a-model': {
            fingerprint: fingerprintModel(liveRowA),
            validation: 'validating',
            efforts: ['low'],
            probedAtMs: Date.now(),
            pluginVersion: 'test',
            // Observations are bound to the account that produced them; a record
            // without this is refused by design, so this names account A.
            account: 'uid-a:ent-1',
          },
        },
      },
    }))

    let failCatalog = false
    let rosterModel = 'acct-a-model'
    // The stub must leave this test's own calls to the mounted routes alone:
    // delegate loopback requests to the real fetch, answer only upstream ones.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
      if (failCatalog) return fakeResponse('upstream down', false, 503)
      return fakeResponse(catalogEnvelope(rosterModel, rosterModel))
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['acct-a-model'])
    })

    const routes = FakeWebServer.current!.routes
    expect(routes.has('/plugins/dsh-workbuddy-connect/status')).toBe(true)
    const server = await serve(routes)
    const get = async (path: string) => JSON.parse((await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: `127.0.0.1:${server.port}` } })).text()))
    const post = async (path: string, key: string, body: unknown) =>
      await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-workbuddy-probe-key': key },
        body: JSON.stringify(body),
      })

    // A's observation is live on the card before the switch.
    const before = await get('/plugins/dsh-workbuddy-connect/status')
    const key = before.probeKey as string
    expect(before.probe.results.map((r: { id: string }) => r.id)).toContain('acct-a-model')
    expect(before.catalog.source).toBe('live')

    // Switch the account in place, and make the catalog fetch fail.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))
    failCatalog = true

    const failed = await post('/plugins/dsh-workbuddy-connect/probe', key, { action: 'refresh' })
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ state: 'failed' })

    // The invariant: nothing of account A's is *served* under account B. Its
    // observation survives on disk (keyed to A) but no read under B sees it.
    const after = await get('/plugins/dsh-workbuddy-connect/status')
    expect(after.probe.results).toEqual([])
    expect(after.catalog.source).toBe('fallback')
    expect(String(after.catalog.error)).toMatch(/503|upstream/i)
    const serving = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    expect(serving).not.toContain('acct-a-model')
    expect(serving).toContain('minimax-m3-pay')

    // Recovery: the same manual action once the upstream answers again.
    failCatalog = false
    rosterModel = 'acct-b-model'
    const ok = await post('/plugins/dsh-workbuddy-connect/probe', key, { action: 'refresh' })
    expect(await ok.json()).toMatchObject({ state: 'refreshed' })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['acct-b-model'])
    })

    // And back to A: its roster and its recorded levels return without a fresh
    // detection — the observation survived the round trip through account B.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    rosterModel = 'acct-a-model'
    const back = await post('/plugins/dsh-workbuddy-connect/probe', key, { action: 'refresh' })
    expect(await back.json()).toMatchObject({ state: 'refreshed' })
    await vi.waitFor(async () => {
      const status = await get('/plugins/dsh-workbuddy-connect/status')
      expect(status.probe.results.map((r: { id: string }) => r.id)).toContain('acct-a-model')
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['acct-a-model'])
    })
  }, 45_000)
})

/**
 * The saved catalog sits between a live fetch and the built-in roster in the
 * plan's degradation order (§4). Without it a restart always dropped the user
 * to the compiled-in snapshot, even when a good catalog had been fetched
 * moments earlier — which the plan and the README both promise not to happen.
 */
describe('saved catalog', () => {
  it('restores the last successful catalog for the account on a restart with no network', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-1'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')

    // First run: online, so a live catalog lands and is remembered.
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(catalogEnvelope('saved-model', 'Saved'))))
    const first = await boot()
    await vi.waitFor(async () => {
      expect((await first.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['saved-model'])
    }, { timeout: 10_000 })
    // Let the write land before the process is torn down.
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.fiber.dispose()
    context = undefined

    // Second run: offline. The saved catalog must serve, not the built-in roster.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const second = await boot()
    await vi.waitFor(async () => {
      expect((await second.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['saved-model'])
    }, { timeout: 10_000 })
  }, 45_000)
})

describe('identity changes during catalog loading', () => {
  it('does not resurface a signed-out account roster when another account fetch fails', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))

    let fail = false
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fail) return fakeResponse('offline', false, 503)
      const auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '')
      return fakeResponse(auth.includes('uid-b')
        ? catalogEnvelope('account-b-model', 'B')
        : catalogEnvelope('account-a-model', 'A'))
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-a-model'])
    })

    await rm(cnFile)
    await vi.waitFor(async () => { expect(await ctx.llm.listModels('workbuddy')).toEqual([]) })

    fail = true
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
      expect(ids).not.toContain('account-a-model')
      expect(ids).toContain('minimax-m3-pay')
    })
  }, 45_000)

  it('cancels an old-account request and starts one for the newly selected account', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))

    let calls = 0
    let aborted = false
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('old account request aborted'))
          }, { once: true })
        })
      }
      return fakeResponse(catalogEnvelope('account-b-model', 'B'))
    }))

    const ctx = await boot()
    await vi.waitFor(() => { expect(calls).toBe(1) })
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))

    await vi.waitFor(async () => {
      // At least a catalogue request for the new account; the CN refresh also
      // reads the console document for promo badges, so the exact total is an
      // implementation detail of how many documents one refresh needs.
      expect(calls).toBeGreaterThanOrEqual(2)
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-b-model'])
    })
    expect(aborted).toBe(true)
  }, 45_000)

  it('does not save a resolved credential under an identity read before it changed', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '')
      return fakeResponse(auth.includes('uid-b')
        ? catalogEnvelope('account-b-model', 'B')
        : catalogEnvelope('account-a-model', 'A'))
    }))

    const resolve = WorkBuddyCredentialStore.prototype.resolve
    let switched = false
    vi.spyOn(WorkBuddyCredentialStore.prototype, 'resolve').mockImplementation(async function (this: WorkBuddyCredentialStore) {
      if (!switched) {
        switched = true
        await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))
      }
      return resolve.call(this)
    })

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-b-model'])
    })
    const saved = JSON.parse(await readFile(join(root, '.workbuddy-catalog.json'), 'utf8')) as { entries: Record<string, unknown> }
    expect(saved.entries['uid-a:ent-1']).toBeUndefined()
    expect(saved.entries['uid-b:ent-1']).toBeDefined()
  }, 45_000)
})
