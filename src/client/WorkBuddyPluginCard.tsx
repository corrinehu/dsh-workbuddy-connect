/**
 * WorkBuddy status card, rendered on whichever settings surface the host
 * provides: dispatched directly by DSH 0.1.5's settings Plugins tab (one card
 * per variant), or mounted by the bundle configuration page DSH 0.1.6+'s
 * Plugins page renders. The component itself is surface-agnostic — its props
 * are only the injected copy and variant.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH, isWorkBuddySignedOutReasonCode } from '../status-paths.ts'
import type { WorkBuddyWebCreditExpiry } from '../status-paths.ts'
import type { WorkBuddySignedOutReasonCode, WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebStatus, WorkBuddyWebVisibilitySection } from '../status-paths.ts'
import { isWorkBuddyWebStatus } from './status-document.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  /**
   * Which product variant this card instance renders.
   *
   * Both cards share this component; the variant selects the status/probe
   * routes and the title/intro copy. Defaults to the CN variant so a card
   * rendered without the injection keeps working.
   */
  variant?: WorkBuddyCardVariant
}

/** The browser-visible half of a variant: identity, routes, and copy keys. */
export interface WorkBuddyCardVariant {
  id: string
  /** Locale key for the card title. */
  titleKey: WorkBuddySettingsKey
  /** Locale key for the card intro line. */
  introKey: WorkBuddySettingsKey
  /** Locale key for the not-signed-in hint. */
  signedOutKey: WorkBuddySettingsKey
  statusPath: string
  probePath: string
  /**
   * The product's own name, used verbatim inside the Agent prompt. Taken from
   * the variant rather than derived from a reason code: the two products fail
   * in the same shapes, so nothing in the failure says which name is right.
   */
  appName: string
  /** Locale key for "no decryption program is configured" on this product. */
  unavailableKey: WorkBuddySettingsKey
  /**
   * The composer credit badge's product prefix: "WB." for CN, "WB AI." for the
   * international app (#99). Carried on the variant so the composer control
   * never hardcodes provider ids.
   */
  creditPrefix: string
}

/** CN WorkBuddy; the plugin's long-standing card and default. */
export const CN_CARD_VARIANT: WorkBuddyCardVariant = {
  id: 'workbuddy',
  titleKey: 'title',
  introKey: 'intro',
  signedOutKey: 'signedOutHint',
  statusPath: WORKBUDDY_STATUS_PATH,
  probePath: WORKBUDDY_PROBE_PATH,
  appName: 'WorkBuddy',
  unavailableKey: 'assistUnavailableCN',
  creditPrefix: 'WB.',
}

/** International WorkBuddy AI. */
export const AI_CARD_VARIANT: WorkBuddyCardVariant = {
  id: 'workbuddy-ai',
  titleKey: 'titleAI',
  introKey: 'introAI',
  signedOutKey: 'signedOutHintAI',
  statusPath: WORKBUDDY_AI_STATUS_PATH,
  probePath: WORKBUDDY_AI_PROBE_PATH,
  appName: 'WorkBuddy AI',
  unavailableKey: 'assistUnavailableAI',
  creditPrefix: 'WB AI.',
}

/** Both cards, in display order. */
export const CARD_VARIANTS: readonly WorkBuddyCardVariant[] = [CN_CARD_VARIANT, AI_CARD_VARIANT]
/** Props the card renders from: the copy it shows and which variant it is. */
export type WorkBuddyPluginCardProps = Partial<WorkBuddyPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

/**
 * The reason codes whose failures the Agent assist block covers: the plugin
 * cannot reach a decryption program, for any of the five reasons in §5.5.
 *
 * This is the *only* place the card decides whether the block applies. It
 * branches on the code, never on `reason` text: the prose is written for a
 * human and is expected to change, so matching it would silently stop
 * matching after any wording edit.
 *
 * `encrypted-credential-unreadable` is deliberately absent — the app was found
 * and ran, so "look for the app" is not the fix for it.
 */
const ASSIST_REASON_CODES: readonly WorkBuddySignedOutReasonCode[] = [
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
]

/** Locale key for one failure's summary inside the Agent prompt. */
function assistSummaryKey(code: WorkBuddySignedOutReasonCode, variant: WorkBuddyCardVariant): WorkBuddySettingsKey {
  switch (code) {
    case 'electron-binary-not-found': return 'assistNotFound'
    case 'electron-binary-ambiguous': return 'assistAmbiguous'
    case 'electron-discovery-incomplete': return 'assistIncomplete'
    case 'electron-path-invalid': return 'assistPathInvalid'
    default: return variant.unavailableKey
  }
}

/** Copy text to the clipboard, reporting whether it worked. */
async function copyPrompt(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText === undefined) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * The Agent assist block for a path failure: what is wrong, one copyable
 * request, and a re-check. Rendered only for the codes above.
 */
