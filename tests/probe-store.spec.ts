import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.ts'
import { fingerprintModel, newestFirst, WorkBuddyProbeStore } from '../src/probe-store.ts'
import { WorkBuddyProbeService } from '../src/probe-service.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * Offline tests for the probe record and its precedence rules
 * (`docs/reasoning-effort-probe-plan.md` §5): an observation is invalidated by
 * a catalog change, expires, never overrides a declared set, and is never
 * erased by a transient failure.
 */

const CLEANUP: string[] = []

afterEach(() => {
  for (const path of CLEANUP.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempStore(now?: () => number): { store: WorkBuddyProbeStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-probe-'))
  CLEANUP.push(dir)
  const path = join(dir, 'probe.json')
  return { store: new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9', ...now === undefined ? {} : { now } }), path, dir }
}

/**
 * The fallback catalog's old-form row, which declares no effort set.
 *
 * Was `auto` until the roster moved to the product document's `cli` list, which
 * no longer offers it — `glm-5.3` is the same shape (reasoning, but no declared
 * effort set and no "thinking off"), so the cases below keep testing what they
 * meant to.
 */
const UNDECLARED = FALLBACK_WORKBUDDY_MODELS.find(model => model.id === 'glm-5.3') as WorkBuddyModelInfo
/** The fallback catalog's new-form row, which declares one. */
const DECLARED = FALLBACK_WORKBUDDY_MODELS.find(model => model.id === 'glm-5.3-flash') as WorkBuddyModelInfo

/** The account these observations are attributed to. */
const ACCOUNT = 'uid-1:ent-1'

describe('fingerprintModel', () => {
  it('is stable for the same row and changes when the reasoning object changes', () => {
    const before = fingerprintModel(UNDECLARED)
    expect(fingerprintModel(UNDECLARED)).toBe(before)

    const changed: WorkBuddyModelInfo = {
      ...UNDECLARED,
      reasoning: { ...UNDECLARED.reasoning!, defaultEffort: 'low' },
    }
    expect(fingerprintModel(changed)).not.toBe(before)
  })

  it('ignores display-only fields so a rename does not discard an observation', () => {
    const renamed: WorkBuddyModelInfo = { ...UNDECLARED, name: 'GLM-5.3 (renamed)' }
    expect(fingerprintModel(renamed)).toBe(fingerprintModel(UNDECLARED))
  })
})

describe('WorkBuddyProbeStore', () => {
  it('round-trips a record through disk', () => {
    const { store, path } = tempStore()
    const fingerprint = fingerprintModel(UNDECLARED)
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['low', 'high'], ACCOUNT))

    const reopened = new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9' })
    const record = reopened.get('glm-5.3', fingerprint, ACCOUNT)
    expect(record?.validation).toBe('validating')
    expect(record?.efforts).toEqual(['low', 'high'])
    expect(record?.pluginVersion).toBe('9.9.9')
  })

  it('refuses a record whose fingerprint no longer matches', () => {
    const { store } = tempStore()
    store.set('glm-5.3', store.record(fingerprintModel(UNDECLARED), 'validating', ['low'], ACCOUNT))
    expect(store.get('glm-5.3', fingerprintModel(UNDECLARED), ACCOUNT)).toBeDefined()
    expect(store.get('glm-5.3', 'a-different-fingerprint', ACCOUNT)).toBeUndefined()
  })

  it('expires a record past the TTL', () => {
    let now = 1_000_000
    const { store } = tempStore(() => now)
    const fingerprint = fingerprintModel(UNDECLARED)
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['low'], ACCOUNT))
    expect(store.get('glm-5.3', fingerprint, ACCOUNT)).toBeDefined()

    now += 15 * 24 * 60 * 60 * 1000
    expect(store.get('glm-5.3', fingerprint, ACCOUNT)).toBeUndefined()
  })

  it('never stores efforts for a non-validating observation', () => {
    const { store } = tempStore()
    const record = store.record(fingerprintModel(UNDECLARED), 'non-validating', ['low', 'high'], ACCOUNT)
    expect(record.efforts).toEqual([])
  })

  it('does not let an unknown result erase a decisive one', () => {
    const { store } = tempStore()
    const fingerprint = fingerprintModel(UNDECLARED)
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['low'], ACCOUNT))
    store.set('glm-5.3', store.record(fingerprint, 'unknown', [], ACCOUNT))

    const kept = store.get('glm-5.3', fingerprint, ACCOUNT)
    expect(kept?.validation).toBe('validating')
    expect(kept?.efforts).toEqual(['low'])
  })

  it('does let a decisive result replace a previous unknown', () => {
    const { store } = tempStore()
    const fingerprint = fingerprintModel(UNDECLARED)
    store.set('glm-5.3', store.record(fingerprint, 'unknown', [], ACCOUNT))
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['high'], ACCOUNT))
    expect(store.get('glm-5.3', fingerprint, ACCOUNT)?.efforts).toEqual(['high'])
  })

  it('reads a corrupt or foreign-version file as empty rather than throwing', () => {
    const { store, path } = tempStore()
    store.set('glm-5.3', store.record(fingerprintModel(UNDECLARED), 'validating', ['low'], ACCOUNT))
    expect(store.all()[ACCOUNT]).toHaveProperty('glm-5.3')

    // A format version this reader does not know must not be half-understood.
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    document['version'] = 999
    writeFileSync(path, JSON.stringify(document))
    expect(new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9' }).all()).toEqual({})

    // Garbage on disk reads as empty too, rather than taking the plugin down.
    writeFileSync(path, '{ not json')
    expect(new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9' }).all()).toEqual({})
  })

  it('reads the version-1 flat format as empty rather than half-understanding it', () => {
    const { path } = tempStore()
    // What v0.5.x used to write: one flat record per model, no account level.
    writeFileSync(path, JSON.stringify({
      version: 1,
      records: {
        'glm-5.3': {
          fingerprint: fingerprintModel(UNDECLARED),
          validation: 'validating',
          efforts: ['low'],
          probedAtMs: Date.now(),
          pluginVersion: '9.9.9',
          account: ACCOUNT,
        },
      },
    }))
    const reopened = new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9' })
    expect(reopened.get('glm-5.3', fingerprintModel(UNDECLARED), ACCOUNT)).toBeUndefined()
    expect(reopened.all()).toEqual({})
  })

  it('keeps each account\'s record isolated and recovers it after a switch back', () => {
    const { store, path } = tempStore()
    const fingerprint = fingerprintModel(UNDECLARED)
    const OTHER = 'uid-2:'
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['low'], ACCOUNT))

    // The other account sees nothing of this one's...
    expect(store.get('glm-5.3', fingerprint, OTHER)).toBeUndefined()
    // ...and its own write does not clobber what this account recorded.
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['max'], OTHER))
    expect(store.get('glm-5.3', fingerprint, ACCOUNT)?.efforts).toEqual(['low'])
    expect(store.get('glm-5.3', fingerprint, OTHER)?.efforts).toEqual(['max'])

    // A→B→A through a reopen, as a restart would see it.
    const reopened = new WorkBuddyProbeStore({ path, pluginVersion: '9.9.9' })
    expect(reopened.get('glm-5.3', fingerprint, OTHER)?.efforts).toEqual(['max'])
    expect(reopened.get('glm-5.3', fingerprint, ACCOUNT)?.efforts).toEqual(['low'])
  })

  it('clears every record of every account on request', () => {
    const { store } = tempStore()
    const fingerprint = fingerprintModel(UNDECLARED)
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['low'], ACCOUNT))
    store.set('glm-5.3', store.record(fingerprint, 'validating', ['max'], 'uid-2:'))
    store.clear()
    expect(store.all()).toEqual({})
    expect(store.get('glm-5.3', fingerprint, ACCOUNT)).toBeUndefined()
    expect(store.get('glm-5.3', fingerprint, 'uid-2:')).toBeUndefined()
  })
})

