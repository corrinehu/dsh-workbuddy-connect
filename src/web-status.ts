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
import { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebStatus } from './status-paths.ts'

export { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  /** Resolve the current model catalog for free/badge display. */
  models: () => readonly WorkBuddyModelInfo[]
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

/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
): Promise<WorkBuddyWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') return { status: 'signed-out' }
  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
  }
  // Model billing facts ride the signed-in document so the card can show which
  // models are free or on a promo, without touching the Models picker. The
  // rate is normalized here (not in the card) so both halves agree on one
  // display form; the card additionally localizes it.
  const models = deps.models()
  const modelsField: readonly WorkBuddyWebModelBadge[] = models
    .filter(model => model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0)
    .map(model => {
      const rate = normalizeCredits(model.billing?.credits)
      return {
        id: model.id,
        name: model.name,
        ...model.billing?.free === true ? { free: true as const } : {},
        ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
        ...rate === undefined ? {} : { credits: rate },
      }
    })
  const statusWithModels: WorkBuddyWebStatus = modelsField.length > 0
    ? { ...status, models: modelsField }
    : status
  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      return { ...statusWithModels, credits }
    }
  } catch (error: unknown) {
    return { ...statusWithModels, creditsError: safeMessage(error) }
  }
  return statusWithModels
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!loopbackOrigin(req)) {
          json(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          json(res, 200, await workBuddyWebStatus(deps))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web status route')
}
