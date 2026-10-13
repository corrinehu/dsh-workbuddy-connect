/**
 * Same-origin status route for the WorkBuddy plugin card: sign-in state,
 * token expiry, and remaining credit, fetched by the browser half. The route
 * answers loopback browser requests only and never carries token material.
 *
 * @module dsh-workbuddy-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebStatus, WorkBuddyWebVisibilitySection } from './status-paths.ts'
import type { CreditLedger } from './credit-ledger.ts'

export { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  /** Resolve the current model catalog for free/badge display. */
  models: () => readonly WorkBuddyModelInfo[]
  /**
   * Compact probe state for the card. Optional so the status route keeps
   * working on its own in tests and headless profiles.
   */
  probe?: () => WorkBuddyWebProbeSection
  /**
   * Origin of the currently served model list. Optional so the status route
   * keeps working without one in tests and headless profiles.
   */
  catalog?: () => WorkBuddyWebCatalog | undefined
  /** In-process key authorizing probe control writes. */
  probeKey?: string
  /**
   * International-card preference selecting larger declared context windows.
   * The getter may answer `undefined` when this host cannot persist the
   * preference (a 0.1.7 settings service has no section API): the field then
   * stays out of the document, and the card renders no control for it.
   */
  useMaximumContextWindow?: () => boolean | undefined
  /**
   * Per-account hidden-model state for the card's visibility controls.
   * Undefined when the caller offers none (tests, headless profiles); a
   * defined getter may still answer undefined — a signed-in account without a
   * stable uid has no bucket to key preferences by, and the card then renders
   * no visibility controls rather than a list every such account would share.
   */
  visibility?: () => WorkBuddyWebVisibilitySection | undefined
  /**
   * Route path to mount. Defaults to the CN variant's path so existing callers
   * and tests keep their behaviour; the international variant passes its own.
   */
  path?: string
  /**
   * Per-turn credit accounting for the composer badge.
   *
   * Optional so the status route keeps working on its own in tests and
   * headless profiles — without it the document simply carries no
   * `turnSpend`, which is the same shape as a first read.
   */
  ledger?: CreditLedger
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback);
 * the card's same-origin fetches carry no Origin and pass on Host alone.
 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 *
 * @param deps - the routes' shared dependencies.
 * @param sessionId - the session the read was made for, when the caller named
 *   one. It both attributes the drop this read reveals and selects the turn
 *   list that comes back; see {@link workBuddyWebStatus} callers.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
  sessionId?: string,
): Promise<WorkBuddyWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') {
    // A diagnosable sign-out (a credential for the *other* product, or an
    // unusable key helper) keeps its explanation: falling back to the generic
    // hint would tell the user to sign in when the real fix is to correct a
    // path or point the plugin at the app. `reasonCode` rides along so the
    // card can branch on the cause without reading the prose.
    //
    // This branch deliberately does not run `safeMessage`: the reason is
    // produced by the store and is expected to be a short, path-only
    // diagnosis, so any new failure path added here must keep credentials,
    // payloads and subprocess output out of its own message.
    return {
      status: 'signed-out',
      ...authStatus.reason === undefined ? {} : { reason: authStatus.reason },
      ...authStatus.reasonCode === undefined ? {} : { reasonCode: authStatus.reasonCode },
    }
  }
  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
  }
  // Model facts ride the signed-in document so the card can show rates,
  // promos, and context capacity without touching the Models picker. The rate
  // is normalized here (not in the card) so both halves agree on one display
  // form; the card additionally localizes it.
  //
  // The card receives *every* model, not just the discounted ones: context
  // capacity is exactly the fact a user wants before picking a model, and the
  // models where it matters most (a 200k model beside 1M siblings) are
  // precisely the ones with no promo attached. The discount section filters
  // what it renders.
  const models = deps.models()
  const modelsField: readonly WorkBuddyWebModelBadge[] = models
    .map(model => {
      const rate = normalizeCredits(model.billing?.credits)
      // The largest window the upstream declares for this model, when it
      // declares alternatives; equal to `contextWindow` otherwise, and omitted
      // when the upstream said nothing.
      const supported = model.supportedContextWindows ?? []
      const maxContextWindow = supported.length > 0 ? Math.max(...supported) : undefined
      const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow
      return {
        id: model.id,
        name: model.name,
        ...model.billing?.free === true ? { free: true as const } : {},
        ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
        ...rate === undefined ? {} : { credits: rate },
        // The rate is deliberately withheld for a row whose price cannot be
        // vouched for (a promotion that has ended but is still baked into the
        // cached row): the card then says the price needs a refresh instead of
        // repeating a stale figure or implying the model is free.
        ...model.billing?.rateUnknown === true ? { rateUnknown: true as const } : {},
        // Verbatim from the upstream catalog; omitted when it said nothing.
        ...typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? { contextWindow: model.contextWindow }
          : {},
        ...typeof defaultContextWindow === 'number' && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow
          ? { defaultContextWindow }
          : {},
        ...maxContextWindow === undefined || maxContextWindow <= defaultContextWindow
          ? {}
          : { maxContextWindow },
        ...typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0
          ? { maxInputTokens: model.maxInputTokens }
          : {},
      }
    })
  // Catalog provenance rides the document even when the model list is empty:
  // "no models" is precisely the case a user needs explained, and it is the
  // only way to tell a hidden group from a failed fetch.
  const catalog = deps.catalog?.()
  const withCatalog: WorkBuddyWebStatus = catalog === undefined ? status : { ...status, catalog }
  // Visibility rides the document beside the model list it qualifies. Absent
  // when no account-with-uid is in effect; the card keys its controls on the
  // section's presence.
  const visibility = deps.visibility?.()
  const withVisibility: WorkBuddyWebStatus = visibility === undefined ? withCatalog : { ...withCatalog, visibility }
  const statusWithModels: WorkBuddyWebStatus = modelsField.length > 0
    ? { ...withVisibility, models: modelsField }
    : withVisibility
  // Probe state rides the signed-in document so the card can render the
  // consent switches and results without a second request. The control key
  // travels with it: this response already passed the loopback guard, and the
  // key authorizes only probe control, never credentials or completions.
  let probed: WorkBuddyWebStatus = statusWithModels
  if (deps.probe !== undefined) {
    // The preference is offered only when the getter can answer a value; a
    // host that cannot persist it answers `undefined` and the field stays out
    // of this document, which is the card's signal not to render the control.
    const maximumContextWindow = deps.useMaximumContextWindow?.()
    probed = {
      ...statusWithModels,
      probe: deps.probe(),
      ...deps.probeKey === undefined ? {} : { probeKey: deps.probeKey },
      ...maximumContextWindow === undefined ? {} : { useMaximumContextWindow: maximumContextWindow },
    }
  }
  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      // The per-turn delta is computed from THIS read against the previous one,
      // so the ledger sees every balance the route answers with — a manual ↻,
      // a mount fetch, and the trailing read after a probe all count. A reply
      // priced by whichever read happens to bracket it is the only honest
      // accounting available for a subscription quota.
      const spend = deps.ledger?.observe({
        ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
        ...authStatus.domain === undefined ? {} : { domain: authStatus.domain },
        ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
        ...credential.uid === undefined ? {} : { uid: credential.uid },
      }, credits, sessionId)
      // The turn list is the transcript footer's view: one figure per turn,
      // newest last, so a finished reply keeps showing its own cost after later
      // replies have been priced. It is absent — not empty — when the read
      // named no session, because "you did not ask" and "there is nothing yet"
      // are different answers and the footer only ever means the latter.
      const turns = sessionId === undefined || deps.ledger === undefined
        ? undefined
        : deps.ledger.turnSpends(sessionId)
      // `unlimited` and `cycleResetTime` ride along as-is: the card must see
      // "no cap" as its own state, and the fetch only sets them when the
      // upstream actually reported them. `turnSpend` is omitted rather than
      // zeroed when there is no comparable pair, so the badge can tell "no
      // answer" from "cost nothing".
      return {
        ...probed,
        credits,
        ...spend === undefined ? {} : { turnSpend: spend },
        ...turns === undefined ? {} : { turns },
      }
    }
  } catch (error: unknown) {
    return { ...probed, creditsError: safeMessage(error) }
  }
  return probed
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function workBuddyStatusHandler(
  deps: WorkBuddyStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyWebStatus(deps, sessionOf(req)))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * The session a status read was made for, when the caller named one.
 *
 * The transcript footer needs its own turn's figure, and turns are numbered
 * per session, so a read that carries a session id gets that session's list
 * back. The composer badge asks without one and is served the account-wide
 * document exactly as before — the parameter is a qualifier, never a
 * requirement, so an older browser half keeps working unchanged.
 *
 * The value is treated as an opaque key: it is only ever used to look a list up
 * in a Map, never interpolated into a query or a log.
 */
function sessionOf(req: IncomingMessage): string | undefined {
  const url = req.url ?? ''
  const query = url.indexOf('?')
  if (query < 0) return undefined
  const params = new URLSearchParams(url.slice(query + 1))
  const session = params.get('session')
  return session === null || session === '' ? undefined : session
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  const path = deps.path ?? WORKBUDDY_STATUS_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web status route')
}
