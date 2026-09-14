import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyClientIdentity } from '../src/upstream.ts'

/**
 * Outbound wire capture: what the plugin actually hands to `fetch`.
 *
 * Nothing in this suite looked at the request before. `tests/shim.spec.ts`
 * substituted `chatStream` with an in-process function, so the real `fetch` in
 * `src/upstream.ts` never ran under test, and every stub in
 * `tests/upstream.spec.ts` was argument-less (`vi.fn(async () => …)`), so URL,
 * headers and body were structurally unobservable. Deleting the whole
 * client-identity tuple — the fields a credit ledger attributes a request by
 * (使用端) — or reverting the User-Agent left the suite green.
 *
 * Every test here records `(url, init)` at the global `fetch` the client calls
 * and asserts the request against `docs/workbuddy-client-wire-contract.md`:
 * §2.2 (headers it sends), §2.4 (headers it must not), §3 (User-Agent), §4
 * (refresh source) and §5 (first-message role).
 *
 * The identity is supplied through the documented injection seam
 * (`resolveClientIdentity`) so the assertions are the contract's own values and
 * do not depend on whichever App version happens to be installed. Honesty about
 * what that pins: the composed User-Agent and the `X-IDE-*` values are the
 * contract's ◐ inferred rows — derived from confirmed bytes plus the desktop's
 * environment bag, never captured on a live request. These tests pin the values
 * the plugin is required to send; they are not a packet capture. No network call
 * is made and no credential file is read: every request is answered in process.
 */

const CN_DOMAIN = 'www.codebuddy.cn'
const GLOBAL_DOMAIN = 'www.workbuddy.ai'

/** A personal CN account: no enterprise, so the enterprise headers are absent (§2.2 #13-15). */
const PERSONAL: WorkBuddyCredential = {
  accessToken: 'at-secret',
  refreshToken: 'rt-secret',
  expiresAtMs: 0,
  domain: CN_DOMAIN,
  uid: 'uid-1',
  source: 'desktop',
}

/** The desktop-spawned identity the contract derives: App 5.5.6 + bundled CLI 2.137.1. */
const IDENTITY: WorkBuddyClientIdentity = { appVersion: '5.5.6', cliVersion: '2.137.1' }
/** §3: `<platform>/<platformVersion> <productName>/<productVersion> CLI/<cliVersion>`. */
const UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1'
/** The literal the plugin used to send on every request. */
const STALE_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** Both ids the official client mints are UUID v4 with the dashes stripped. */
const DASHED_UUID = /^[0-9a-f]{32}$/

interface Captured {
  url: string
  init: RequestInit | undefined
}

const CLEANUP: (() => Promise<void>)[] = []

/**
 * Tripwire: until a test installs its own recorder, `fetch` throws.
 *
 * A test that signs a credential in without stubbing `fetch` really did reach
 * `https://copilot.tencent.com` once in this repo (`tests/settings-integration.spec.ts`),
 * so "the stub is installed everywhere" is not something to assume. Every test
 * below calls {@link capture} before it can issue a request, so this can only
 * fire on a mistake.
 */
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('outbound request without a recording stub') }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/**
 * Record every outbound call and answer it in process.
 *
 * The stub takes `(input, init)`, exactly as `fetch` does, so the assertions
 * below describe the call the client made rather than a value the test already
 * held.
 */
function capture(reply: (call: Captured) => Response): Captured[] {
  const calls: Captured[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: Captured = { url: typeof input === 'string' ? input : String(input), init }
    calls.push(call)
    return reply(call)
  }))
  return calls
}

/** The header map the client passed to `fetch`. */
function headersOf(call: Captured): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>
}

/** The parsed JSON body the client passed to `fetch`. */
function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

/** A minimal JSON response for the envelope endpoints (`readEnvelope` uses `.text()`). */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response
}

/** A streaming chat answer the client treats as a success. */
function streamResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** A client whose outbound identity is pinned instead of read from the App bundle. */
function clientFor(identity: WorkBuddyClientIdentity): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveClientIdentity: async () => identity })
}