describe('WorkBuddyProbeService precedence', () => {
  /** Minimal service with a caller-supplied consent answer. */
  function service(options: { consent: boolean; stored?: boolean }): WorkBuddyProbeService {
    const { store } = tempStore()
    const catalog = new WorkBuddyCatalog()
    if (options.stored === true) {
      store.set('glm-5.3', store.record(fingerprintModel(UNDECLARED), 'validating', ['low', 'high'], ACCOUNT))
    }
    return new WorkBuddyProbeService({
      store,
      catalog,
      credentials: { current: async () => undefined } as never,
      client: {} as never,
      consent: () => options.consent,
      account: () => ACCOUNT,
    })
  }

  it('never answers from an observation when the upstream declares a set', () => {
    const probe = service({ consent: true, stored: true })
    // `glm-5.3` declares supportedEfforts, so it is declared-set-only.
    expect(probe.recordFor(DECLARED.id)).toBeUndefined()
  })

  it('returns the stored observation for an undeclared model', () => {
    const probe = service({ consent: true, stored: true })
    expect(probe.recordFor(UNDECLARED.id)?.efforts).toEqual(['low', 'high'])
  })

  it('refuses to probe without consent', async () => {
    const probe = service({ consent: false })
    const status = await probe.probe('glm-5.3')
    expect(status.state).toBe('unavailable')
    expect(status.state === 'unavailable' && status.reason).toContain('not authorized')
  })
})

