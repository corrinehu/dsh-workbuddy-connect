import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { FakeSettings } from './fake-settings.ts'

/**
 * Host settings integration: the plugin's configuration and its namespace
 * under DSH 0.1.7's entry-keyed settings model.
 *
 * The seam changed shape in 0.1.7. A plugin no longer installs a settings
 * section under a name of its own choosing; `settings.describe()` projects the
 * volatile fields of every live profile entry, keyed by that entry's id, and a
 * write is committed into the running plugin's live references. What this
 * plugin must therefore get right is narrower and more concrete than before:
 * its fields must be volatile (or nothing can edit them), the namespace it
 * hands the provider directory and writes through must be its own entry id, and
 * a committed value must reach the derived state that was built from it.
 *
 * {@link FakeSettings} drives the real commit protocol so these cases assert
 * the plugin's actual reaction rather than a mock's.
 */

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
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * The fields a settings surface can offer, read off the plugin's own schema.
 *
 * This is the contract that replaced `installSection`: the Loader projects the
 * entry's `Config` schema, and only fields that resolve to a live reference are
 * editable. A field that regressed to a plain value would silently disappear
 * from every settings surface rather than failing loudly, so it is asserted
 * here instead.
 */
function volatileFields(): string[] {
  const resolved: Record<string, unknown> = WorkBuddy.Config({})
  return Object.entries(resolved)
    .filter(([, value]) => isVolatile(value))
    .map(([key]) => key)
    .sort()
}

/** Boot the plugin against a stubbed Host and hand back its settings double. */
async function boot(options: Record<string, unknown> = {}): Promise<{ ctx: Context; settings: FakeSettings; fiber: Fiber }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSettings)
  const settings = ctx.settings as unknown as FakeSettings
  const fiber = await ctx.plugin(WorkBuddy, options)
  // The Host binds a namespace to the entry that owns it; a bare Context has no
  // Loader, so the plugin falls back to the entry id its own patch declares.
  settings.bind(WorkBuddy.WORKBUDDY_ENTRY_ID, { config: fiber.config, ctx: fiber.ctx })
  return { ctx, settings, fiber }
}