/** The chat body shape pi-ai sends: the harness system prompt arrives as `developer`. */
function chatBody(messages: unknown[]): string {
  return JSON.stringify({ model: 'auto', stream: false, messages })
}

describe('outbound chat request (CN, personal account)', () => {
  /** Every header §2.2 says the official chat request carries, and its value. */
  const CONTRACT_HEADERS: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${PERSONAL.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Agent-Intent': 'craft',
    'X-Agent-Type': 'main',
    'X-Conversation-ID': '', // asserted as a shape below, not a literal
    'X-Conversation-Message-ID': '',
    'X-Conversation-Request-ID': '',
    'X-Domain': CN_DOMAIN,
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': IDENTITY.appVersion,
    'X-Product': 'SaaS',
    'X-Request-ID': '',
    'X-User-Id': 'uid-1',
  }

  it('POSTs the official chat URL and carries every contract header', async () => {
    const calls = capture(() => streamResponse())

    const result = await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(call.init?.method).toBe('POST')

    const headers = headersOf(call)
    for (const [name, value] of Object.entries(CONTRACT_HEADERS)) {
      // A literal `''` marks an id asserted by shape in the next test.
      if (value !== '') expect(headers[name], `${name} must be on the chat request`).toBe(value)
    }
    for (const name of ['X-Request-ID', 'X-Conversation-Message-ID', 'X-Conversation-ID', 'X-Conversation-Request-ID']) {
      expect(headers[name], `${name} must be a dash-stripped UUID`).toMatch(DASHED_UUID)
    }
    // B1/B26: one value is both ids, because both are the turn's messageId.
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
  })

  it('sends exactly the contract header set — no invented extras', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    expect(Object.keys(headersOf(calls[0]!)).sort()).toEqual(Object.keys(CONTRACT_HEADERS).sort())
  })

  it('sends none of the headers the contract records as absent (§2.4)', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    const headers = headersOf(calls[0]!)
    for (const name of [
      // Suppressor markers the auth interceptor *reads*; the chat path never sends them.
      'X-No-User-Id', 'X-No-Enterprise-Id', 'X-No-Department-Info', 'X-No-Authorization',
      // Omitted entirely for a personal account.
      'X-Enterprise-Id', 'X-Tenant-Id', 'X-Department-Info',
      // Only ever on the refresh call.
      'X-Refresh-Token',
      // A browser tell, or SDK internals that are not client identity.
      'X-Requested-With', 'Origin', 'Referer',
    ]) {
      expect(headers, `${name} must not be on the chat request`).not.toHaveProperty(name)
    }
  })

  it('mints fresh request ids for every turn, so two turns are distinguishable', async () => {
    const calls = capture(() => streamResponse())
    const client = clientFor(IDENTITY)
    await client.chatStream(PERSONAL, chatBody([{ role: 'user', content: 'first' }]))
    await client.chatStream(PERSONAL, chatBody([{ role: 'user', content: 'second' }]))

    expect(calls).toHaveLength(2)
    const [first, second] = calls.map(headersOf)
    // This is the plugin's idempotency identity (§2.3): the server tells a retry
    // from a new turn by the ids, and a constant here would make every turn look
    // like a replay of the one before it.
    for (const name of ['X-Request-ID', 'X-Conversation-Message-ID', 'X-Conversation-ID', 'X-Conversation-Request-ID']) {
      expect(first![name], name).toMatch(DASHED_UUID)
      expect(second![name], name).not.toBe(first![name])
    }
  })

  it('adds the enterprise headers for an enterprise account, still without the X-No-* markers', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream({ ...PERSONAL, enterpriseId: 'ent-1' }, chatBody([{ role: 'user', content: 'hi' }]))
    const headers = headersOf(calls[0]!)
    expect(headers['X-Enterprise-Id']).toBe('ent-1')
    expect(headers['X-Tenant-Id']).toBe('ent-1')
    // `departmentFullName` is not modelled by the credential, so the header the
    // interceptor would gate on it stays absent — and never becomes a suppressor.
    expect(headers).not.toHaveProperty('X-Department-Info')
    expect(headers).not.toHaveProperty('X-No-Enterprise-Id')
    expect(headers).not.toHaveProperty('X-No-Department-Info')
  })
})

