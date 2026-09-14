/** WorkBuddy status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from '../status-paths.ts'
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
}

/** CN WorkBuddy; the plugin's long-standing card and default. */
export const CN_CARD_VARIANT: WorkBuddyCardVariant = {
  id: 'workbuddy',
  titleKey: 'title',
  introKey: 'intro',
  signedOutKey: 'signedOutHint',
  statusPath: WORKBUDDY_STATUS_PATH,
  probePath: WORKBUDDY_PROBE_PATH,
}

/** International WorkBuddy AI. */
export const AI_CARD_VARIANT: WorkBuddyCardVariant = {
  id: 'workbuddy-ai',
  titleKey: 'titleAI',
  introKey: 'introAI',
  signedOutKey: 'signedOutHintAI',
  statusPath: WORKBUDDY_AI_STATUS_PATH,
  probePath: WORKBUDDY_AI_PROBE_PATH,
}

/** Both cards, in display order. */
export const CARD_VARIANTS: readonly WorkBuddyCardVariant[] = [CN_CARD_VARIANT, AI_CARD_VARIANT]
/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
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
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelOfferStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
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

/**
 * One billing package as a labeled progress bar.
 *
 * A package whose allowance the upstream never reported (`size` not positive)
 * has no percentage to state. It must not fall back to 100%: the plugin would be
 * claiming a full quota it knows nothing about, which is the opposite of the
 * honest "remaining N" line printed below it. Unknown size therefore renders the
 * percent slot as unknown copy and an unfilled, indeterminate track.
 */
function CreditBar({ label, remain, size, t }: {
  label: string
  remain: number
  size: number
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
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
 * Context capacity, listed in full.
 *
 * Every model the upstream reports a capacity for, largest first. A one-line
 * summary with the exceptions on hover was tried and rejected: capacity is
 * reference data you scan by model, and hiding most of it behind a hover made
 * the common case (a model you already have in mind) the hard one to look up.
 *
 * Purely a report of the upstream's own numbers. The plugin offers no tier
 * picker: the CN catalog declares one capacity per model and publishes no
 * alternatives, so a menu there would mean inventing client-side policy. The
 * international document does declare alternatives (`supportedLengths`), and
 * they are shown as a secondary figure rather than merged into one number —
 * the default is the budget actually requested, while the larger value is a
 * ceiling the upstream would accept.
 */
function ContextTable({ models, t }: {
  models: readonly WorkBuddyWebModelBadge[] | undefined
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const known = (models ?? [])
    .filter(model => model.contextWindow !== undefined)
    // Largest first: the big windows are the ones a user reaches for, and the
    // small ones are then easy to spot at the end.
    .sort((a, b) => (b.contextWindow as number) - (a.contextWindow as number))
  if (known.length === 0) return null
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('contextHeading')}</h3>
      {known.map(model => {
        const capacity = model.contextWindow as number
        // Only shown when the upstream declared a larger alternative, so the
        // CN list (which declares none) is unchanged.
        const alternative = model.maxContextWindow !== undefined && model.maxContextWindow > capacity
          ? model.maxContextWindow
          : undefined
        return (
          <div key={model.id} style={quotaLabelStyle}>
            <span>{model.name}</span>
            <span style={modelOfferStyle}>
              <span style={{ textAlign: 'right' }}>{formatTokens(capacity)}</span>
              {alternative === undefined
                ? null
                : <span style={modelRateStyle}>{t('contextUpTo', { size: formatTokens(alternative) })}</span>}
            </span>
          </div>
        )
      })}
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
function ProbeSection({ probe, t, onDetect, onClear, busy }: {
  probe: WorkBuddyWebProbeSection
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
              const name = result?.name ?? id
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
                          ? t('probeRunning', { model: id })
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
      return
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
    // Started after the write resolves, so this read outranks any poll that
    // began earlier and the refreshed list is what stays on screen.
    await refresh(controller.signal)
  }, [refresh, status, t, trackController, variant.probePath])

  /**
   * Run one control action and refresh the card's state afterwards.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here.
   */
  const control = useCallback(async (action: { action: 'probe'; model: string } | { action: 'clear' }): Promise<void> => {
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
        body: JSON.stringify(action),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
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
      if (mounted.current) setBusy(false)
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
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                {busy ? t('refreshing') : t('refresh')}
              </button>
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
                          <div style={rowStyle}>
                            <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                            <span style={bodyStyle}>{t('creditsTotal', { total: formatNumber(status.credits.total) })}</span>
                          </div>
                        </div>
                      )}
                      {status.creditsError === undefined ? null
                        : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                      {status.probe === undefined ? null : (
                        <ProbeSection
                          probe={status.probe}
                          t={t}
                          busy={busy}
                          onDetect={confirmDetect}
                          onClear={() => { void control({ action: 'clear' }) }}
                        />
                      )}
                    </div>
                  ) : tab === 'context' ? (
                    <div style={tabPanelStyle}>
                      <ContextTable models={status.models} t={t} />
                    </div>
                  ) : (
                    <div style={tabPanelStyle}>
                      {status.credits === undefined ? null : (
                        <div style={quotaListStyle}>
                          <h3 style={quotaTitleStyle}>{t('creditsDetailHeading')}</h3>
                          {status.credits.accounts
                            .filter(account => account.remain > 0)
                            .map((account, index) => (
                            <CreditBar
                              key={`${account.packageName}-${String(index)}`}
                              label={account.packageName}
                              remain={account.remain}
                              size={account.size}
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
              ? <p style={status.reason === undefined ? bodyStyle : errorStyle}>
                  {status.reason ?? t(variant.signedOutKey)}
                </p>
              : null}
            {status?.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
          </div>
        : null}
    </li>
  )
}
