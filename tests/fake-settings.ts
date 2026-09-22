/**
 * The Host settings seam, reduced to the contract this plugin depends on.
 *
 * DSH 0.1.7 keys a settings form by profile entry id and derives it from the
 * entry's own `Config` schema. Editing a field no longer installs or reloads
 * anything: the Loader parses the changed raw config, commits each volatile
 * field into the reference the running plugin already holds, and announces the
 * commit as `loader/volatile-update` on the owning fiber alone. The plugin is
 * never remounted, which is exactly why it reads configuration through
 * {@link Volatile} references instead of capturing a plain object.
 *
 * Driving the real Loader here would mean composing the whole boot layer
 * (loader + profile context + config editor + settings), so these tests drive
 * the same three things the Loader does, in the same order, against the same
 * public helpers the Loader itself uses:
 *
 * 1. `updateVolatile` commits a value into the reference the plugin holds.
 * 2. `loader/volatile-update` is emitted on the plugin's own context.
 * 3. `settings.configure` / `settings.update` are the two calls the plugin makes.
 *
 * Everything else about the seam — persistence into the profile patch, schema
 * validation before the commit, revision fencing — belongs to DSH and is not
 * this plugin's behaviour to test.
 *
 * @module tests/fake-settings
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

/** One plugin instance's settings namespace, bound so writes can reach it. */
export interface FakeSettingsTarget {
  /** The plugin's resolved config: the object holding its volatile references. */
  config: object
  /** The plugin's own context, the only one a volatile commit is announced to. */
  ctx: Context
}

/** One accepted write, for assertions about what the plugin asked the Host for. */
export interface FakeSettingsWrite {
  ns: string
  patch: Record<string, unknown>
}

/** One registered page policy, for assertions about the plugin's own page. */
export interface FakeSettingsPolicy {
  auto: boolean | undefined
  owner: unknown
}

/**
 * A `settings` service implementing exactly the surface this plugin uses.
 *
 * `update` commits into the bound config's volatile references and emits the
 * commit event, so a test asserts the plugin's real reaction rather than a
 * mocked one. A namespace with no binding rejects the write, which is the
 * Host's own answer for an entry that is not configurable.
 */
export class FakeSettings extends Service {
  private readonly targets = new Map<string, FakeSettingsTarget>()

  /** Accepted writes in call order. */
  readonly writes: FakeSettingsWrite[] = []
  /** Page policies registered through `configure`, in call order. */
  readonly policies: FakeSettingsPolicy[] = []
  /** Namespaces whose writes are refused, for the failure path. */
  readonly refused = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /** Point one namespace at the plugin instance that owns it. */
  bind(ns: string, target: FakeSettingsTarget): void {
    this.targets.set(ns, target)
  }

  /** Record a page policy the way the Host does; the policy only disables auto-generation. */
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
    const policy: FakeSettingsPolicy = { auto: presentation.auto, owner }
    this.policies.push(policy)
    return () => {
      const index = this.policies.indexOf(policy)
      if (index >= 0) this.policies.splice(index, 1)
    }
  }

  /** Merge a patch into a bound plugin's volatile references and announce the commit. */
  update(ns: string, patch: Record<string, unknown>): Promise<void> {
    if (this.refused.has(ns)) {
      return Promise.reject(new Error(`No configurable plugin entry "${ns}"`))
    }
    const target = this.targets.get(ns)
    if (target === undefined) {
      return Promise.reject(new Error(`No configurable plugin entry "${ns}"`))
    }
    this.writes.push({ ns, patch: structuredClone(patch) })
    const paths = commitVolatile(target.config, patch)
    target.ctx.emit('loader/volatile-update', paths)
    return Promise.resolve()
  }
}

/**
 * Commit each patched field into the corresponding volatile reference.
 *
 * A field the schema did not declare volatile cannot be committed — the Loader
 * refuses such an edit before this point — so hitting one here is a real
 * contract violation and throws instead of being skipped.
 */
function commitVolatile(config: object, patch: Record<string, unknown>): string[][] {
  const paths: string[][] = []
  for (const [key, value] of Object.entries(patch)) {
    const ref: unknown = Reflect.get(config, key)
    if (!isVolatile(ref)) {
      throw new Error(`config field "${key}" is not volatile, so no live edit can reach it`)
    }
    updateVolatile(ref, createVolatile(value))
    paths.push([key])
  }
  return paths
}