describe('WorkBuddy Host settings integration', () => {
  it('applies the maximum-window preference and follows a live write without remounting', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-context-preference-'))
    const aiFile = join(root, 'ai.info')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const { ctx, settings } = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })
    // Fresh profile, setting never touched: the schema default is on, so the
    // model resolves at its largest declared window.
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)

    // A settings write reaches the plugin as a volatile commit. The reference
    // changes in place, so the catalog — which is derived state rather than a
    // per-request read — has to be re-applied from the new value.
    const accepted = await settings.update(WorkBuddy.WORKBUDDY_ENTRY_ID, { useMaximumContextWindow: false })
    expect(accepted).toBeUndefined()
    expect(settings.writes).toEqual([
      { ns: WorkBuddy.WORKBUDDY_ENTRY_ID, patch: { useMaximumContextWindow: false } },
    ])
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
    // Still one live registration: the commit must not have remounted the
    // plugin, because a remount would drop the loopback endpoint and with it
    // every in-flight session's route.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(
      expect.arrayContaining(['workbuddy', 'workbuddy-ai']),
    )
  })

  it('honors a preference supplied as configuration, not only as a later write', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-context-config-'))
    const aiFile = join(root, 'ai.info')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    // An explicit opt-out arrives through the profile patch, which is the
    // durable half of the same form; it is applied before any model resolves.
    const { ctx } = await boot({ useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    // Flipping it on afterwards is the live half, and must be reversible.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_ENTRY_ID, { useMaximumContextWindow: true })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    })
  })

  it('serves its own entry as the settings namespace and declares every field volatile', async () => {
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
    // fail rather than depending on the remote.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const { ctx } = await boot()

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    // The directory entry names the plugin's OWN entry id as its namespace:
    // that id is the key `settings.describe()` publishes the form under, and
    // what the Models settings page joins on to render the configuration.
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      settingsNs: WorkBuddy.WORKBUDDY_ENTRY_ID,
      settingsPath: [],
      declared: false,
    })
    expect(WorkBuddy.WORKBUDDY_ENTRY_ID).toBe('llm-workbuddy')

    // Everything the form can edit is volatile. A field that is not would be
    // missing from `settings.describe()` entirely, so this is what "the plugin
    // is configurable" now means.
    expect(volatileFields()).toEqual(['authFile', 'authFileAI', 'probeConsent', 'useMaximumContextWindow'])

    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the models
    // the product document lists that the console catalog used to withhold.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name so both the /model popup and the
    // composer seat show it; the id and the request path are untouched by this
    // display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79 · 夜间折扣')
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    expect(byId.get('glm-5.2')?.description).toBeUndefined()
    expect(byId.get('glm-5.3')?.description).toBeUndefined()

    // Thinking controls are declared-set-only: models whose upstream row
    // carries `supportedEfforts` expose exactly those efforts; rows without a
    // list (the older `{effort, summary}` shape) expose no control at all, so
    // requests never carry `reasoning_effort` for them and the upstream
    // default applies — matching the desktop app's own per-model gating.
    const autoResolved = await ctx.llm.resolveModelInfo('workbuddy', 'auto')
    expect(autoResolved.reasoning).toBeUndefined()
    const flashResolved = await ctx.llm.resolveModelInfo('workbuddy', 'glm-5.3-flash')
    expect(flashResolved.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low', 'max', 'off'])

    // Image modalities follow the per-model catalog flag (fallback list here):
    // image-capable entries expose `image`, glm-5.1 stays text-only.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('glm-5.1')).toEqual(['text'])
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants against one namespace and keeps each variant identity separate', async () => {
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

    const { ctx, settings } = await boot()

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
        expect.arrayContaining(['workbuddy', 'workbuddy-ai']),
      )
    })

    // Each provider carries its own display name — the model group heading the
    // picker renders — and both join the ONE namespace this plugin owns. Since
    // 0.1.7 a namespace IS a profile entry id, and one plugin is one entry, so
    // per-variant namespaces are no longer expressible; the per-variant split
    // moved into the fields (`authFile` / `authFileAI`).
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      {
        provider: 'workbuddy',
        displayName: 'WorkBuddy',
        settingsNs: WorkBuddy.WORKBUDDY_ENTRY_ID,
        settingsPath: [],
        declared: false,
      },
      {
        provider: 'workbuddy-ai',
        displayName: 'WorkBuddy AI',
        settingsNs: WorkBuddy.WORKBUDDY_ENTRY_ID,
        settingsPath: [],
        declared: false,
      },
    ]))

    // A write through one field must reach ONLY that variant's store. The
    // schema assertions above prove both paths exist; this proves the wiring
    // behind them is split. Without it, `authFileAI` could carry the right
    // value while the sweep handed it to the wrong store, and nothing above
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
    await settings.update(WorkBuddy.WORKBUDDY_ENTRY_ID, { authFileAI: wrongRegionForAi })
    // A bounded settle rather than waitFor: if the wiring were broken the group
    // would simply never change, and an assertion states that plainly instead
    // of surfacing as a timeout. Two sweeps at the 100 ms interval above.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)

    // And the setting is genuinely read back through the live reference:
    // putting a valid international file back restores the group.
    await settings.update(WorkBuddy.WORKBUDDY_ENTRY_ID, { authFileAI: aiFile })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
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
    const { ctx } = await boot()

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
    // And the plugin is still configurable, which is what lets the user point
    // it at the right auth file from the UI.
    expect(volatileFields()).toContain('authFile')
  })

  /**
   * A credential for the other product is refused, and the refusal is what the
   * page shows. Silently treating it as "signed out" would send the user to
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
    const { ctx } = await boot()

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
})