function AssistBlock(
  { t, variant, failureSummary, busy, onRecheck }: {
    t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
    variant: WorkBuddyCardVariant
    /**
     * The failure the copied prompt should carry: the live `status.reason`
     * when one is available (it holds the actual diagnosis — e.g. "#66:
     * candidates were found but failed the layout check" — where the generic
     * per-code summary would flatten back to "not found", the exact
     * misdirection the agent would inherit), the localized per-code summary
     * otherwise. Content only; whether this block renders at all is decided
     * outside, on the code alone.
     */
    failureSummary: string
    busy: boolean
    onRecheck: () => void
  },
) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const prompt = t('assistantPrompt', {
    appName: variant.appName,
    failureSummary,
  })
  return (
    <div style={assistStyle}>
      <h4 style={assistHeadingStyle}>{t('assistantHeading')}</h4>
      <p style={bodyStyle}>{t('assistantIntro')}</p>
      <div style={assistPromptRowStyle}>
        {/* Selectable on purpose: a failed clipboard write must still leave the
            user a way to copy the text by hand. */}
        <p style={assistPromptStyle}>{prompt}</p>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void (async () => {
              const ok = await copyPrompt(prompt)
              setCopied(ok)
              setCopyFailed(!ok)
            })()
          }}
        >
          {t('assistantCopy')}
        </button>
      </div>
      {/* `role="status"` so the copy result is announced, not just shown. */}
      {copied ? <p style={assistFeedbackStyle} role="status">{t('assistantCopied')}</p> : null}
      {copyFailed ? <p style={assistFeedbackStyle} role="status">{t('assistantCopyFailed')}</p> : null}
      <p style={bodyStyle}>{t('assistantAfter')}</p>
      <div style={rowStyle}>
        <button type="button" style={buttonStyle} disabled={busy} onClick={onRecheck}>
          {busy ? t('assistantRechecking') : t('assistantRecheck')}
        </button>
      </div>
    </div>
  )
}

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
  // The card is an <li> under BOTH seats: DSH 0.1.5's Plugins tab nests cards
  // in its own <ul>, and the 0.1.6+ configuration page provides a <ul> too.
  // Neither owner draws list markers for its cards, and this keeps the new
  // page's <ul> free of them even before the host's own styles land.
  listStyle: 'none',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
/*
 * Expiry banner. Reads as an advisory, not an error: the account works fine,
 * the credit is simply about to lapse. Tones escalate by urgency so the 24-hour
 * case cannot be mistaken for the 7-day one at a glance.
 */
const noticeStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', borderRadius: 8, border: '1px solid', fontSize: 13, lineHeight: '18px' }
const noticeDetailStyle: CSSProperties = { fontSize: 12, lineHeight: '16px', opacity: 0.8 }
const urgentNoticeStyle: CSSProperties = { background: 'var(--dsw-alias-state-warn-tertiary, #fff4e5)', borderColor: 'var(--dsw-alias-state-warn-primary, #d97706)', color: 'var(--dsw-alias-label-primary)' }
const warnNoticeStyle: CSSProperties = { background: 'var(--dsw-alias-bg-l2, #f6f7f9)', borderColor: 'var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelOfferStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const contextPreferenceStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '20px' }
const contextPreferenceCopyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
/**
 * The Agent assist block. Sits beside the existing error line rather than
 * replacing it: the short diagnosis stays the headline, this adds the way out.
 */
const assistStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', marginTop: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))' }
const assistHeadingStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const assistPromptRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, padding: '8px 9px 8px 11px', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-1)' }
const assistPromptStyle: CSSProperties = { flex: '1 1 220px', minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }
const assistFeedbackStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' }
/**
 * Left half of one merged context/visibility row: the visibility checkbox (when
 * the account has one) beside the model's name and rate. Kept as a flex span so
 * the capacity column stays flush right no matter how long the name runs.
 */
const contextRowMainStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }
const modelBadgeChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}

/**
 * Localize an upstream promotional badge label, with an unknown-badge fallback.
 *
 * The CN catalog spells badges in Chinese (`限时免费`, `夜间折扣`); the
 * international document's `modelPromotions` carries English (`Free now`). Both
 * are mapped so the same promotion reads consistently in either UI language,
 * and anything else passes through verbatim — an unrecognized badge is still
 * information the upstream chose to show.
 */
function modelBadgeLabel(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  if (badge === 'Free now') return t('badgeFreeNow')
  return badge
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

/**
 * Inline confirmation box for a paid detection. Replaces the previous
 * `window.confirm`: the decision is one line plus two buttons, and a modal
 * alert for that is heavier than the action it guards.
 */
const confirmBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
}
const confirmRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }

/** One probeable model's row: name on the left, state and action on the right. */
const probeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const probeRowEndStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }

/**
 * Tab strip for the card body. Kept visually light — a full pill would compete
 * with the section headings, and the card is already the densest surface the
 * plugin owns.
 */
const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const tabStyle: CSSProperties = {
  padding: '6px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}
const tabPanelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 16 }

/**
 * Primary action of the inline confirmation. Fill and text colour come from the
 * theme as a pair: `brand-primary` is a light accent here, so pairing it with a
 * hardcoded white would render white-on-white.
 */
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

/**
 * Status dot colour. Takes `'loading'` as well as the document's own states:
 * before the first response the card knows nothing about the account, so it must
 * not borrow the signed-out grey — that would read as "nothing is wrong, nobody
 * is signed in" when the truth is "not read yet".
 */
