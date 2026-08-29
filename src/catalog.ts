/**
 * WorkBuddy model catalog: a static fallback list captured from the live
 * endpoint, replaced by the upstream's dynamic answer once it loads.
 *
 * @module dsh-workbuddy-connect/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * Static CLI models observed on the CN endpoint (2026-08-17; image flags
 * re-verified against the live catalog 2026-08-29). The upstream refresh
 * replaces this list at startup; it exists so the provider registers with a
 * usable catalog even while the first fetch is in flight or offline.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 168_000, maxTokens: 32_000, supportsImages: true },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImages: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000, supportsImages: true },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000, supportsImages: true },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000, supportsImages: true },
]

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS

  /** Current entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    this.models = [...models]
  }
}