describe('chat User-Agent', () => {
  it('is composed from the resolved versions, not the stale literal', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    const userAgent = headersOf(calls[0]!)['User-Agent']

    expect(userAgent).toBe(UA)
    // The regression: one hardcoded literal naming a product and version the
    // official client never sends.
    expect(userAgent).not.toBe(STALE_UA)
    expect(userAgent).not.toContain('CodeBuddy')
    expect(userAgent).not.toContain('2.63.2')
    // §3: the three tokens are the product name and the two resolved versions.
    expect(userAgent).toContain(`WorkBuddy/${IDENTITY.appVersion}`)
    expect(userAgent).toContain(`CLI/${IDENTITY.cliVersion}`)
  })

  it('tracks whatever versions the installed client reports', async () => {
    const other = { appVersion: '4.2.1', cliVersion: '9.9.9' }
    const calls = capture(() => streamResponse())
    await clientFor(other).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    // A different install must produce a different UA: a constant cannot satisfy
    // both this and the test above.
    expect(headersOf(calls[0]!)['User-Agent']).toBe('WorkBuddy/4.2.1 WorkBuddy/4.2.1 CLI/9.9.9')
    expect(headersOf(calls[0]!)['X-IDE-Version']).toBe(other.appVersion)
  })

  it('drops the CLI token when no CLI version resolves (§3 degradation)', async () => {
    const calls = capture(() => streamResponse())
    await clientFor({ appVersion: '5.5.6' }).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    const userAgent = headersOf(calls[0]!)['User-Agent']
    expect(userAgent).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')
    // The official builder pushes the extension only when it exists; it never
    // invents a version, and `unknown` is not a version this plugin sends.
    expect(userAgent).not.toContain('CLI/')
    expect(userAgent).not.toContain('unknown')
  })
})

describe('outbound chat body', () => {
  it('keeps the caller role order on CN and rewrites the developer role to system', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([
      { role: 'developer', content: 'harness system prompt' },
      { role: 'user', content: 'hi' },
    ]))
    const body = bodyOf(calls[0]!)
    const messages = body['messages'] as { role: string, content: string }[]

    // The CN endpoint rejects the `developer` container (400/11128 there), so it
    // is rewritten — and rewriting only the role leaves the first-message ORDER
    // the caller sent: nothing is prepended on this path (§5).
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe('harness system prompt')
    expect(messages[1]?.role).toBe('user')
    expect(body['stream']).toBe(true)
  })

  it('does not invent a CN system prompt when the first message is a user message', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    const messages = bodyOf(calls[0]!)['messages'] as { role: string, content: string }[]

    // §5: the official builder prepends a system message only when the agent has
    // instructions; there is no CN-specific system-first rule. An invented prompt
    // would put words in the model's mouth that the user never wrote.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('does enforce a leading system message on the international path', async () => {
    const calls = capture(() => streamResponse())
    await clientFor(IDENTITY).chatStream(
      { ...PERSONAL, domain: GLOBAL_DOMAIN },
      chatBody([{ role: 'user', content: 'hi' }]),
    )
    const call = calls[0]!
    expect(call.url).toBe(`https://${GLOBAL_DOMAIN}/v2/chat/completions`)
    const messages = bodyOf(call)['messages'] as { role: string, content: string }[]
    // The gateway rejects a body whose first message is not `system` with
    // 400/11128, so the same rule that must NOT fire on CN fires here.
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('outbound token refresh', () => {
  it('POSTs the plugin refresh route carrying the contract refresh source (§4)', async () => {
    const calls = capture(() => jsonResponse({
      code: 0,
      msg: 'ok',
      data: { accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 },
    }))

    const outcome = await clientFor(IDENTITY).refreshToken(PERSONAL)

    // The parsed result is not the point: the request is.
    expect(outcome.accessToken).toBe('new-at')
    expect(outcome.refreshToken).toBe('new-rt')
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    expect(call.init?.method).toBe('POST')

    const headers = headersOf(call)
    expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
    // The regression: `workbuddy` is a value that appears nowhere in the
    // official client (byte-confirmed absent from the whole bundle).
    expect(headers['X-Auth-Refresh-Source']).not.toBe('workbuddy')
    expect(headers['X-Refresh-Token']).toBe(PERSONAL.refreshToken)
    expect(headers['User-Agent']).toBe(UA)
  })
})

describe('the CN catalog User-Agent is deliberately unchanged', () => {
  it('keeps the historical literal on the catalog path only, never on chat', async () => {
    const calls = capture(() => jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        models: [{ id: 'm-1', name: 'Model One', maxInputTokens: 100_000, maxOutputTokens: 32_000 }],
        agents: [{ name: 'cli', models: ['m-1'] }],
      },
    }))
    const client = clientFor(IDENTITY)

    await client.fetchModels(PERSONAL)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/console/enterprises/personal/models')
    // `src/upstream.ts` keeps `CLI/2.63.2 CodeBuddy/2.63.2` on purpose, for this
    // endpoint alone: it decides which models are exposed and is the plugin's own
    // path, not client identity. Asserting the literal is *gone* would be wrong —
    // asserting where it is and is not used is the pin.
    expect(headersOf(calls[0]!)['User-Agent']).toBe(STALE_UA)

    await client.chatStream(PERSONAL, chatBody([{ role: 'user', content: 'hi' }]))
    expect(headersOf(calls[1]!)['User-Agent']).toBe(UA)
  })
})