function dotStyle(status: 'loading' | WorkBuddyWebStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

function formatCycleReset(time: string): string {
  const parsed = Date.parse(time)
  if (!Number.isNaN(parsed)) return formatTime(parsed)
  return time
}

/**
 * A warning that credit is about to lapse.
 *
 * The total alone cannot express this: a package expiring in an hour and one
 * expiring next month both render as "500 credit", so a user watching only the
 * total loses the first one silently. The banner names the amount, the package
 * count and the soonest expiry, and escalates 7d → 24h.
 *
 * Only future horizons are covered: the billing query behind this returns
 * `valid` + `usedUp` packages from the current time forward, so an
 * already-lapsed package never reaches here.
 *
 * Renders nothing when the upstream reported no end times at all — absence of
 * expiry data is not evidence that nothing expires, so the component stays
 * silent rather than reassuring.
 */
function ExpiryNotice({ expiry, t }: {
  expiry: WorkBuddyWebCreditExpiry
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const { within24h, within7d } = expiry
  let message: string | undefined
  let soonest: number | undefined
  let tone: CSSProperties
  if (within24h.packages > 0) {
    message = t('expiryWarningSoon', {
      total: formatNumber(Math.round(within24h.total * 100) / 100),
      packages: String(within24h.packages),
    })
    soonest = within24h.earliestEndTimeMs
    tone = urgentNoticeStyle
  } else if (within7d.packages > 0) {
    message = t('expiryWarningWeek', {
      total: formatNumber(Math.round(within7d.total * 100) / 100),
      packages: String(within7d.packages),
    })
    soonest = within7d.earliestEndTimeMs
    tone = warnNoticeStyle
  } else {
    return null
  }
  return (
    <div style={{ ...noticeStyle, ...tone }} role="status">
      <span>{message}</span>
      {soonest === undefined
        ? null
        : <span style={noticeDetailStyle}>{t('expiryExpiresAt', { time: formatTime(soonest) })}</span>}
    </div>
  )
}

/**
 * One billing package as a labeled progress bar.
 *
 * A package whose allowance the upstream never reported (`size` not positive)
 * has no percentage to state. It must not fall back to 100%: the plugin would be
 * claiming a full quota it knows nothing about, which is the opposite of the
 * honest "remaining N" line printed below it. Unknown size therefore renders the
 * percent slot as unknown copy and an unfilled, indeterminate track.
 */
function CreditBar({ label, remain, size, unlimited, t }: {
  label: string
  remain: number
  size: number
  unlimited?: boolean | undefined
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  if (unlimited === true) {
    const quotaText = t('unlimitedQuota')
    return (
      <div style={quotaGroupStyle}>
        <div style={quotaLabelStyle}>
          <span>{label}</span>
          <span>{quotaText}</span>
        </div>
        <div
          style={progressTrackStyle}
          role="progressbar"
          aria-label={label}
          /*
           * "Uncapped" is not "100% remaining", so the range attributes are
           * omitted and no fill is drawn: an uncapped quota has no proportion
           * to state, and a full bar would assert one.
           */
          aria-valuetext={quotaText}
        />
        <p style={bodyStyle}>{quotaText}</p>
      </div>
    )
  }
  const sizeKnown = size > 0
  const detail = sizeKnown
    ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) })
    : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = sizeKnown ? (remain / size) * 100 : undefined
  const display = percent === undefined
    ? t('percentUnknown')
    : t('percentRemaining', {
      percent: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent),
    })
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        /*
         * No numeric value when the size is unknown: the range attributes are
         * omitted so assistive technology reports an indeterminate bar rather
         * than a second, louder repeat of the false 100%.
         */
        {...percent === undefined
          ? { 'aria-valuetext': detail }
          : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }}
      >
        {percent === undefined ? null : <div style={progressFillStyle(percent)} />}
      </div>
      <p style={bodyStyle}>{detail}</p>
    </div>
  )
}

/**
 * One model offer row: name, promotional badges, and the billing rate.
 *
 * The rate sits under the name rather than beside it because the row already
 * spends its horizontal budget on badges; stacking keeps long model names and
 * several badges from squeezing the rate into an ellipsis.
 */