describe('newestFirst', () => {
  it('puts the most recent observation first', () => {
    // The store appends, so a just-run detection would otherwise land below
    // every earlier one — the exact complaint this helper exists to fix.
    const ordered = newestFirst([
      { probedAt: 100, id: 'oldest' },
      { probedAt: 300, id: 'newest' },
      { probedAt: 200, id: 'middle' },
    ])
    expect(ordered.map(entry => entry.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('does not mutate its input', () => {
    const input = [{ probedAt: 1 }, { probedAt: 2 }]
    newestFirst(input)
    expect(input.map(entry => entry.probedAt)).toEqual([1, 2])
  })
})

describe('recordFor: the single judgement the card and adapter share', () => {
  /**
   * The card used to read raw records while the adapter read fingerprint- and
   * TTL-checked ones, so the card could show levels the model picker no longer
   * offered. Both now go through `recordFor`, and these pin what it refuses.
   */
  function serviceFor(store: WorkBuddyProbeStore): WorkBuddyProbeService {
    return new WorkBuddyProbeService({
      store,
      catalog: new WorkBuddyCatalog(),
      credentials: { current: async () => undefined } as never,
      client: {} as never,
      consent: () => true,
      account: () => ACCOUNT,
    })
  }

  it('refuses a record whose catalog row changed', () => {
    const { store } = tempStore()
    const service = serviceFor(store)
    // Recorded against a fingerprint that no longer describes the row.
    store.set('glm-5.3', store.record('stale-fingerprint', 'validating', ['low'], ACCOUNT))
    expect(service.recordFor('glm-5.3')).toBeUndefined()
  })

  it('refuses an expired record even though the store still holds it', () => {
    let now = 1_000_000
    const { store } = tempStore(() => now)
    const service = serviceFor(store)
    store.set('glm-5.3', store.record(fingerprintModel(UNDECLARED), 'validating', ['low'], ACCOUNT))
    expect(service.recordFor('glm-5.3')?.efforts).toEqual(['low'])

    now += 15 * 24 * 60 * 60 * 1000
    // Past the TTL the card must stop reporting it, exactly as the adapter does.
    expect(service.recordFor('glm-5.3')).toBeUndefined()
  })

  it('refuses a record for a model the catalog no longer lists', () => {
    const { store } = tempStore()
    const service = serviceFor(store)
    // A row recorded for an id the upstream has since dropped.
    store.set('retired-model', store.record('whatever', 'validating', ['low'], ACCOUNT))
    expect(service.recordFor('retired-model')).toBeUndefined()
  })
})
