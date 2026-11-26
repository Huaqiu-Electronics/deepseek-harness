/**
 * Huaqiu Desktop product identity shared by packaging scripts and packaged-artifact checks.
 *
 * `apps/desktop/src/branding.ts` carries the same name for the runtime (About panel and
 * OS URL scheme registration); the distribution gate keeps the two in step. Keep the
 * package name `@deepseek-ai/dsh-desktop` unchanged — Electron derives `userData` from it.
 */

export const DESKTOP_PRODUCT_NAME = 'Huaqiu Electronic Design Agent Platform'

export const DESKTOP_PROTOCOL_SCHEME = 'huaqiu'