function ModelOfferRow({ model, t }: {
  model: WorkBuddyWebModelBadge
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  return (
    <div style={modelOfferStyle}>
      <div style={quotaLabelStyle}>
        <span>{model.name}</span>
        <span style={modelBadgeStyle}>
          {model.badges?.map(badge => (
            <span key={badge} style={modelBadgeChipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
          {model.free === true ? <span style={modelBadgeChipStyle}>{t('freeModel')}</span> : null}
        </span>
      </div>
      {model.credits === undefined
        // No rate to show. When the plugin withheld it because the price came
        // from an ended promotion, say so plainly rather than showing nothing —
        // silence here reads as "free", which is the claim being avoided.
        ? model.rateUnknown === true ? <span style={modelRateStyle}>{t('rateUnknown')}</span> : null
        : <span style={modelRateStyle}>{t('rate', { rate: model.credits })}</span>}
    </div>
  )
}

/**
 * Context window and model visibility, one row per catalog model.
 *
 * The list is driven by the full current catalog, not by context metadata:
 * hiding a model is a statement about the picker, and a model without a
 * declared window is still hideable — its row just shows an em dash where the
 * capacity would be. Rows with a window keep the original ordering (largest
 * first); rows without one trail at the end in catalog order.
 *
 * Each row is one <label>, so the checkbox is named by its row without a
 * duplicated aria string. The checkbox state comes from the status document
 * only — no optimistic flip — so a save that fails leaves the box where the
 * host's truth says it is, next to the failure notice `control` records.
 * Checkboxes render only when the document carries a visibility section (a
 * signed-in account with a stable user id); a uid-less credential shows the
 * plain capacity list rather than editing a bucket every such account would
 * share.
 *
 * Purely a report of the upstream's own numbers otherwise. The plugin offers
 * no tier picker: the CN catalog declares one capacity per model and publishes
 * no alternatives, so a menu there would mean inventing client-side policy.
 * The international document does declare alternatives (`supportedLengths`),
 * and they are shown as a secondary figure rather than merged into one number —
 * the default is the budget actually requested, while the larger value is a
 * ceiling the upstream would accept.
 */
function ContextTable({ models, t, useMaximumContextWindow, contextPreferenceDisabled, onUseMaximumContextWindow, visibility, visibilityControlsDisabled, visibilityToggling, onVisibilityToggle }: {
  models: readonly WorkBuddyWebModelBadge[] | undefined
  t: WorkBuddyPluginCardInjected['t']
  useMaximumContextWindow?: boolean
  /** Whether the maximum-context preference checkbox is locked (card `busy`). */
  contextPreferenceDisabled?: boolean
  onUseMaximumContextWindow?: (enabled: boolean) => void
  /** Per-account hidden-model state; undefined renders no checkboxes. */
  visibility: WorkBuddyWebVisibilitySection | undefined
  /** Whether the visibility checkboxes are locked while other card actions run (`busy`). */
  visibilityControlsDisabled?: boolean
  /** The models whose visibility writes are in flight; only those rows lock. */
  visibilityToggling: ReadonlySet<string>
  onVisibilityToggle?: (modelId: string, visible: boolean) => void
}): React.ReactNode {
  const rows = [...(models ?? [])].sort((a, b) => {
    // Largest first, the ordering this table has always used; rows without a
    // declared window trail at the end, keeping catalog order within the group
    // (Array#sort is stable).
    if (a.contextWindow === undefined) return b.contextWindow === undefined ? 0 : 1
    if (b.contextWindow === undefined) return -1
    return b.contextWindow - a.contextWindow
  })
  const canSelectMaximum = rows.some(model => model.maxContextWindow !== undefined
    && model.maxContextWindow > (model.defaultContextWindow ?? model.contextWindow ?? 0))
  const showPreference = onUseMaximumContextWindow !== undefined && (canSelectMaximum || useMaximumContextWindow === true)
  if (rows.length === 0 && !showPreference) return null
  const hidden = new Set(visibility?.disabled ?? [])
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('contextHeading')}</h3>
      {/*
        * The preference is a policy about every row below it, not a row
        * itself: it keeps its own bordered label and stays above the list, so
        * the two checkbox kinds never read as one group.
        */}
      {showPreference && onUseMaximumContextWindow !== undefined ? (
        <label style={contextPreferenceStyle}>
          <input
            type="checkbox"
            checked={useMaximumContextWindow === true}
            disabled={contextPreferenceDisabled}
            onChange={event => { onUseMaximumContextWindow(event.currentTarget.checked) }}
          />
          <span style={contextPreferenceCopyStyle}>
            <span>{t('useMaximumContextWindow')}</span>
            <span style={modelRateStyle}>{t('useMaximumContextWindowHint')}</span>
          </span>
        </label>
      ) : null}
      {/*
        * One line on what the checkboxes mean, only when they are rendered —
        * a bare checkbox column with no explanation reads as selection, not
        * visibility.
        */}
      {visibility === undefined ? null : <p style={bodyStyle}>{t('visibilityIntro')}</p>}
      <div style={quotaGroupStyle}>
        {rows.map(model => {
          const capacity = model.contextWindow
          // Only shown when the upstream declared a larger alternative, so the
          // CN list (which declares none) is unchanged.
          const alternative = capacity !== undefined && model.maxContextWindow !== undefined && model.maxContextWindow > capacity
            ? model.maxContextWindow
            : undefined
          return (
            <label key={model.id} style={quotaLabelStyle}>
              <span style={contextRowMainStyle}>
                {visibility === undefined ? null : (
                  <input
                    type="checkbox"
                    checked={!hidden.has(model.id)}
                    disabled={visibilityControlsDisabled || visibilityToggling.has(model.id)}
                    onChange={event => { onVisibilityToggle?.(model.id, event.currentTarget.checked) }}
                  />
                )}
                <span style={modelOfferStyle}>
                  {/*
                    * Promo badges ride the name line and wrap below it when
                    * they do not fit, exactly as the discount list renders
                    * them; the row stays one line per model.
                    */}
                  <span style={modelBadgeStyle}>
                    <span>{model.name}</span>
                    {model.badges?.map(badge => (
                      <span key={badge} style={modelBadgeChipStyle}>{modelBadgeLabel(badge, t)}</span>
                    ))}
                    {model.free === true ? <span style={modelBadgeChipStyle}>{t('freeModel')}</span> : null}
                  </span>
                  {model.credits === undefined ? null
                    : <span style={modelRateStyle}>{model.credits}</span>}
                </span>
              </span>
              <span style={modelOfferStyle}>
                {capacity === undefined
                  ? <span style={modelRateStyle} aria-label={t('contextUnknown')}>—</span>
                  : <span style={{ textAlign: 'right' }}>{formatTokens(capacity)}</span>}
                {alternative !== undefined
                  ? <span style={modelRateStyle}>{t('contextUpTo', { size: formatTokens(alternative) })}</span>
                  : capacity !== undefined && model.defaultContextWindow !== undefined && model.defaultContextWindow < capacity
                    ? <span style={modelRateStyle}>{t('contextDefault', { size: formatTokens(model.defaultContextWindow) })}</span>
                    : null}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Compact token count for display: the catalog's own round numbers (`200000`,
 * `1000000`) read better as `200K` / `1M`, and no precision is lost because
 * these values are always whole thousands.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

/**
 * Reasoning-effort detection section: consent switches, per-model detection,
 * and the recorded observations.
 *
 * Two deliberate UX rules from the plan (§3.1, §3.2):
 * - the confirmation is shown *before* any request, and its copy states the
 *   credit caveat;
 * - a `non-validating` result is presented as an observation about the
 *   parameter ("this model does not check it"), never as a statement that a
 *   level is unsupported.
 */
function ProbeSection({ probe, models, t, onDetect, onClear, busy }: {
  probe: WorkBuddyWebProbeSection
  /** Catalog rows from the same status document, for candidate display names. */
  models: readonly WorkBuddyWebModelBadge[] | undefined
  t: WorkBuddyPluginCardInjected['t']
  onDetect: (modelId: string) => void
  onClear: () => void
  busy: boolean
}): React.ReactNode {
  // Which model is awaiting confirmation. Confirmation is inline for the same
  // reason the Composer entry uses a bubble: a modal alert for a one-line
  // decision is heavier than the action it guards.
  const [pending, setPending] = useState<string>()
  // Which model this card last asked to detect. `busy` alone cannot answer
  // that — it is true for any in-flight request — so the running label needs
  // the id, otherwise every candidate button claims to be running at once.
  const [runningModel, setRunningModel] = useState<string>()
  // A sweep that finishes (or a catalogue change that removes the candidate)
  // must not leave a stale confirmation behind.
  useEffect(() => {
    if (pending !== undefined && !probe.candidates.includes(pending)) setPending(undefined)
  }, [pending, probe.candidates])
  // Clear the running label once the request settles.
  //
  // Keyed on `busy` alone this would fire immediately: the click that starts a
  // detection sets `runningModel` and `busy` in one batch, and an effect that
  // only checks `!busy` can still observe the pre-update value. So the label is
  // armed on the way up and released only after the run has actually been seen
  // in flight.
  const runningArmed = useRef(false)
  useEffect(() => {
    if (runningModel === undefined) return
    if (busy || probe.running) {
      runningArmed.current = true
      return
    }
    if (!runningArmed.current) return
    runningArmed.current = false
    setRunningModel(undefined)
  }, [runningModel, busy, probe.running])
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('probeHeading')}</h3>
      <p style={bodyStyle}>{t('probeIntro')}</p>
      <p style={bodyStyle}>{t('probeConsentHint')}</p>
      {probe.running ? <p style={bodyStyle}>{t('probeRunningGeneric')}</p> : null}
      {/*
        * One row per probeable model, each carrying its own state and button.
        *
        * Previously the buttons lived in a block above the results, so a model
        * that had been detected left the button list and reappeared only as a
        * result below — re-running it meant clearing every other result. Rows
        * keep the model and its action together, and the order is fixed by the
        * catalog, so nothing moves when a detection lands.
        */}
      {probe.candidates.length === 0
        ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
        : (
          <div style={quotaGroupStyle}>
            {probe.candidates.map(id => {
              const result = probe.results.find(entry => entry.id === id)
              // Display name: the catalog's own label first, then whatever the
              // recorded probe stored, then the bare id. The *action* below
              // keeps using the id regardless of what the name resolves to.
              const name = models?.find(model => model.id === id)?.name ?? result?.name ?? id
              return (
                <div key={id} style={modelOfferStyle}>
                  <div style={probeRowStyle}>
                    <span>{name}</span>
                    <span style={probeRowEndStyle}>
                      {result === undefined ? null : (
                        <span style={modelBadgeChipStyle}>
                          {result.validation === 'validating' && result.efforts.length > 0
                            ? result.efforts.join(' / ')
                            : t(result.validation === 'non-validating' ? 'probeResultNotValidating' : 'probeResultUnknown')}
                        </span>
                      )}
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={probe.running || busy}
                        onClick={() => { setPending(id) }}
                      >
                        {/*
                          * Only the button that was actually pressed reports
                          * progress; the card-wide `busy` flag is true for any
                          * in-flight request, so it cannot pick the label.
                          */}
                        {runningModel === id
                          ? t('probeRunning', { model: name })
                          : t(result === undefined ? 'probeStart' : 'probeRedetect')}
                      </button>
                    </span>
                  </div>
                  {result === undefined ? null
                    : <span style={modelRateStyle}>{t('probeResultAt', { time: formatTime(result.probedAt) })}</span>}
                  {/*
                    * The confirmation expands inside the row it belongs to.
                    * Rendered after the whole list it sat at the bottom of a
                    * long candidate list, so the question ("send requests to
                    * this model?") was a screen away from the button that
                    * asked it. In-flow placement keeps them together and needs
                    * no positioning or overflow handling.
                    */}
                  {pending === id ? (
                    <div style={confirmBoxStyle}>
                      <p style={bodyStyle}>{t('probeConfirmBody', { model: name })}</p>
                      <div style={confirmRowStyle}>
                        <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          style={primaryButtonStyle}
                          disabled={probe.running || busy}
                          onClick={() => {
                            setRunningModel(id)
                            setPending(undefined)
                            onDetect(id)
                          }}
                        >
                          {t('probeConfirmAction')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

      {probe.results.length === 0 ? null : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onClear() }}>
          {t('probeClear')}
        </button>
      )}
    </div>
  )
}

/** Render WorkBuddy sign-in state and credit as one expandable card. */
export function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT }: WorkBuddyPluginCardProps) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(false)
  /**
   * The document to render. `undefined` means *not read yet*, which is a
   * distinct state from "signed out": seeding this with a signed-out document
   * told an already-signed-in user they were signed out for the whole first
   * round trip (and forever, if the read never settled).
   */
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  /**
   * Whether the last **successful** read found a usable credential.
   *
   * Kept apart from `status` because the poll's liveness must depend on what the
   * account actually is, not on what the card last displayed: a failed read
   * leaves this untouched, so a transient failure cannot disarm the interval,
   * while a genuine signed-out answer still stops it.
   *
   * `undefined` therefore means "no successful read yet", which is also the
   * condition that decides whether a failed read has anything to preserve.
   */
  const [signedIn, setSignedIn] = useState<boolean>()
  /**
   * Why the most recent read failed, when it did. Rendered as a notice beside
   * whatever document is still on screen, rather than replacing it.
   */
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  /**
   * The model ids whose visibility writes are in flight, empty when none are.
   * Deliberately NOT the card-wide `busy` (that flag drives the Refresh
   * buttons' labels, which must not claim a refresh the user never pressed)
   * and deliberately per-row rather than whole-list: a visibility write only
   * adds or removes one model's id, so the rows are independent — locking
   * every checkbox for one row's write made the whole list visibly blink for
   * no correctness gain. A set, because two writes can be open at once when
   * the user moves down the list; only the rows being written lock.
   */
  const [togglingModels, setTogglingModels] = useState<ReadonlySet<string>>(() => new Set())
  // Three tabs. Default is the live status plus the one action the card
  // carries; the two reference sets — context capacity, then rates and the
  // per-package breakdown — are deliberate visits, since neither changes while
  // you watch.
  const [tab, setTab] = useState<'status' | 'context' | 'details'>('status')
  const mounted = useRef(true)
  /**
   * Identity of the newest read that may write. Assigned when a read *starts*,
   * so a response is superseded by anything begun after it — "the response whose
   * request started last wins". Without this, a slow poll begun before a manual
   * action could settle after the action's own refresh and restore the older
   * document.
   */
  const readSeq = useRef(0)
  /** Manual requests in flight, so unmount can abort them like the poll's. */
  const manualControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  /** Register a manual request's controller so unmount aborts it. */
  const trackController = useCallback((): AbortController => {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    return controller
  }, [])

  /**
   * Read the status document and apply it under the two policies the card's
   * correctness rests on:
   *
   * - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
   *   something to store and then dereference in the render;
   * - a failed read never discards a document already on screen. It is recorded
   *   and shown as a notice beside that document; only when nothing has been
   *   read yet does the failure itself become the rendered state.
   *
   * Returns whether this read produced the current document.
   */
  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const seq = ++readSeq.current
    // Superseded (a newer read started) or unmounted: write nothing, report
    // nothing. A dropped response must not surface as a failure of its own.
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(variant.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isWorkBuddyWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      // Only a document that states the session may move the poll gate. An
      // `error` document (which only a failed read produces, and which the host
      // never sends) says nothing about the account, so it must not stop the
      // interval — that would strand the card on a state it cannot leave.
      if (value.status === 'signed-in') setSignedIn(true)
      else if (value.status === 'signed-out') setSignedIn(false)
      setReadFailure(undefined)
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('requestFailed')
      if (current()) {
        setReadFailure(message)
        // Nothing on screen to preserve: the failure is all there is to show.
        setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
      }
      return false
    }
  }, [t, variant.statusPath])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, refresh])

  useEffect(() => {
    // Gated on the last successful read, never on the rendered document: a
    // failed read must not be able to disarm this effect, or one transient
    // error would leave the card blank until the user clicked Refresh.
    if (!open || signedIn === false) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh, signedIn])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    const controller = trackController()
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Ask the host to re-read the credential and re-fetch this variant's catalog.
   *
   * Shares the probe route's key and guards: it is a write that spends an
   * upstream request, so it does not belong on the read-only status GET. A
   * failure is surfaced through the refreshed document's `catalog.error` rather
   * than thrown away, so the reason survives the round trip.
   */
  const refreshModels = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(variant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'refresh' }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        // A rejected write is reported beside the document, exactly like a
        // failed read: replacing it would take the account, credits and model
        // list away over one failed action — the harm §3 of the confirmation
        // document removes for reads, and identical here. Aborts stay silent.
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
      // The failed write has no follow-up read, so it unregisters here.
      manualControllers.current.delete(controller)
      return
    } finally {
      if (mounted.current) setBusy(false)
    }
    // Started after the write resolves, so this read outranks any poll that
    // began earlier and the refreshed list is what stays on screen.
    try {
      await refresh(controller.signal)
    } finally {
      // Unregistered only after this read settles: while it is in flight it is
      // still a manual request, so unmount must abort it exactly as it aborts
      // the write above and `manualRefresh`/`control` abort theirs.
      manualControllers.current.delete(controller)
    }
  }, [refresh, status, t, trackController, variant.probePath])

  /**
   * Run one control action and refresh the card's state afterwards.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here.
   */
  const control = useCallback(async (action: { action: 'probe'; model: string } | { action: 'clear' } | { action: 'set-maximum-context-window'; enabled: boolean } | { action: 'set-model-visibility'; model: string; visible: boolean; account: string }): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    // A visibility toggle runs on its own per-row in-flight set so the
    // Refresh buttons keep their idle labels and the untouched rows stay
    // clickable (see `togglingModels`); every other action keeps the card-wide
    // `busy` those labels report.
    const visibility = action.action === 'set-model-visibility'
    if (visibility) setTogglingModels(previous => new Set(previous).add(action.model))
    else setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(variant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbuddy-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify(action),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      // Preference writes must confirm themselves: a `failed` state here means
      // the host did not persist the toggle, and the checkbox must not be left
      // claiming it did — the thrown reason lands beside the list and the
      // document's next read restores the honest state.
      if ((action.action === 'set-maximum-context-window' || action.action === 'set-model-visibility')
        && (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['state'] !== 'updated')) {
        const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['state'] : undefined
        // A stale write (the account switched under the open card) is its own
        // outcome: explain it in the user's language and re-read now, so the
        // checkboxes converge on the new account's section instead of waiting
        // for the next poll while still showing the departed account's list.
        if (action.action === 'set-model-visibility' && state === 'stale-account') {
          await refresh(controller.signal)
          throw new Error(t('visibilityStaleAccount'))
        }
        const reason = typeof value === 'object' && value !== null && 'reason' in value
          ? String((value as Record<string, unknown>)['reason'])
          : t('requestFailed')
        throw new Error(reason)
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        // Same policy as a failed read and as `refreshModels`: the reason is
        // reported beside the document, never in place of it. A detection that
        // did not complete must not erase the account and credit figures the
        // user was reading. Aborts stay silent.
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (!mounted.current) return
      if (visibility) setTogglingModels(previous => {
        const next = new Set(previous)
        next.delete(action.model)
        return next
      })
      else setBusy(false)
    }
  }, [refresh, status, t, trackController, variant.probePath])

  /**
   * Start a detection. Confirmation happens inline in the section, so this is
   * only ever called after the user has already agreed.
   */
  const confirmDetect = useCallback((modelId: string): void => {
    void control({ action: 'probe', model: modelId })
  }, [control])

  const title = t(variant.titleKey)
  /**
   * The failure the assist block covers, when this document has one. Computed
   * once so the block and the header's refresh button agree on whether the
   * block owns the re-check action — showing both would put two buttons with
   * the same effect side by side.
   */
  const assistCode = status?.status === 'signed-out' && isWorkBuddySignedOutReasonCode(status.reasonCode)
    && ASSIST_REASON_CODES.includes(status.reasonCode)
    ? status.reasonCode
    : undefined
  /*
   * `undefined` is "not read yet" and gets its own copy. It is not signed-out:
   * claiming that would be false for a user who is in fact signed in.
   */
  const label = status === undefined
    ? t('loading')
    : status.status === 'signed-in'
      ? status.nickname === undefined ? t('signedInAs', { nickname: '' }).trimEnd().replace(/[:：]$/, '') : t('signedInAs', { nickname: status.nickname })
      : status.status === 'error'
        ? t('requestFailed')
        : t('signedOut')

  return (
    // An <li>, matching both seats: DSH 0.1.5's Plugins tab renders slot
    // entries directly inside its <ul>, so a div there would break list
    // semantics; the 0.1.6+ configuration page below wraps the cards in its
    // own <ul>. The cardStyle's `listStyle: 'none'` keeps either page free of
    // stray list markers.
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle}>{t(variant.introKey)}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open
        ? <div style={cardBodyStyle}>
            <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
            <div style={rowStyle}>
              {/* `aria-busy` while nothing has been read: the value is pending, not absent. */}
              <div style={statusStyle} role="status" aria-busy={status === undefined}>
                <span aria-hidden="true" style={dotStyle(status === undefined ? 'loading' : status.status)} />
                <span>{label}</span>
              </div>
              {/* The assist block carries the re-check in this state, so the
                  header button steps aside rather than duplicating it. */}
              {assistCode === undefined
                ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                    {busy ? t('refreshing') : t('refresh')}
                  </button>
                : null}
            </div>
            {/*
              * A failed read is reported beside the document still on screen,
              * never in place of it: blanking the card over one transient error
              * loses the account, credits and model list the user was reading.
              * Cleared by the next successful read. `signedIn === undefined`
              * means no read has ever succeeded, so there is nothing to
              * annotate — the error state below already states the failure on
              * its own, exactly as it did before this notice existed.
            */}
            {readFailure === undefined || signedIn === undefined
              ? null
              : <p style={errorStyle}>{t('statusRefreshFailed', { message: readFailure })}</p>}
            {status?.status === 'signed-in'
              ? <>
                  {status.expiresAt === undefined ? null
                    : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}
                  {/*
                    * Catalog provenance. Without it a stale list is
                    * indistinguishable from a fresh one, and a user cannot tell
                    * whether what they see still matches the upstream. The
                    * refresh action sits here because this is the line that says
                    * whether the list needs refreshing.
                    */}
                  {status.catalog === undefined
                    ? null
                    : <div style={rowStyle}>
                        <span style={bodyStyle}>
                          {status.catalog.source === 'live' && status.catalog.fetchedAt !== undefined
                            ? t('catalogLive', { time: formatTime(status.catalog.fetchedAt) })
                            : status.catalog.source === 'saved' && status.catalog.fetchedAt !== undefined
                              ? t('catalogSaved', { time: formatTime(status.catalog.fetchedAt) })
                              : t('catalogFallback')}
                          {status.catalog.appVersion === undefined
                            ? ''
                            : ` · ${t('catalogAppVersion', { version: status.catalog.appVersion })}`}
                        </span>
                        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void refreshModels() }}>
                          {busy ? t('refreshingModels') : t('refreshModels')}
                        </button>
                      </div>}
                  {status.catalog?.error === undefined
                    ? null
                    : <p style={errorStyle}>{t('catalogError', { message: status.catalog.error })}</p>}
                  {/*
                    * Three tabs, split by what the reader came for.
                    *
                    * 1. Status — the live facts and the one action the card
                    *    carries: account, total credit, and reasoning-level
                    *    detection. Detection belongs beside the status because
                    *    it is something you *do* to the model in front of you,
                    *    not reference material you go looking for.
                    * 2. Context — every model's capacity, listed in full.
                    * 3. Details — the rate reference: per-package credit and
                    *    the per-model discount list.
                    *
                    * Previously this was one column, which buried the context
                    * window below several rows of per-model discounts: the
                    * least time-sensitive content sat above the most
                    * decision-relevant.
                    */}
                  <div role="tablist" style={tabBarStyle}>
                    {(['status', 'context', 'details'] as const).map(id => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => { setTab(id) }}
                        style={{ ...tabStyle, ...(tab === id ? tabActiveStyle : {}) }}
                      >
                        {t(id === 'status' ? 'tabStatus' : id === 'context' ? 'tabContext' : 'tabDetails')}
                      </button>
                    ))}
                  </div>

                  {tab === 'status' ? (
                    <div style={tabPanelStyle}>
                      {status.credits === undefined ? null : (
                        <div style={quotaListStyle}>
                          {/* Ahead of the total: a user who reads only the first
                              line must see the amount about to lapse. */}
                          {status.credits.expiry === undefined
                            ? null
                            : <ExpiryNotice expiry={status.credits.expiry} t={t} />}
                          <div style={rowStyle}>
                            <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                            {/* `unlimited` first: the placeholder total is 0 and
                                rendering it would claim the quota is exhausted. */}
                            <span style={bodyStyle}>{status.credits.unlimited === true
                              ? t('creditsTotalUnlimited')
                              : t('creditsTotal', { total: formatNumber(status.credits.total) })}</span>
                          </div>
                          {status.credits.cycleResetTime === undefined ? null : (
                            <p style={descriptionStyle}>
                              {t('cycleResetAt', { time: formatCycleReset(status.credits.cycleResetTime) })}
                            </p>
                          )}
                        </div>
                      )}
                      {status.creditsError === undefined ? null
                        : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                      {status.probe === undefined ? null : (
                        <ProbeSection
                          probe={status.probe}
                          models={status.models}
                          t={t}
                          busy={busy}
                          onDetect={confirmDetect}
                          onClear={() => { void control({ action: 'clear' }) }}
                        />
                      )}
                    </div>
                  ) : tab === 'context' ? (
                    <div style={tabPanelStyle}>
                      {/*
                        * The document carries `useMaximumContextWindow` only
                        * when the host can persist the preference, so its
                        * presence is the capability signal: a 0.1.7 host (no
                        * settings API) omits the field and this card renders
                        * no preference control — not one whose click can only
                        * report failure.
                        */}
                      <ContextTable
                        models={status.models}
                        t={t}
                        contextPreferenceDisabled={busy}
                        {...variant.id === AI_CARD_VARIANT.id && status.useMaximumContextWindow !== undefined
                          ? {
                            useMaximumContextWindow: status.useMaximumContextWindow,
                            onUseMaximumContextWindow: (enabled: boolean) => { void control({ action: 'set-maximum-context-window', enabled }) },
                          }
                          : {}}
                        visibility={status.visibility}
                        visibilityControlsDisabled={busy}
                        visibilityToggling={togglingModels}
                        onVisibilityToggle={(modelId, visible) => {
                          // The expected-account guard: name the account these
                          // checkboxes were rendered from, so a write that
                          // races an account switch is refused host-side.
                          void control({
                            action: 'set-model-visibility',
                            model: modelId,
                            visible,
                            account: status.visibility?.account ?? '',
                          })
                        }}
                      />
                    </div>
                  ) : (
                    <div style={tabPanelStyle}>
                      {status.credits === undefined ? null : (
                        <div style={quotaListStyle}>
                          <h3 style={quotaTitleStyle}>{t('creditsDetailHeading')}</h3>
                          {status.credits.accounts
                            .filter(account => account.packageName === 'enterprise' || account.remain > 0 || account.unlimited === true)
                            .map((account, index) => (
                            <CreditBar
                              key={`${account.packageName}-${String(index)}`}
                              label={account.packageName === 'enterprise' ? t('packageEnterprise') : account.packageName}
                              remain={account.remain}
                              size={account.size}
                              unlimited={account.unlimited}
                              t={t}
                            />
                          ))}
                        </div>
                      )}
                      {status.models === undefined || status.models.length === 0 ? null : (
                        <div style={quotaListStyle}>
                          <h3 style={quotaTitleStyle}>{t('modelsHeading')}</h3>
                          {status.models
                            .filter(model => model.free === true || (model.badges?.length ?? 0) > 0)
                            .map(model => <ModelOfferRow key={model.id} model={model} t={t} />)}
                        </div>
                      )}
                    </div>
                  )}
                </>
              : null}
            {status?.status === 'signed-out'
              // A mismatch explanation replaces the generic hint: telling a user
              // to "sign in" is wrong advice when a credential was found and
              // rejected for belonging to the other product.
              ? <>
                  <p style={status.reason === undefined ? bodyStyle : errorStyle}>
                    {status.reason ?? t(variant.signedOutKey)}
                  </p>
                  {/*
                    * The assist block appears only for the failures a search or
                    * a configuration could fix. The code is narrowed here — the
                    * wire value is not guaranteed to be in the enum — and the
                    * decision is made on the code alone, never on `reason`.
                    */}
                  {assistCode === undefined
                    ? null
                    : <AssistBlock
                        t={t}
                        variant={variant}
                        failureSummary={status.reason ?? t(assistSummaryKey(assistCode, variant))}
                        busy={busy}
                        onRecheck={() => { void manualRefresh() }}
                      />}
                </>
              : null}
            {status?.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
          </div>
        : null}
    </li>
  )
}
