/**
 * Card chrome for the Plugin configuration contribution.
 *
 * DSH ships the official card shell (`PluginCard`) inside
 * `@deepseek-ai/dsh-client-ui-settings-plugins`, but that package exports only
 * `apply`/`inject` at runtime — the component itself is package-private. The
 * class names below are a deliberate, literal copy of that shell's CSS module
 * (`PluginCard.module.css`, MIT) so a third-party card is indistinguishable
 * from a first-party one: same 16px radius, same hairline border, same
 * hover/open background swap, same `.16s` chevron rotation.
 *
 * This is a namespaced clone of `dsh-loomy-connect`'s `card-css.ts`
 * (MIT): the same fix was first applied there — the original WorkBuddy card
 * used hand-rolled inline styles and a `⌄` glyph that did not match the
 * official card chrome, which is the bug this file resolves.
 *
 * The owner of the stylesheet is this plugin, and its tag id is namespaced to
 * this plugin, so a DSH release that restyles the official shell cannot leave
 * this card half-styled: the two simply drift.
 */

/** Stable tag id; mirrors how the official bundles tag their own stylesheets. */
const STYLE_TAG_ID = 'dsh-workbuddy-connect/WorkBuddyCard.module.css'

/** Prefix keeping every rule out of the official (hashed) class namespace. */
export const CSS = {
  card: 'dwc_card',
  cardOpen: 'dwc_cardOpen',
  header: 'dwc_header',
  headText: 'dwc_headText',
  name: 'dwc_name',
  description: 'dwc_description',
  chevron: 'dwc_chevron',
  chevronOpen: 'dwc_chevronOpen',
  body: 'dwc_body',
  section: 'dwc_section',
  heading: 'dwc_heading',
  row: 'dwc_row',
  status: 'dwc_status',
  tiles: 'dwc_tiles',
  tile: 'dwc_tile',
  tileLabel: 'dwc_tileLabel',
  tileValue: 'dwc_tileValue',
  tileHint: 'dwc_tileHint',
  text: 'dwc_text',
  hint: 'dwc_hint',
  error: 'dwc_error',
  // WorkBuddy-specific extras (kept in the same namespace so the card stays
  // visually consistent with the official shell).
  quotaList: 'dwc_quotaList',
  quotaGroup: 'dwc_quotaGroup',
  quotaTitle: 'dwc_quotaTitle',
  quotaLabel: 'dwc_quotaLabel',
  progressTrack: 'dwc_progressTrack',
  progressFill: 'dwc_progressFill',
  modelBadge: 'dwc_modelBadge',
  modelOffer: 'dwc_modelOffer',
  modelRate: 'dwc_modelRate',
  modelChip: 'dwc_modelChip',
} as const

const STYLESHEET = `
.dwc_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dwc_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dwc_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dwc_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dwc_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dwc_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dwc_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dwc_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dwc_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dwc_chevronOpen{transform:rotate(180deg)}
.dwc_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dwc_section{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dwc_section+.dwc_section{border-top:.5px solid var(--dsw-alias-border-l2)}
.dwc_heading{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:500;line-height:1.5}
.dwc_row{align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between;display:flex}
.dwc_status{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5;display:flex}
.dwc_tiles{flex-wrap:wrap;gap:12px;display:flex}
.dwc_tile{box-sizing:border-box;flex:1 1 180px;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.dwc_tileLabel{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;display:flex}
.dwc_tileValue{margin-top:6px;color:var(--dsw-alias-label-primary);font-size:24px;font-weight:600;line-height:1.25}
.dwc_tileHint{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dwc_text{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:1.5}
.dwc_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
/* The official shell's equivalent rule names --dsw-alias-label-error, which no
   shipped theme defines (the text silently inherits). Use a token that exists. */
.dwc_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}
/* WorkBuddy extras. */
.dwc_quotaList{display:flex;flex-direction:column;gap:18px;padding-top:2px}
.dwc_quotaGroup{display:flex;flex-direction:column;gap:10px}
.dwc_quotaTitle{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dwc_quotaLabel{display:flex;justify-content:space-between;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dwc_progressTrack{height:8px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08))}
.dwc_progressFill{height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary,#1677ff)}
.dwc_modelBadge{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dwc_modelOffer{display:flex;flex-direction:column;gap:2px}
.dwc_modelRate{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwc_modelChip{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.12));color:var(--dsw-alias-state-success-primary,#22a06b)}
`

/**
 * Install the card stylesheet once per document.
 *
 * Called at module scope, so it runs while the module loader materializes this
 * bundle — the same moment the official bundles inject theirs, which is what
 * lets the loader inventory and dispose the tag with the module.
 */
export function ensureWorkBuddyCardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-workbuddy-connect'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = STYLESHEET
  document.head.appendChild(tag)
}

ensureWorkBuddyCardStyles()
