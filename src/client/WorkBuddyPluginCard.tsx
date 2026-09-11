/**
 * WorkBuddy status card contributed to Harness Plugin configuration.
 *
 * The chrome mirrors the official card shell — see `./card-css.ts` for why the
 * CSS module is copied rather than imported. This replaces the old
 * hand-rolled inline `cardStyle`/`headerStyle`/... and the `⌄` glyph, which did
 * not match the official expand/collapse card. The fix was first applied to
 * `dsh-loomy-connect` (MIT) and ported here.
 *
 * Interactive primitives keep using inline styles: the WorkBuddy card shows a
 * credit progress bar and model-offer rows that the official module has no
 * class for, and this port deliberately stays dependency-light.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'
import { CSS } from './card-css.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

/** Join the base class with its modifier, the way the official shell does. */
function withModifier(base: string, modifier: string, on: boolean): string {
  return on ? `${base} ${modifier}` : base
}

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

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  return badge
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

function dotStyle(status: WorkBuddyWebStatus['status']): CSSProperties {
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

/** One billing package as a labeled progress bar. */
function CreditBar({ label, remain, size, t }: {
  label: string
  remain: number
  size: number
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const detail = size > 0 ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) }) : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = size > 0 ? (remain / size) * 100 : 100
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t('percentRemaining', { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div style={progressFillStyle(percent)} />
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
      {model.credits === undefined ? null : <span style={modelRateStyle}>{t('rate', { rate: model.credits })}</span>}
    </div>
  )
}

/** Render WorkBuddy sign-in state and credit as one expandable card. */
export function WorkBuddyPluginCard({ t }: WorkBuddyPluginCardProps) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WorkBuddyWebStatus>({ status: 'signed-out' })
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(WORKBUDDY_STATUS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (mounted.current && signal?.aborted !== true) setStatus(value as WorkBuddyWebStatus)
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
      }
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, refresh])

  useEffect(() => {
    if (!open || status.status !== 'signed-in') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh, status.status])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const title = t('title')
  const label = status.status === 'signed-in'
    ? status.nickname === undefined ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '') : t('signedInAs', { nickname: status.nickname })
    : status.status === 'error'
      ? t('requestFailed')
      : t('signedOut')

  return (
    <li className={withModifier(CSS.card, CSS.cardOpen, open)}>
      <button
        type="button"
        className={CSS.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={CSS.headText}>
          <span className={CSS.name}>{title}</span>
          <span className={CSS.description}>{t('intro')}</span>
        </span>
        <svg
          width={14}
          height={14}
          className={withModifier(CSS.chevron, CSS.chevronOpen, open)}
          viewBox="0 0 14 14"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
            fill="currentColor"
          />
        </svg>
      </button>
      {open
        ? <div className={CSS.body}>
            <div className={CSS.section}>
              <h3 className={CSS.heading}>{t('accountHeading')}</h3>
              <div className={CSS.row}>
                <div className={CSS.status} role="status">
                  <span aria-hidden="true" style={dotStyle(status.status)} />
                  <span>{label}</span>
                </div>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                  {busy ? t('refreshing') : t('refresh')}
                </button>
              </div>
            </div>
            {status.status === 'signed-in'
              ? <>
                  {status.expiresAt === undefined ? null
                    : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}
                  {status.credits === undefined ? null : (
                    <div style={quotaListStyle}>
                      <div style={rowStyle}>
                        <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                        <span style={bodyStyle}>{t('creditsTotal', { total: formatNumber(status.credits.total) })}</span>
                      </div>
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
                  {status.creditsError === undefined ? null
                    : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                  {status.models === undefined || status.models.length === 0 ? null : (
                    <div style={quotaListStyle}>
                      <h3 style={quotaTitleStyle}>{t('modelsHeading')}</h3>
                      {status.models.map(model => <ModelOfferRow key={model.id} model={model} t={t} />)}
                    </div>
                  )}
                </>
              : null}
            {status.status === 'signed-out' ? <p style={bodyStyle}>{t('signedOutHint')}</p> : null}
            {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
          </div>
        : null}
    </li>
  )
}
