/**
 * Huaqiu Desktop product identity.
 *
 * These are the runtime-facing halves of the distribution identity: the name the
 * About panel and installer show, and the OS URL scheme the installer registers.
 * The build-time halves (`productName`, `appId`, artifact names, icons) live in
 * `scripts/electron-builder-config.mjs` and the packaging environment.
 *
 * Keep the package name (`@deepseek-ai/dsh-desktop`) and the in-app document
 * scheme (`dsh-app`, `ipc.ts`) unchanged: Electron derives `userData` from the
 * package name, so renaming it would strand every existing Huaqiu profile.
 */

/** Product name shown in the About panel, installer and window title. */
export const DESKTOP_PRODUCT_NAME = 'Huaqiu Hardware Engineering'

/** OS URL scheme this distribution claims (`huaqiu://open`). */
export const DESKTOP_PROTOCOL_SCHEME = 'huaqiu'

/**
 * Scheme the previous distribution registered. Huaqiu keeps answering it so
 * links already handed to users (`dsh://open`) still focus the workspace.
 */
export const DESKTOP_LEGACY_PROTOCOL_SCHEME = 'dsh'
