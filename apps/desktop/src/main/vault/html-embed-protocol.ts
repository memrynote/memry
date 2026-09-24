/**
 * `memry-html://` — the only way an attached `.html` file is rendered (#1872).
 *
 * Why not `memry-file://`: every vault file is served from one origin there
 * (`memry-file://local`), that origin is trusted for clipboard/microphone in
 * `session-permissions.ts`, and the app CSP allows `connect-src memry-file:`.
 * An HTML file loaded from it could `fetch()` any note in the vault and post it
 * anywhere. This scheme serves nothing but `.html`/`.htm` files under
 * `<vault>/attachments/`, and every response carries a CSP `sandbox` directive,
 * so the document gets a unique opaque origin even if the embedding iframe's own
 * `sandbox` attribute were ever dropped. From there it can reach the web (the
 * embed is allowed network access by design) but not the vault, the app
 * window, `window.api`, or any other attachment.
 *
 * URL shape mirrors memry-file (`memry-html://local/<absolute path>`) so the
 * renderer can swap the scheme of the URL it already resolved, and the same
 * cross-device remap and rename self-heal apply.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideDirs, resolveLocalSchemePath } from '../lib/external-url'
import { remapCrossDeviceAttachmentPath } from '../lib/attachment-path-remap'
import { createLogger } from '../lib/logger'
import { healAttachmentPath } from './attachment-heal'

const log = createLogger('HtmlEmbed')

export const HTML_EMBED_SCHEME = 'memry-html'

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/**
 * The embedded document's policy.
 *
 * - `sandbox allow-scripts allow-forms allow-popups`: scripts run, JS-handled
 *   forms fire `submit`, and `target="_blank"` links reach the window-open
 *   handler (which opens them in the OS browser). No `allow-same-origin`, no
 *   top navigation, no modals — an `alert()` would block the whole app window.
 * - Loads are limited to `https:`/`wss:`/`data:`/`blob:`. That excludes
 *   `memry-file:` and `memry-html:` (so no sibling files, the embed is one
 *   self-contained document) and plain `http:`, which keeps loopback services
 *   out of reach.
 * - `form-action 'none'`: a form's submit event still fires for scripts that
 *   handle it; only the navigation away is refused.
 */
export const HTML_EMBED_CSP = [
  'sandbox allow-scripts allow-forms allow-popups',
  "default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  'connect-src https: wss: data: blob:',
  "form-action 'none'",
  "object-src 'none'"
].join('; ')

export function isHtmlEmbedPath(filePath: string): boolean {
  return HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * The on-disk file a `memry-html://` URL may serve, or null.
 *
 * Only `.html`/`.htm` files inside a vault's `attachments/` folder qualify. A
 * path written on another device is remapped onto this vault, and a file
 * renamed on disk is healed, exactly as memry-file does for other attachments.
 */
export function resolveHtmlEmbedFile(
  rawUrl: string,
  vaultPaths: ReadonlyArray<string | null | undefined>,
  platform: NodeJS.Platform = process.platform
): string | null {
  const requested = resolveLocalSchemePath(rawUrl, 'memry-html:', platform)
  if (!requested || !isHtmlEmbedPath(requested)) return null

  const vaults = vaultPaths
    .filter((vault): vault is string => Boolean(vault))
    .map((vault) => path.resolve(vault))
  const attachmentRoots = vaults.map((vault) => path.join(vault, 'attachments'))

  let filePath = requested
  if (!isPathInsideDirs(filePath, attachmentRoots, platform)) {
    const remapped = remapCrossDeviceAttachmentPath(filePath, vaults)
    if (!remapped) return null
    filePath = remapped
  }
  if (!existsSync(filePath)) {
    const healed = healAttachmentPath(filePath, vaults)
    if (!healed) return null
    filePath = healed
  }
  return isHtmlEmbedPath(filePath) ? filePath : null
}

/**
 * `text/html` with a UTF-8 default. A file that declares its own charset in
 * its head keeps it; the header would otherwise override the `<meta>`.
 */
function contentTypeFor(bytes: Buffer): string {
  const head = bytes.subarray(0, 1024).toString('latin1')
  return /charset\s*=/i.test(head) ? 'text/html' : 'text/html; charset=utf-8'
}

export async function serveHtmlEmbed(
  request: Request,
  vaultPaths: ReadonlyArray<string | null | undefined>
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
  }
  const filePath = resolveHtmlEmbedFile(request.url, vaultPaths)
  if (!filePath) {
    log.warn('memry-html: refused request outside vault html attachments')
    return new Response(null, { status: 404, statusText: 'Not Found' })
  }
  try {
    const bytes = await readFile(filePath)
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(bytes),
        'Content-Security-Policy': HTML_EMBED_CSP,
        // The URL carries this machine's absolute vault path (and username).
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    log.warn('memry-html: serve failed', { error })
    return new Response(null, { status: 404, statusText: 'Not Found' })
  }
}
