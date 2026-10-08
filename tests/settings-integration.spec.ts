import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { LegacySettingsService } from './helpers/legacy-settings.ts'

/**
 * In-memory legacy settings: the 0.1.5/0.1.6 section API this plugin drives.
 *
 * DSH 0.2.0 replaced the real settings service with a Config-derived forms
 * facade, so subclassing it — as these specs once did — would exercise a
 * service this plugin does not use at all.
 */
class MemorySettings extends LegacySettingsService {
  constructor() {
    super({
      read: () => ({}),
      persist: () => Promise.resolve(),
    })
  }
}

let context: Context | undefined
let root: string | undefined

/** A desktop-shaped credential document for one upstream region. */
function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    // A best-effort version-cache write can still be in flight when the host
    // is disposed; when it lands between rm's child-unlink pass and the final
    // rmdir, rm fails with ENOTEMPTY. A short retry absorbs that race.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'ENOTEMPTY' && code !== 'ENOENT')) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('WorkBuddy Host settings integration', () => {
  it('restores the saved maximum-window preference after restarting and can disable it', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-context-restart-'))
    const settingsFile = join(root, 'settings.json')
    const aiFile = join(root, 'ai.info')
    await writeFile(settingsFile, '{}')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    /**
     * A file-backed legacy settings service: the preference has to survive a
     * full context dispose and re-boot, so the sections' document is written
     * out and read back through a temp file.
     */
    class FileSettings extends LegacySettingsService {
      constructor() {
        super({
          read: () => {
            // Read synchronously: installation is synchronous, and a stored
            // preference has to be in place before the plugin reads the
            // section's value source.
            try {
              return JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, Record<string, unknown>>
            } catch {
              return {}
            }
          },
          persist: async document => { await writeFile(settingsFile, JSON.stringify(document)) },
        })
      }
    }
    /** The settings service the last boot installed its sections into. */
    let settings: FileSettings | undefined
    const boot = async (): Promise<Context> => {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      settings = new FileSettings()
      ctx.provide('settings', settings)
      await ctx.plugin(WorkBuddy, {})
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
      })
      return ctx
    }
    let ctx = await boot()
    // Fresh profile, setting never touched: the default is on, so the model
    // resolves at its largest declared window before any update is written.
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    await ctx.fiber.dispose()
    ctx = await boot()
    // Still on across a restart with nothing stored (schema default, not state).
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    // An explicit opt-out must survive restarts: the flipped default may not
    // resurrect the preference the user turned off.
    await ctx.settings.update('workbuddy-ai', { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
    await ctx.fiber.dispose()
    ctx = await boot()
    // The stored preference, read off this boot's own settings service (the
    // 0.2.0 forms facade has no per-namespace `get`, so the assertion goes
    // through the double that actually installed the section).
    expect(settings?.get(WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)).toMatchObject({ useMaximumContextWindow: false })
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
  })

  it('exposes the settings section and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    // This case asserts the CN fallback roster, which is served only to a
    // signed-in variant. Pinning a credential of its own keeps that independent
    // of whether this machine happens to have the WorkBuddy desktop app signed
    // in: without it the store probes the ambient desktop file and the group
    // stays hidden (empty model list) on a clean machine and on CI.
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    // Signing in would otherwise make this case perform a real request to the CN
    // catalog endpoint. These tests must not touch the network, and the roster
    // asserted below is the compiled-in fallback, so the fetch is stubbed to
    // fail exactly as the sibling case does rather than depending on the remote.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    await ctx.plugin(WorkBuddy, {})

    // Registration rides on the loopback shim's listening event — but
    // registration alone does not populate the model list: each variant's
    // catalog starts hidden and is revealed only once the credential sweep
    // adopts an identity, so `listModels` still returns [] here and the
    // fallback-roster assertions below see an empty list intermittently.
    await vi.waitFor(async () => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
    // No configurable-provider directory entry by design: the Models settings
    // page joins its rows on that registration, so omitting it keeps these
    // providers off that page (its editor has no fields for them). The group
    // still serves models through the adapter.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .not.toContain('workbuddy')

    // The section still exists: it is what `settings.yaml` and the TUI
    // `/settings` read `authFile` from, independent of the Models page.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('hy3')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the newer
    // models the desktop app offers that older builds lacked.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name (and the advisory description)
    // so both the /model popup and the composer seat show it; the id and the
    // request path are untouched by this display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    // Since DSH 0.1.2 the composer seat renders the model name only, so the
    // billing rate rides the name itself; description stays untouched
    // everywhere. Promo badges are NOT baked into the static fallback — they
    // are dynamic promotions that only a live refresh may attach.
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79')
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('glm-5v-turbo')?.name).toBe('GLM-5v-Turbo · x0.71')
    expect(byId.get('glm-5.2')?.description).toBeUndefined()
    expect(byId.get('glm-5.3')?.description).toBeUndefined()

    // Thinking controls are declared-set-only: models whose upstream row
    // carries `supportedEfforts` expose exactly those efforts; rows without a
    // list (the older `{effort, summary}` shape) expose no control at all, so
    // requests never carry `reasoning_effort` for them and the upstream
    // default applies — matching the desktop app's own per-model gating.
    const effortOnlyResolved = await ctx.llm.resolveModelInfo('workbuddy', 'hy3')
    expect(effortOnlyResolved.reasoning).toBeUndefined()
    const flashResolved = await ctx.llm.resolveModelInfo('workbuddy', 'glm-5.3-flash')
    // No `off`: this row declares `onlyReasoning` as well as
    // `canDisableThinking`, and the endpoint sides with the former (#87).
    expect(flashResolved.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low', 'max'])

    // Image modalities follow the per-model catalog flag (fallback list here):
    // every row of the current CN roster declares image support.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('hy3')).toContain('image')
    expect(modalities.get('glm-5.1')).toContain('image')

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants and keeps each variant identity separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-dual-'))
    vi.stubEnv('DSH_HOME', root)
    // Shorten the credential sweep: the assertions below change a setting and
    // then wait for the group to react, which only happens on a sweep.
    vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')
    // One real-shaped credential per product, in separate files. The upstream
    // fetch is stubbed to fail so the assertion covers the per-variant fallback
    // rosters rather than depending on the network.
    const cnFile = join(root, 'cn.info')
    const aiFile = join(root, 'ai.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
        expect.arrayContaining(['workbuddy', 'workbuddy-ai']),
      )
    })

    // Directory entries stay absent by design: the two providers serve models
    // and own their settings sections, but the Models settings page must not
    // list them as editable rows, so no configurable-provider entry is made.
    const configurable = ctx.llm.listConfigurableProviders().map(entry => entry.provider)
    expect(configurable).not.toContain('workbuddy')
    expect(configurable).not.toContain('workbuddy-ai')

    // THE SECTION CONTRACT. Each variant owns its own served settings section:
    // these are what `settings.yaml` and the TUI `/settings` read `authFile`
    // from, and each must keep its own fields. On DSH 0.1.5 they also anchor
    // the card dispatch — the settings Plugins tab renders
    // `settings.plugin.item` with `entryKey = ns` for each served namespace
    // and skips a key that names no served ns, so every variant id must stay
    // an installed section's namespace for the 0.1.5 cards to appear. (DSH
    // 0.1.6+ ignores that pairing — its Plugins page renders the bundle's
    // `plugins.bundle.config` entry by package name — and the Models page
    // joins on neither: no configurable-provider entry is made.)
    const served = new Set(ctx.settings.describe().map(entry => entry.ns))
    for (const variant of WorkBuddy.WORKBUDDY_VARIANTS) {
      expect(served, `variant "${variant.id}" must own a served settings namespace (its 0.1.5 card key and its fields)`).toContain(variant.id)
    }
    expect(served).toContain(WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)

    // Each section owns only its own fields, so one card's form cannot edit the
    // other's path. `describe()` reports a schemastery object schema; its
    // field map is `dict` — directly on the schema since schemastery 3.18.4,
    // where the older releases kept the root object in a `refs` graph keyed by
    // `uid`. Both spellings are read so this assertion holds across them.
    const fieldsOf = (ns: string): string[] => {
      const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
      const schema = descriptor?.schema as {
        dict?: Record<string, unknown>
        refs?: Record<string, { dict?: Record<string, unknown> }>
        uid?: number | string
      } | undefined
      if (schema?.dict !== undefined) return Object.keys(schema.dict)
      const root = schema?.refs?.[String(schema.uid)]
      return Object.keys(root?.dict ?? {})
    }
    expect(fieldsOf('workbuddy')).toContain('authFile')
    expect(fieldsOf('workbuddy')).not.toContain('authFileAI')
    expect(fieldsOf('workbuddy-ai')).toEqual(['authFileAI', 'useMaximumContextWindow'])

    // A write through one section must reach ONLY that variant's store. The
    // schema assertions above prove the two forms are split; this proves the
    // wiring behind them is too. Without it, a section could carry the right
    // field while `onChange` handed it to the wrong store and nothing above
    // would notice.
    //
    // Observable chosen deliberately: point `authFileAI` at a file holding a
    // CN-domain credential. If the write really reached the AI store, that
    // store refuses the cross-product credential and the AI group empties; the
    // CN group must be untouched. A mis-routed write would instead empty the
    // CN group — so the assertion distinguishes "reached the AI store" from
    // "reached some store".
    const wrongRegionForAi = join(root, 'cn-credential-for-ai.info')
    await writeFile(wrongRegionForAi, credentialDocument('copilot.tencent.com'))
    await ctx.settings.update('workbuddy-ai', { authFileAI: wrongRegionForAi })
    // A bounded settle rather than waitFor: if the wiring were broken the group
    // would simply never change, and an assertion states that plainly instead
    // of surfacing as a timeout. Two sweeps at the 100 ms interval above.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)

    // And the setting is genuinely read back through the merged config: putting
    // a valid international file back restores the group.
    await ctx.settings.update('workbuddy-ai', { authFileAI: aiFile })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    // The two variants must not share a roster: the international models are
    // not reachable through the CN provider, and vice versa. A shared fallback
    // list would misdescribe one of them (different rates, windows, and
    // declared efforts).
    const cn = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    const ai = (await ctx.llm.listModels('workbuddy-ai')).map(model => model.id)
    expect(cn).toContain('minimax-m3')
    expect(ai).not.toContain('minimax-m3')
    expect(ai).toContain('gpt-5.6-luna')
    expect(cn).not.toContain('gpt-5.6-luna')

    // The preference is on by default: a profile that never touched the setting
    // gets the largest declared window, and an explicit opt-out restores the
    // upstream's own default.
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    await ctx.settings.update('workbuddy-ai', { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour change the plan calls out: the CN provider used to
   * publish 15 fallback models to a signed-out user, which offered models that
   * could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-empty-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent-ai.info'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])

    // The provider is still registered: the group is hidden by having no
    // models, not by unregistering the adapter, so a later sign-in needs no
    // restart. (No configurable-provider directory entry is made, by design.)
    expect(ctx.llm.listProviders().map(provider => provider.id))
      .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
    // And the settings section is still there to explain how to sign in.
    expect(ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBeDefined()
  })

  /**
   * A credential for the other product is refused, and the refusal is what the
   * card shows. Silently treating it as "signed out" would send the user to
   * re-authenticate when the actual fix is a file path.
   */
  it('refuses a cross-product credential instead of using it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-cross-'))
    vi.stubEnv('DSH_HOME', root)
    // The CN file is handed to the international provider, which is exactly the
    // misconfiguration a user can produce with authFileAI / the env var.
    const crossFile = join(root, 'wrong.info')
    await writeFile(crossFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', crossFile)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    await ctx.plugin(WorkBuddy, {})

    const models = await (async () => {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-ai')
      })
      return ctx.llm.listModels('workbuddy-ai')
    })()
    // Refused, so the group stays hidden rather than serving a roster the token
    // cannot actually reach.
    expect(models).toEqual([])
  })

  /**
   * DSH 0.1.7 removed the provider-service section API this plugin's two
   * settings sections are built on. Losing the API must degrade to a
   * settings-less provider — providers and models still serve, no section is
   * installed, and nothing throws — not take the plugin down mid-inject.
   */
  it('degrades without the installSection API while still serving models', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-no-legacy-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const aiFile = join(root, 'ai.info')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    // Simulate the 0.1.7 settings service: the 0.1.2-era section API is gone.
    // (`installSection` is a prototype method on this provider, so a plain
    // assignment — not `delete` — is what hides it.)
    ;(ctx.settings as unknown as Record<string, unknown>)['installSection'] = undefined
    await ctx.plugin(WorkBuddy, {})

    // Both providers still register and the signed-in AI variant still serves
    // its fallback catalog.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id))
        .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
    })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })
    // …and neither legacy section was installed.
    const served = ctx.settings.describe().map(entry => entry.ns)
    expect(served).not.toContain('workbuddy')
    expect(served).not.toContain('workbuddy-ai')
  })

  it('uses the optional current fs service for image paths in both WorkBuddy variants', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-image-access-'))
    vi.stubEnv('DSH_HOME', root)
    const cnFile = join(root, 'cn.info')
    const aiFile = join(root, 'ai.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)

    const hostPath = 'C:\\Users\\Corrine Hu\\图片\\原图.png'
    const image = {
      attachmentId: 'sha256:test',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    const attachmentStore = {
      imageHostPath: () => hostPath,
      readImageRequest: async () => ({
        variantId: 'variant' as never,
        attachment: image,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }),
    }
    const sentBodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error('offline in tests')
    }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    ctx.provide('attachments', attachmentStore as never)
    await ctx.plugin(WorkBuddy, {})
    // Provider registration is NOT sufficient here: a variant's catalog starts
    // hidden until the credential sweep adopts an identity, so `glm-5.3` is
    // unresolvable right after registration and pi-ai's stream converts that
    // into a terminal finish chunk — the `for await` below then ends with zero
    // iterations and NO error, silently sending no request. Waiting for both
    // variants' catalogs to be visible is what actually guarantees a request.
    await vi.waitFor(async () => {
      expect(ctx.llm.listProviders().map(provider => provider.id))
        .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    const imageMessage = (offloaded = false) => ({
      id: 'image-test' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [
        { type: 'text' as const, text: 'describe' },
        { type: 'image' as const, attachment: image, ...(offloaded ? { offloaded: true as const } : {}) },
      ],
    } as never)
    const sendImage = async (provider: string, offloaded = false) => {
      for await (const _chunk of ctx.llm.stream({
        provider,
        model: 'glm-5.3',
        messages: [imageMessage(offloaded)],
      })) {
        // The captured HTTP request is the assertion boundary.
      }
    }
    const textFromRequest = (body: Record<string, unknown> | undefined): string => {
      const messages = body?.['messages'] as { content?: string | { text?: string }[] }[] | undefined
      return messages?.map(item => typeof item.content === 'string'
        ? item.content
        : item.content?.map(block => block.text ?? '').join('\n') ?? '').join('\n') ?? ''
    }

    await sendImage('workbuddy')
    const cnBody = sentBodies[0]
    const cnText = textFromRequest(cnBody)
    expect(cnText).not.toContain('Normalized copy (read-only;')
    expect(JSON.stringify(cnBody)).toContain('data:image/png;base64,AQID')

    let mappedPath = 'Z:\\WorkBuddy Data\\模型工具\\图像.png'
    ctx.provide('fs', {
      processPathFromHostPath: (path: string) => path === hostPath ? mappedPath : undefined,
    } as never)
    await sendImage('workbuddy')
    const mappedCnBody = sentBodies[1]
    const mappedCnText = textFromRequest(mappedCnBody)
    expect(mappedCnText).toContain(JSON.stringify(mappedPath))
    expect(JSON.stringify(mappedCnBody)).toContain('data:image/png;base64,AQID')

    await sendImage('workbuddy-ai')
    const aiBody = sentBodies[2]
    const aiText = textFromRequest(aiBody)
    expect(aiText).toContain(JSON.stringify(mappedPath))
    expect(aiText).not.toContain(hostPath)
    expect(JSON.stringify(aiBody)).toContain('data:image/png;base64,AQID')

    await sendImage('workbuddy-ai', true)
    const offloadedBody = sentBodies[3]
    const offloadedText = textFromRequest(offloadedBody)
    expect(offloadedText).toContain('image omitted to fit request image limits')
    expect(offloadedText).toContain(JSON.stringify(mappedPath))

    mappedPath = 'Z:\\new mapping.png'
    await sendImage('workbuddy-ai')
    const remappedBody = sentBodies[4]
    const remappedText = textFromRequest(remappedBody)
    expect(remappedText).toContain(JSON.stringify(mappedPath))
  })

  it('keeps the short handle when the fs service exists but maps nothing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-image-access-nomap-'))
    vi.stubEnv('DSH_HOME', root)
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)

    const hostPath = 'C:\\Users\\Corrine Hu\\图片\\原图.png'
    const image = {
      attachmentId: 'sha256:test',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    const attachmentStore = {
      imageHostPath: () => hostPath,
      readImageRequest: async () => ({
        variantId: 'variant' as never,
        attachment: image,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }),
    }
    const sentBodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error('offline in tests')
    }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', new MemorySettings())
    ctx.provide('attachments', attachmentStore as never)
    // The fs service is present — it just cannot map this host path.
    ctx.provide('fs', { processPathFromHostPath: () => undefined } as never)
    await ctx.plugin(WorkBuddy, {})
    // Registration is not enough — see the comment above: until the credential
    // sweep reveals this variant's catalog, `glm-5.3` does not resolve and the
    // stream ends with zero iterations and no error, sending nothing at all.
    await vi.waitFor(async () => {
      expect(ctx.llm.listProviders().map(provider => provider.id))
        .toEqual(expect.arrayContaining(['workbuddy']))
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })

    for await (const _chunk of ctx.llm.stream({
      provider: 'workbuddy',
      model: 'glm-5.3',
      messages: [{
        id: 'image-nomap-test' as never,
        role: 'user' as const,
        source: { kind: 'user' as const },
        content: [
          { type: 'text' as const, text: 'describe' },
          { type: 'image' as const, attachment: image },
        ],
      } as never],
    })) {
      // The captured HTTP request is the assertion boundary.
    }

    const body = sentBodies[0]
    const messages = body?.['messages'] as { content?: string | { text?: string }[] }[] | undefined
    const text = messages?.map(item => typeof item.content === 'string'
      ? item.content
      : item.content?.map(block => block.text ?? '').join('\n') ?? '').join('\n') ?? ''
    // An unmappable path degrades to the plain handle: no access text, and
    // the raw host path must not leak into the request.
    expect(text).not.toContain('Normalized copy (read-only;')
    expect(text).not.toContain(hostPath)
    expect(JSON.stringify(body)).toContain('data:image/png;base64,AQID')
  })
})
