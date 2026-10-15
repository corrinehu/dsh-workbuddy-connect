import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { ChatIdentity } from '../src/client-identity.ts'

/**
 * Wire pin for issue #139: since 2026-10-16 the international gateway answers a
 * `/v2/chat/completions` request that omits all three `X-Conversation-*`
 * headers with `400` / `code 11128` / `msg: "conversation id missing"` — the
 * `displayMsg.zh` users see is 「请求被拦截，请重新发送」. The trio therefore has
 * to ride on chat and on the effort probe (they share `chatHeaders`), each
 * value a v4 UUID, and it must stay off refresh, catalog, and billing so the
 * blast radius is one header family.
 *
 * The measurement behind "fresh per request": the upstream keeps no history
 * keyed by the id, so nothing is lost by minting a new trio per call — and
 * nothing is shared when several agents run at once.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

/** Canonical v4 shape — the upstream reads the id as a UUID, so pin the version nibble. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const TRIO = ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID'] as const

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Stub fetch and expose every `(url, init)` pair it received.
 *
 * `all()` rather than only the last call, because the catalog path issues two
 * requests (`/v3/config` plus the best-effort console read) and the
 * blast-radius assertions have to cover both.
 */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  const all = () => fetchMock.mock.calls as unknown as [string, RequestInit][]
  return {
    all,
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      const calls = all()
      return calls[calls.length - 1]!
    },
  }
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

describe('chat carries the conversation channel trio', () => {
  it('sends all three headers as distinct v4 UUIDs on the international chat', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(GLOBAL, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = headersOf(init)
    const values = TRIO.map((name) => headers[name])
    for (const value of values) expect(value).toMatch(UUID_V4)
    expect(new Set(values).size).toBe(3)
  })

  it('sends the same trio on the CN chat — measured as accepted, so the paths cannot drift', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    }))
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = headersOf(init)
    for (const name of TRIO) expect(headers[name]).toMatch(UUID_V4)
  })

  it('mints a fresh trio per request, so parallel agents never share one conversation', async () => {
    const wire = captureFetch('{}')
    const upstream = client()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }] })
    await upstream.chatStream(GLOBAL, body)
    const first = headersOf(wire.last()[1])
    await upstream.chatStream(GLOBAL, body)
    const second = headersOf(wire.last()[1])
    for (const name of TRIO) expect(second[name]).not.toBe(first[name])
  })

  it('the effort probe shares the chat rule', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    const result = await client().probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(result.status).toBe(400)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = headersOf(init)
    for (const name of TRIO) expect(headers[name]).toMatch(UUID_V4)
  })
})

describe('the channel trio stays off every other endpoint (blast-radius pin)', () => {
  it('refresh never carries it', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    for (const [url, init] of wire.all()) {
      expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
      for (const name of TRIO) expect(headersOf(init)[name]).toBeUndefined()
    }
  })

  it('catalog never carries it, on either request it issues', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }],
        agents: [{ name: 'cli', models: ['m'] }],
      },
    }))
    await client().fetchModels(CN)
    expect(wire.all().length).toBeGreaterThanOrEqual(2)
    for (const [, init] of wire.all()) {
      for (const name of TRIO) expect(headersOf(init)[name]).toBeUndefined()
    }
  })

  it('billing never carries it', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { Response: { Data: { Accounts: [] } } },
    }))
    await client().fetchCredits(CN)
    for (const [, init] of wire.all()) {
      for (const name of TRIO) expect(headersOf(init)[name]).toBeUndefined()
    }
  })
})
