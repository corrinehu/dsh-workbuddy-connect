/**
 * Offline cross-instance integration for #92.
 *
 * #92 is a *resolution* failure: a pnpm profile with a hoisted root and no peer
 * install leaves an older pi-ai where the plugin looks first, so the plugin
 * builds its provider from a copy the rc.2 host was not built against. Fixing
 * that means the plugin ships its own copy — and raises the question these tests
 * answer: **when two pi-ai copies coexist, can the host actually drive a
 * provider built from the other one?**
 *
 * The two copies are made physically distinct (copied, not symlinked) because a
 * single install cannot produce the situation. The provider handed to the host
 * is built by the SECOND copy, through that copy's own `createProvider` and its
 * own lazy `openAICompletionsApi`; the host is the real `PiAiAdapter` from the
 * installed `dsh-llm-pi-ai@0.2.0-rc.2`. A request then runs the whole way to a
 * stubbed `fetch`, carrying a system message — the shape whose token estimation
 * is what the older generation mishandles.
 *
 * Everything is offline: no network, no install. The second tree is torn down in
 * a `finally`, and its root is captured before removal so cleanup cannot reach
 * outside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

afterEach(() => vi.unstubAllGlobals())

/** Absolute path of the pi-ai copy this process resolves. */
function storePiAiDir(): string | undefined {
  // `createRequire().resolve` cannot reach this package — its exports map does
  // not open `./package.json`, and the CJS resolver refuses the bare specifier.
  // `import.meta.resolve` follows the same ESM resolution the plugin uses.
  const entry = import.meta.resolve('@earendil-works/pi-ai')
  let dir = dirname(fileURLToPath(entry))
  for (let step = 0; step < 5; step += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
      }
      if (manifest.name === '@earendil-works/pi-ai') return dir
    } catch {
      // No manifest here; keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Materialise a second, physically separate pi-ai tree and return both the
 * temp root (for cleanup) and the copy's package directory.
 */
function materialiseSecondCopy(): { root: string; dir: string } {
  const source = storePiAiDir()
  if (source === undefined) throw new Error('could not locate the pi-ai package to copy')
  const store = dirname(dirname(source))
  // The temp root is created here and returned, so cleanup removes exactly this
  // directory and nothing above it. It never points at the store itself.
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-ai-second-'))
  const dir = join(root, 'node_modules', '@earendil-works', 'pi-ai')
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(source, dir, { recursive: true })
  const deps = join(dir, 'node_modules')
  mkdirSync(deps, { recursive: true })
  for (const name of ['zod', 'typebox', 'partial-json', 'openai', 'ws']) {
    const from = join(store, name)
    if (!existsSync(from)) continue
    if (process.platform === 'win32') {
      // Windows `dir` symlinks need Developer Mode or elevation and otherwise
      // fail with EPERM, which would turn this test into a false failure on
      // Windows CI. A junction needs no privilege and resolves identically for
      // directory targets, which is all this fixture requires — the copy is
      // what the test is about, not the link flavour.
      try {
        symlinkSync(from, join(deps, name), 'junction')
        continue
      } catch {
        // Junctions need an absolute target; fall through to an outright copy
        // so the fixture still resolves on any Windows configuration.
      }
    } else {
      symlinkSync(from, join(deps, name), 'dir')
      continue
    }
    cpSync(from, join(deps, name), { recursive: true })
  }
  return { root, dir }
}

/** One model descriptor in the shape the plugin builds (see src/adapter.ts). */
function modelFor(provider: string) {
  return {
    id: 'cross-instance',
    name: 'Cross Instance',
    api: 'openai-completions',
    provider,
    baseUrl: 'http://127.0.0.1:1/v1',
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_024,
  }
}

describe('#92 cross-instance: host drives a provider built by another pi-ai copy', () => {
  it('runs a request end to end through a second-copy provider', async () => {
    const { root, dir } = materialiseSecondCopy()
    try {
      // Build the provider using the SECOND copy's own entry points — its
      // `createProvider` and its lazy API module — so nothing here comes from
      // the copy the host imports.
      const secondEntry = join(dir, 'dist', 'index.js')
      const secondApi = join(dir, 'dist', 'api', 'openai-completions.lazy.js')
      const second = await import(secondEntry) as {
        createProvider: (options: unknown) => Record<string, unknown>
      }
      const secondLazy = await import(secondApi) as {
        openAICompletionsApi: () => unknown
      }

      const providerId = 'cross-instance'
      const piProvider = second.createProvider({
        id: providerId,
        name: 'Cross Instance',
        auth: {
          apiKey: {
            name: 'test',
            async resolve() {
              return { auth: { apiKey: 'test-token' }, source: 'test' }
            },
          },
        },
        models: [modelFor(providerId)],
        api: secondLazy.openAICompletionsApi(),
      })

      // The host: the real rc.2 adapter, given a profile whose provider came
      // from the other copy. Mirrors ResolvedPiAiProviderProfile in
      // src/adapter.ts:356-368.
      const profiles = new Map([[providerId, {
        provider: providerId,
        displayName: 'Cross Instance',
        streamIdleTimeoutMs: 30_000,
        retryPolicy: undefined,
        configuredMaxTokens: new Map<string, number>(),
        modelErrors: new Map<string, string>(),
        piProvider,
      }]])
      const adapter = new PiAiAdapter({
        profiles: () => profiles,
        // Top-level on the config, matching how `streamWithSnapshot` calls it.
        resolveApiKey: async () => 'test-token',
      } as never)

      // The advertised model must be readable through the plugin's provider.
      const models = await adapter.listModels(providerId)
      expect(models.map(entry => entry.id)).toContain('cross-instance')

      let body: Record<string, unknown> | undefined
      vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }))

      const call = await adapter.prepareCall(providerId, 'cross-instance')
      for await (const _chunk of call.stream({
        provider: providerId,
        model: 'cross-instance',
        // The system message is the shape #92 implicates: the host folds it in
        // and token estimation walks its blocks. Reaching fetch without a
        // TypeError is the assertion.
        messages: [
          createSystemMessage('You are a helpful assistant.') as never,
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      })) {
        // Reaching fetch at all proves the hand-off worked.
      }

      expect(body, 'the host never reached the mocked upstream').toBeDefined()
      const serialized = JSON.stringify(body)
      expect(serialized).toContain('helpful assistant')
      expect(serialized).toContain('hello')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the two copies are genuinely distinct module instances', async () => {
    const { root, dir } = materialiseSecondCopy()
    try {
      const [live, second] = await Promise.all([
        import('@earendil-works/pi-ai') as Promise<Record<string, unknown>>,
        import(join(dir, 'dist', 'index.js')) as Promise<Record<string, unknown>>,
      ])
      // Distinct instances — the situation a hoisted profile root creates.
      expect(live).not.toBe(second)
      // Both copies expose what the host needs to drive a provider built by the
      // other, which is what makes shipping our own copy safe. The older
      // generation #92 reports lacks `collapseSystemMessages`; that asymmetry is
      // recorded in the issue and is not re-measured here (no 0.82 copy is
      // installed on this machine).
      expect(typeof live['createProvider']).toBe('function')
      expect(typeof second['createProvider']).toBe('function')
      expect(typeof live['collapseSystemMessages']).toBe('function')
      expect(typeof second['collapseSystemMessages']).toBe('function')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