/**
 * End-to-end capture: the request a real DSH chat completion produces.
 *
 * `tests/shim.spec.ts` hands the shim a fake `chatStream`, which is exactly the
 * gap this task exists to close. Here the shim gets a real
 * {@link WorkBuddyUpstreamClient} — only its identity resolver is injected — and
 * the test drives the shim over `node:http` so the stubbed global `fetch`
 * intercepts the upstream call and nothing else.
 */
describe('end-to-end capture through the shim', () => {
  /** Raw HTTP request with full header control (`fetch` is stubbed in these tests). */
  function rawRequest(options: {
    port: number
    method: string
    path: string
    headers: Record<string, string>
    body?: string
  }): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('error', reject)
      if (options.body !== undefined) req.write(options.body)
      req.end()
    })
  }

  it('sends the captured chat request for a DSH chat completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-wire-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: Date.now() + 3_600_000, domain: CN_DOMAIN },
      account: { uid: 'uid-1' },
    }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'unused' }),
    })
    const shim = createWorkBuddyShim({
      store,
      catalog: new WorkBuddyCatalog(),
      // The real client, so the real `fetch` at src/upstream.ts runs.
      client: clientFor(IDENTITY),
    })
    await shim.ready
    CLEANUP.push(() => shim.close())

    const calls = capture(() => streamResponse())
    const port = Number(new URL(shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: chatBody([
        { role: 'developer', content: 'harness system prompt' },
        { role: 'user', content: 'hi' },
      ]),
    })

    // The DSH side completed, so this is a real round trip and not a mock.
    expect(res.status).toBe(200)
    expect(res.body).toContain('[DONE]')

    // Exactly one request left the process, and it is the upstream chat call.
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(call.init?.method).toBe('POST')

    const headers = headersOf(call)
    for (const [name, value] of Object.entries({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-Agent-Intent': 'craft',
      'X-Agent-Type': 'main',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Version': IDENTITY.appVersion,
      'X-Product': 'SaaS',
      'X-User-Id': 'uid-1',
      'X-Domain': CN_DOMAIN,
      'Authorization': `Bearer ${PERSONAL.accessToken}`,
    })) {
      expect(headers[name], `${name} must be on the outbound chat request`).toBe(value)
    }
    expect(headers['X-Request-ID']).toMatch(DASHED_UUID)
    expect(headers).not.toHaveProperty('X-No-Enterprise-Id')
    expect(headers).not.toHaveProperty('X-No-Department-Info')

    const messages = bodyOf(call)['messages'] as { role: string, content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe('harness system prompt')
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})
