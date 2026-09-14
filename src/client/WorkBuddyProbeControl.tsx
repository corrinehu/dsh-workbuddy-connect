/**
 * Per-model reasoning-effort entry beside the Composer's model selector.
 *
 * Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
 * same seat, which is the established shape for composer chrome here:
 *
 * - a **static inline label** next to the icon names the feature ("Reasoning
 *   levels"), set smaller and dimmer than the surrounding chrome so it reads as
 *   an annotation on the icon. It never carries state: the verified levels
 *   already appear in the model dropdown (the adapter exposes them as
 *   selectable efforts), so repeating them here would duplicate the real answer
 *   and make the label's width jump as results change.
 * - a **hover/focus tooltip** carries the state and the click's purpose, the way
 *   Fast Mode's tooltip explains its current speed.
 * - the **confirmation** is a small bubble anchored to the control, not a
 *   `window.confirm`. Probing spends real credit, so a confirmation stays — but
 *   it belongs next to the thing it acts on, sized to one line plus two small
 *   buttons.
 *
 * @module dsh-workbuddy-connect/client/probe-control
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { CARD_VARIANTS, type WorkBuddyCardVariant, type WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { isWorkBuddyWebStatus } from './status-document.ts'
import type { WorkBuddyWebProbeModel, WorkBuddyWebStatus } from '../status-paths.ts'

/** Injected props; `directory` resolves the session's current model selection. */
export interface WorkBuddyProbeControlProps extends WorkBuddyPluginCardInjected {
  directory: ModelDirectory['store']
}

/**
 * The card (and therefore the routes) a selected provider belongs to.
 *
 * The control serves both WorkBuddy providers from one seat, so the provider id
 * is what selects the status and probe endpoints. Returning `undefined` for any
 * other provider is what keeps the icon off every non-WorkBuddy model.
 */
export function cardVariantFor(provider: string): WorkBuddyCardVariant | undefined {
  return CARD_VARIANTS.find(card => card.id === provider)
}

/** How often the control re-checks state when the window regains focus. */
const RECONCILE_MS = 60_000


// The host slot's baseline sits a touch high and leaves a full inter-control gap
// before the model picker. Nudge only this annotation down and inward so it
// reads as part of the selected model rather than a separate toolbar item.
const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  position: 'relative',
  alignItems: 'center',
  transform: 'translateY(2px)',
  marginRight: -8,
}
const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  // Tight gap: the label is an annotation on the icon, not a peer of the model
  // name it sits beside.
  gap: 2,
  height: 30,
  padding: '0 6px',
  border: 0,
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

/**
 * The inline label. Smaller and dimmer than the surrounding chrome on purpose:
 * it names the feature, so it should read as an annotation attached to the icon
 * rather than compete with the adjacent model selector.
 */
const labelStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** Tooltip bubble: the Fast Mode shape (nowrap, one line, above the control). */
const tooltipStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 'calc(100% + 8px)',
  zIndex: 1000,
  transform: 'translateX(-50%)',
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--dsw-specific-tip, #1f2329)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary, #fff)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
const confirmStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 1001,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  width: 260,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
}
const confirmRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const confirmButtonStyle: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
/**
 * Primary action inside the confirmation bubble.
 *
 * The fill and its text colour must come as a pair: `brand-primary` resolves to
 * a light accent in this theme, so hardcoding `color: #fff` on top of it renders
 * white-on-white. `button-primary-fill` + `label-primary-foreground` is the
 * theme's own pair for exactly this, and is what `dsh-codex-connect` uses for
 * the same job.
 */
const primaryButtonStyle: CSSProperties = {
  ...confirmButtonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

/**
 * Result note: a single line + a dismiss button, anchored to the control's
 * right side. Smaller than the confirmation bubble because it carries an
 * *outcome*, not a *decision* — the work is done, the user only has to read
 * and dismiss.
 */
const noteStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 1001,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}
/**
 * The note's dismiss action. Outlined rather than bare text: inside an already
 * bordered bubble, an unbordered word does not read as something you can click.
 * Matches the outlined pill convention the plugin's other secondary actions use.
 */
