/**
 * Package version reported by status and doctor output.
 *
 * This value is injected at build time by tsdown's `define` (see
 * tsdown.config.ts), which replaces `__DSH_WORKBUDDY_VERSION__` with the
 * `version` field of package.json. Keeping the source of truth in
 * package.json alone avoids the two-point-maintenance drift where a release
 * bumps npm's version but the code still reports the old one. The
 * `typeof === 'string'` guard keeps the bundle harmless if a build forgets
 * to define it (falls back to a clearly-dev marker).
 */
declare const __DSH_WORKBUDDY_VERSION__: string

export const WORKBUDDY_CONNECT_VERSION: string =
  typeof __DSH_WORKBUDDY_VERSION__ === 'string' ? __DSH_WORKBUDDY_VERSION__ : '0.0.0-dev'
