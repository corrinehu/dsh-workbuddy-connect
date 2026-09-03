import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('WorkBuddy Host settings integration', () => {
  it('exposes the provider directory entry, the settings section, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      settingsNs: 'workbuddy',
      settingsPath: [],
      declared: false,
    })

    // The section is what the Models settings page joins on to render a card.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the newer
    // models the desktop app offers that older builds lacked.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name (and the advisory description)
    // so both the /model popup and the composer seat show it; the id and the
    // request path are untouched by this display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79')
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    // The rate lives on the name only: the /model popup renders name AND
    // description, so a description copy would display it twice there.
    // description instead carries the declared promo badges, when present.
    expect(byId.get('glm-5.2')?.description).toBe('夜间折扣')
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

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
  })

  it('registers one provider per configured account from the persisted settings scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-multi-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    // The persisted scope carries accounts, mirroring settings.yaml on a real
    // host: the raw plugin config stays empty and must not decide the mode.
    class SeededSettings extends MemorySettings {
      protected override load(): Promise<Record<string, unknown>> {
        return Promise.resolve({
          [WorkBuddy.WORKBUDDY_SETTINGS_NS]: { accounts: ['jmglsi', 'miaoniang'], defaultAccount: 'jmglsi' },
        })
      }
    }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SeededSettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      const ids = ctx.llm.listProviders().map(provider => provider.id)
      expect(ids).toContain('workbuddy:jmglsi')
      expect(ids).toContain('workbuddy:miaoniang')
    })
    // The legacy single-account provider must NOT be registered alongside.
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy')

    const jmglsi = ctx.llm.listProviders().find(provider => provider.id === 'workbuddy:jmglsi')
    expect(jmglsi?.name).toBe('WorkBuddy · jmglsi')

    const models = await ctx.llm.listModels('workbuddy:jmglsi')
    expect(models).toHaveLength(15)
    const resolved = await ctx.llm.resolveModelInfo('workbuddy:jmglsi', 'auto')
    // The exact-model metadata must echo the multi-account provider id: the
    // host drops a provider whose resolveModelInfo mismatches its registry id.
    expect(resolved.provider).toBe('workbuddy:jmglsi')
  })

  it('shows the snapshot nickname in the provider display name', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-nick-'))
    vi.stubEnv('DSH_HOME', root)
    // One imported snapshot whose credential carries a (non-ASCII) nickname.
    const authDir = join(root, '.workbuddy-auth')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'miaoniang.json'), JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3600_000,
        domain: 'www.workbuddy.cn', uid: 'uid-miao', source: 'dsh', nickname: '喵娘_认真看置顶',
      },
    }))
    const ctx = new Context()
    context = ctx
    class SeededSettings extends MemorySettings {
      protected override load(): Promise<Record<string, unknown>> {
        return Promise.resolve({
          [WorkBuddy.WORKBUDDY_SETTINGS_NS]: { accounts: ['miaoniang'] },
        })
      }
    }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SeededSettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy:miaoniang')
    })
    const provider = ctx.llm.listProviders().find(entry => entry.id === 'workbuddy:miaoniang')
    // The picker groups by display name: the snapshot nickname wins, the key
    // remains only the routing identity.
    expect(provider?.name).toBe('WorkBuddy · 喵娘_认真看置顶')
  })
})
