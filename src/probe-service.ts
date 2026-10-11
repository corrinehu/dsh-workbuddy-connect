/**
 * Probe orchestration: the serial queue, the consent gate, and the bridge from
 * an observation to what the adapter may expose.
 *
 * Kept separate from {@link module:dsh-workbuddy-connect/probe} so the protocol
 * stays a pure function of one model's responses, while queueing, persistence,
 * and policy live here. Two rules from `docs/reasoning-effort-probe-plan.md`
 * §3.3 are structural rather than advisory:
 *
 * - one probe at a time (a user's real chat must not contend with a sweep),
 * - nothing at all happens without explicit consent.
 *
 * @module dsh-workbuddy-connect/probe-service
 */

import type { WorkBuddyCredentialSource } from './pool-store.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { probeModel, type ProbeRegion, type ProbeSender, type SentinelFactory } from './probe.ts'
import { fingerprintModel, type WorkBuddyProbeRecord, type WorkBuddyProbeStore } from './probe-store.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

/** What the caller learns about a completed probe. */
export type WorkBuddyProbeStatus =
  | { state: 'ok'; validation: WorkBuddyProbeRecord['validation']; efforts: readonly string[]; requests: number }
  | { state: 'unavailable'; reason: string }

/** Options for {@link WorkBuddyProbeService}. */
export interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore
  catalog: WorkBuddyCatalog
  credentials: WorkBuddyCredentialSource
  client: WorkBuddyUpstreamClient
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took. The
   * store's per-account keying alone cannot catch that, because an in-flight
   * probe completes *after* the switch has already happened.
   */
  account: () => string | undefined
  sentinel?: SentinelFactory
  /**
   * Which endpoint's rejection vocabulary sweeps read. The two apps talk to
   * different upstreams that answer a bad effort with different codes, so each
   * runtime passes its own region instead of sharing one widening set.
   */
  region: ProbeRegion
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender
}

/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
export class WorkBuddyProbeService {
  private readonly options: WorkBuddyProbeServiceOptions
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Promise<WorkBuddyProbeStatus>>()
  private running = false

  constructor(options: WorkBuddyProbeServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * Applies the plan's precedence (§5): a declared set always wins, so a model
   * that declares `supportedEfforts` is never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined {
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return undefined
    if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) {
      return undefined
    }
    const account = this.options.account()
    // Signed out: there is no account to attribute an observation to, so none
    // is served (a previous account's record must not answer here).
    if (account === undefined) return undefined
    return this.options.store.get(modelId, fingerprintModel(info), account)
  }

  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  async probe(modelId: string, manualConsent = false): Promise<WorkBuddyProbeStatus> {
    if (!manualConsent && !this.options.consent()) {
      return { state: 'unavailable', reason: 'probing is not authorized' }
    }
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
    const account = this.options.account()
    if (account === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }
    const pendingKey = JSON.stringify([account, modelId])
    const pending = this.pending.get(pendingKey)
    if (pending !== undefined) return pending

    const run = this.queue.then(async (): Promise<WorkBuddyProbeStatus> => {
      // Re-read inside the queue: an earlier sweep may have changed the catalog
      // or already answered this model.
      const current = this.options.catalog.current().find(model => model.id === modelId)
      if (current === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
      if (!manualConsent && !this.options.consent()) {
        return { state: 'unavailable', reason: 'probing is not authorized' }
      }
      if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) {
        return { state: 'unavailable', reason: 'model does not need detection' }
      }
      const cached = this.recordFor(modelId)
      if (!manualConsent && cached !== undefined && cached.validation !== 'unknown') {
        return { state: 'ok', validation: cached.validation, efforts: cached.efforts, requests: 0 }
      }

      // The account this sweep is being run for. Captured before the requests
      // and re-checked before the write-back: a probe can outlive the account
      // it started under (a switch, or a manual refresh, clears records while
      // the sweep is still talking to the upstream), and storing the result
      // afterwards would resurrect the previous account's answer.
      const activeAccount = this.options.account()
      if (activeAccount !== account) return { state: 'unavailable', reason: 'account changed before detection' }
      const credential = await this.options.credentials.current()
      if (credential === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

      const send = this.options.send === undefined
        ? (effort: string | undefined, signal: AbortSignal) =>
            this.options.client.probeEffort(credential, modelId, effort, signal)
        : this.options.send(modelId)

      this.running = true
      try {
        const outcome = await probeModel({
          send,
          region: this.options.region,
          ...this.options.sentinel === undefined ? {} : { sentinel: this.options.sentinel },
        })
        // The account may have changed while the requests were in flight. Drop
        // the observation rather than attribute it to whoever is signed in now.
        if (this.options.account() !== account) {
          return { state: 'unavailable', reason: 'account changed during detection' }
        }
        const record = this.options.store.record(
          fingerprintModel(current),
          outcome.validation,
          outcome.efforts,
          account,
        )
        this.options.store.set(modelId, record)
        if (outcome.validation === 'unknown') {
          return { state: 'unavailable', reason: outcome.reason }
        }
        return { state: 'ok', validation: outcome.validation, efforts: record.efforts, requests: outcome.requests }
      } finally {
        this.running = false
      }
    })

    // Keep the chain alive regardless of this run's outcome, so one failure does
    // not poison every later probe.
    this.queue = run.catch(() => undefined)
    this.pending.set(pendingKey, run)
    try {
      return await run
    } finally {
      this.pending.delete(pendingKey)
    }
  }
}
