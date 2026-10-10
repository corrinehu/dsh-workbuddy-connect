/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-connect/status'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-workbuddy-connect/probe'

/**
 * The international (WorkBuddy AI) variant's own pair of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-workbuddy-connect/ai/status'
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-workbuddy-connect/ai/probe'

/**
 * Same-origin route backing the browser's update reminder.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies; it answers public npm/GitHub metadata only and never token
 * material.
 */
export const WORKBUDDY_UPDATE_PATH = '/plugins/dsh-workbuddy-connect/update'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the international card preference;
   * `set-model-visibility` hides or shows one model for the signed-in
   * account's picker.
   *
   * All five are writes, which is why they share this route's in-process key
   * and loopback guards rather than the read-only status GET.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'set-model-visibility'
  /** Target model id; required for `probe` and `set-model-visibility`. */
  model?: string
  /** Requested value for `set-maximum-context-window` and `set-model-visibility`. */
  enabled?: boolean
  /** Requested picker visibility for `set-model-visibility`. */
  visible?: boolean
  /**
   * Expected account key for `set-model-visibility`: the `visibility.account`
   * the card rendered its checkboxes from. The host refuses the write when the
   * signed-in account has moved on, so a stale card can never land one
   * account's toggle in another account's bucket.
   */
  account?: string
}

/**
 * Model-visibility section of the status document (issue #36).
 *
 * Present only when an account with a stable user id is signed in: the
 * preferences are per account, so a credential without a uid has nothing to
 * key them by and the card renders no visibility controls rather than editing
 * a bucket every uid-less account would share. The account key is the same
 * non-secret `uid:enterpriseId` identity the saved catalogs use — never a
 * token.
 */
export interface WorkBuddyWebVisibilitySection {
  /** The `uid:enterpriseId` identity these preferences belong to. */
  account: string
  /** Model ids this account has hidden from the picker (the full list, including ids not in the current catalog). */
  disabled: readonly string[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * The plan requires the card to distinguish a live catalog from the built-in
 * fallback, and to say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface WorkBuddyWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** App version used as the catalog User-Agent, when the variant needed one. */
  appVersion?: string
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /** When the package lapses, in epoch milliseconds; absent when unknown. */
  endTimeMs?: number
}

/** Credit lapsing inside one horizon, as the card reports it. */
export interface WorkBuddyWebExpiringCredits {
  /** Sum of the contributing packages' remaining credit. */
  total: number
  /** How many packages contribute. */
  packages: number
  /** Soonest expiry among them, epoch milliseconds. */
  earliestEndTimeMs?: number
}

/**
 * Credit at risk, bucketed by horizon.
 *
 * Only present when the upstream actually reported end times — a card must not
 * read "no expiry data" as "nothing expires soon".
 *
 * Future horizons only: the billing query behind this covers `valid` + `usedUp`
 * packages from the current time forward, so a lapsed package is never in the
 * set and has no bucket here.
 */
export interface WorkBuddyWebCreditExpiry {
  within24h: WorkBuddyWebExpiringCredits
  within3d: WorkBuddyWebExpiringCredits
  within7d: WorkBuddyWebExpiringCredits
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
  /** Credit lapsing soon, for the card's warning banner. */
  expiry?: WorkBuddyWebCreditExpiry
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
  /**
   * Context capacity in tokens, taken verbatim from the upstream
   * `maxAllowedSize`/`maxInputTokens`, or from the international document's
   * `contextWindow.defaultLength` when it declares one.
   *
   * The international card can opt into the largest declared alternative. The
   * selected value is what DSH receives as its actual context budget.
   */
  contextWindow?: number
  /** The upstream default, when the card currently uses a selected maximum. */
  defaultContextWindow?: number
  /**
   * The international document's larger selectable window, when it declares
   * one, and the model's maximum input ceiling.
   *
   * Kept apart from {@link contextWindow} because they answer different
   * questions: `contextWindow` is the budget the plugin actually requests under,
   * while these are facts about what the upstream will accept. Showing the 1M
   * ceiling as though it were the working window would overstate the budget.
   */
  maxContextWindow?: number
  maxInputTokens?: number
}

/**
 * Why no credential is usable, as a closed enum the browser half switches on.
 *
 * Deliberately separate from `reason`: `reason` is free text meant for a human
 * to read, so matching on it would break the moment the wording changes. This
 * is the machine-readable half, and the card uses it — never a substring of
 * `reason` — to decide whether the Agent assist block applies.
 */
export type WorkBuddySignedOutReasonCode =
  /** Nobody is signed in; nothing diagnosable beyond that. */
  | 'no-credential'
  /** A credential for the *other* product was found in this variant's file. */
  | 'credential-region-mismatch'
  /** An encrypted credential exists but could not be opened (wrong key, GCM failure, helper crash). */
  | 'encrypted-credential-unreadable'
  /** A product on a supported platform: discovery ran to completion and found no usable candidate. */
  | 'electron-binary-not-found'
  /** A product on a supported platform: discovery found more than one distinct usable app. */
  | 'electron-binary-ambiguous'
  /** No auto-discovery for this product/platform and no explicit path configured. */
  | 'electron-binary-unavailable'
  /** An explicit path (option or env) is set but missing or not executable. */
  | 'electron-path-invalid'
  /** Discovery could not finish: tool missing, timeout, output overflow, unreadable plist. */
  | 'electron-discovery-incomplete'

/** Every reason code, for validation without trusting a wire value. */
const SIGNED_OUT_REASON_CODES: readonly WorkBuddySignedOutReasonCode[] = [
  'no-credential',
  'credential-region-mismatch',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
]

/** Whether a value is one of the closed set of signed-out reason codes. */
export function isWorkBuddySignedOutReasonCode(value: unknown): value is WorkBuddySignedOutReasonCode {
  return typeof value === 'string' && (SIGNED_OUT_REASON_CODES as readonly string[]).includes(value)
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — today a credential belonging to the other product.
     * The card renders it in place of the generic sign-in hint.
     */
    reason?: string
    /** Machine-readable companion to `reason`; see {@link WorkBuddySignedOutReasonCode}. */
    reasonCode?: WorkBuddySignedOutReasonCode
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyWebModelBadge[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: WorkBuddyWebCatalog
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /** International-card preference selecting larger declared context windows. */
    useMaximumContextWindow?: boolean
    /** Per-account hidden-model state for the card's visibility controls. */
    visibility?: WorkBuddyWebVisibilitySection
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
  }
  | { status: 'error'; message: string }