const noteDismissStyle: CSSProperties = {
  padding: '2px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

/**
 * The feature's static inline label. Deliberately not a state readout — see the
 * module comment.
 */
function useLabel(t: WorkBuddyPluginCardInjected['t']): string {
  return t('probeLabel')
}

/** Pick the model's recorded observation out of the probe section. */
function resultFor(status: WorkBuddyWebStatus, model: string): WorkBuddyWebProbeModel | undefined {
  if (status.status !== 'signed-in') return undefined
  return status.probe?.results.find(result => result.id === model)
}

/**
 * The one-line tooltip: current state first, then what a click does — the same
 * two-part shape Fast Mode uses.
 *
 * A recorded result outranks a remembered failure. `failed` only means "the last
 * run from this control did not complete"; the host can record a result for the
 * same model at any time (a detection started from the settings card, another
 * conversation, or a finished sweep), and the levels the user paid for are the
 * more useful answer than the stale failure. Failure copy is what remains when
 * there is no result to report.
 */
function tooltipText(
  t: WorkBuddyPluginCardInjected['t'],
  model: string,
  state: { busy: boolean; failed: boolean; result?: WorkBuddyWebProbeModel | undefined },
): string {
  if (state.busy) return t('probeRunning', { model })
  const result = state.result
  if (result !== undefined) {
    if (result.validation === 'validating' && result.efforts.length > 0) {
      return t('probeTooltipVerified', { levels: result.efforts.join(' / ') })
    }
    if (result.validation === 'non-validating') return t('probeTooltipNotValidating')
    return t('probeTooltipRetry')
  }
  if (state.failed) return t('probeTooltipRetry')
  return t('probeTooltipIdle', { model })
}

/** Model-independent shell: resolves the selection, then delegates per model. */
export function WorkBuddyProbeControl({ directory, t }: WorkBuddyProbeControlProps) {
  const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot).current
  const card = selection === undefined ? undefined : cardVariantFor(selection.provider)
  // `card` identifies both the variant and its routes: a selection under either
  // provider resolves to exactly one card's status/probe pair, so the control
  // can never read one variant's state while probing the other.
  const key = card === undefined || selection === undefined ? undefined : `${card.id}:${selection.model}`
  // A new selection gets fresh state; a late response cannot target the new model.
  return card === undefined || selection === undefined || key === undefined
    ? null
    : <ModelProbe key={key} model={selection.model} card={card} label={useLabel(t)} t={t} />
}

function ModelProbe({ model, card, label, t }: {
  model: string
  card: WorkBuddyCardVariant
  label: string
} & WorkBuddyPluginCardInjected) {
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  // Only an explicit detection response opens a note. Background reads and
  // remounts never replay stored results; no persisted "seen" marks are needed.
  const [note, setNote] = useState<WorkBuddyWebProbeModel>()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const tooltipId = useId()

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(card.statusPath, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    /*
     * A 200 does not promise a status document: the body may be empty, literal
     * `null`, or a non-JSON page. Storing that unchecked would put a value in
     * state that `resultFor` dereferences on the next render, so it is validated
     * here with the same predicate the settings card uses. A rejection is left to
     * the callers below, which already degrade quietly.
     */
    const value: unknown = await response.json().catch(() => undefined)
    if (!isWorkBuddyWebStatus(value)) throw new Error(t('statusResponseInvalid'))
    if (mounted.current && !signal?.aborted) setStatus(value)
  }, [card.statusPath, t])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const load = (): void => {
      void refresh(controller.signal).catch(() => { /* the icon still works without state */ })
    }
    load()
    // Reconcile detections performed in another conversation or in the card.
    const timer = window.setInterval(load, RECONCILE_MS)
    window.addEventListener('focus', load)
    return () => {
      mounted.current = false
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [refresh])

  const probe = status?.status === 'signed-in' ? status.probe : undefined
  const key = status?.status === 'signed-in' ? status.probeKey : undefined
  const result = status === undefined ? undefined : resultFor(status, model)
  const eligible = probe?.candidates.includes(model) === true
  // Once a model has been detected it leaves the candidate list, so keep the
  // entry visible for it: that is the case the tooltip reports a result in.
  const visible = eligible || result !== undefined

  // A recorded result answers the question a remembered failure was about, so
  // the flag is dropped with it rather than lingering into the next render.
  useEffect(() => {
    if (result !== undefined) setFailed(false)
  }, [result])

  // A selection change must not strand an open bubble.
  useEffect(() => { setConfirming(false); setNote(undefined) }, [model])

  const detect = async (): Promise<void> => {
    if (key === undefined || inFlight.current || probe?.running === true) return
    inFlight.current = true
    setNote(undefined)
    setConfirming(false)
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(card.probePath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        body: JSON.stringify({ action: 'probe', model }),
      })
      const body = await response.json() as {
        state?: string; validation?: string; efforts?: unknown
      }
      if (!response.ok || body.state !== 'ok'
        || (body.validation !== 'validating' && body.validation !== 'non-validating')
        || !Array.isArray(body.efforts) || !body.efforts.every(effort => typeof effort === 'string')) {
        throw new Error('probe failed')
      }
      // This response belongs to the explicit click, even when the host reused
      // an older cached result. Do not wait for /status (which fetches credit),
      // or infer completion from wall-clock timestamps and background polls.
      if (mounted.current) {
        const completed: WorkBuddyWebProbeModel = {
          id: model, name: model, validation: body.validation,
          efforts: body.efforts, probedAt: Date.now(),
        }
        setNote(completed)
      }
      void refresh().catch(() => { /* Credit/status failure does not undo a completed probe. */ })
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (!visible) return null

  const text = tooltipText(t, model, { busy, result, failed })
  const disabled = busy || probe?.running === true || key === undefined
  // Both bubbles and the tooltip anchor to the same spot above the control, so
  // only one may be open at a time. The confirmation and the result note both
  // suppress the tooltip: leaving it visible would overlap them, and the note
  // already states the same outcome the tooltip would.
  const showTooltip = tooltipVisible && !confirming && note === undefined

  return (
    <span
      style={wrapperStyle}
      onMouseEnter={() => { setTooltipVisible(true) }}
      onMouseLeave={() => { setTooltipVisible(false) }}
    >
      <button
        type="button"
        aria-label={text}
        aria-describedby={showTooltip ? tooltipId : undefined}
        aria-busy={busy}
        aria-expanded={confirming}
        disabled={disabled}
        onClick={() => { setConfirming(true) }}
        onFocus={() => { setTooltipVisible(true) }}
        onBlur={() => { setTooltipVisible(false) }}
        style={{ ...buttonStyle, opacity: disabled && !confirming ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" />
          <path d="M12 12 20 4" />
          <circle cx="12" cy="12" r="1" />
        </svg>
        <span style={labelStyle}>{label}</span>
      </button>

      {showTooltip && (
        <span id={tooltipId} role="tooltip" style={tooltipStyle}>{text}</span>
      )}

      {confirming && (
        <span style={confirmStyle}>
          <span>{t('probeBubbleBody')}</span>
          <span style={confirmRowStyle}>
            <button type="button" style={confirmButtonStyle} onClick={() => { setConfirming(false) }}>
              {t('cancel')}
            </button>
            <button type="button" style={primaryButtonStyle} onClick={() => { void detect() }}>
              {t('probeConfirmAction')}
            </button>
          </span>
        </span>
      )}

      {note === undefined ? null : (
        <span role="status" aria-live="polite" style={noteStyle}>
          <span>{noteText(t, note)}</span>
          <button
            type="button"
            style={noteDismissStyle}
            onClick={() => {
              setNote(undefined)
            }}
          >
            {t('probeNoteDismiss')}
          </button>
        </span>
      )}
    </span>
  )
}

/** Compose the one-line outcome string the note bubble shows. */
function noteText(t: WorkBuddyPluginCardInjected['t'], result: WorkBuddyWebProbeModel): string {
  if (result.validation === 'validating' && result.efforts.length > 0) {
    return t('probeNoteVerified', { levels: result.efforts.join(' / ') })
  }
  if (result.validation === 'non-validating') return t('probeNoteNotValidating')
  return t('probeNoteUnknown')
}
