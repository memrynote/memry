/**
 * Downloading a custom icon that the user gave us as a link.
 *
 * The remote image is pulled exactly once, here, and from then on the icon is
 * an ordinary local one: bytes on disk under `<vault>/.memry/icons` and inside
 * the sync record. Nothing keeps the URL, so rendering an icon never makes a
 * request and a dead or hijacked link cannot change what the user sees.
 *
 * Everything that arrives over the wire is treated as hostile input: the
 * scheme is allowlisted, the body is read through a hard byte cap rather than
 * trusting `content-length`, and the bytes are validated as an image before
 * they are stored (raster formats are re-encoded by the caller, SVG must at
 * least contain an `<svg` root).
 *
 * @module icons/remote-icon
 */

import path from 'path'
import {
  CUSTOM_ICON_INPUT_EXTENSIONS,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  CUSTOM_ICON_NAME_MAX_LENGTH,
  type CustomIconInputExtension
} from '@memry/contracts/custom-icons-api'
import { getMainI18n } from '../lib/main-i18n'
import { createLogger } from '../lib/logger'

const log = createLogger('RemoteIcon')

/** Give up on a slow host rather than leaving the picker spinning. */
const DOWNLOAD_TIMEOUT_MS = 10_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CONTENT_TYPE_EXTENSIONS: Record<string, CustomIconInputExtension> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

export interface RemoteIcon {
  bytes: Buffer
  ext: CustomIconInputExtension
  /** Name derived from the link, used when the caller has none. */
  name: string
}

/**
 * Fetch through Electron's Chromium network stack when available.
 *
 * Node's fetch (undici) has a TLS fingerprint that Cloudflare and similar bot
 * walls reject, which would turn ordinary CDN-hosted images into failures.
 * Falls back to global fetch outside Electron (node-side tests).
 */
async function chromiumFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const { net } = await import('electron')
    if (typeof net?.fetch === 'function') return net.fetch(url, init)
  } catch {
    // not running inside Electron
  }
  return fetch(url, init)
}

/** Parse a user-supplied link, accepting only the two schemes we fetch. */
export function parseIconUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(getMainI18n().t('errors:customIcon.invalidUrl'))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(getMainI18n().t('errors:customIcon.invalidUrl'))
  }
  return url
}

/**
 * Decide the input format.
 *
 * `content-type` wins because it is what the server actually served; the URL's
 * extension is only a fallback for hosts that answer `application/octet-stream`
 * or nothing at all.
 */
export function pickIconExtension(
  url: URL,
  contentType: string | null
): CustomIconInputExtension | null {
  const declared = CONTENT_TYPE_EXTENSIONS[(contentType ?? '').split(';')[0].trim().toLowerCase()]
  if (declared) return declared

  const ext = path.extname(url.pathname).slice(1).toLowerCase()
  const normalized = ext === 'jpeg' ? 'jpg' : ext
  return (CUSTOM_ICON_INPUT_EXTENSIONS as readonly string[]).includes(normalized)
    ? (normalized as CustomIconInputExtension)
    : null
}

/** Default label for a downloaded icon: its file name, else the host. */
export function iconNameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  let base = ''
  try {
    base = decodeURIComponent(last)
  } catch {
    base = last
  }
  base = base.replace(/\.[^.]+$/, '').trim()
  return (base || url.hostname).slice(0, CUSTOM_ICON_NAME_MAX_LENGTH)
}

/**
 * Read the body with a hard ceiling.
 *
 * `content-length` is checked first as a courtesy, but it is a claim by the
 * remote host, so the stream is capped independently — a server that lies, or
 * omits the header and streams forever, stops at the same 2 MB.
 */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(getMainI18n().t('errors:customIcon.tooLarge'))
  }

  const body = response.body
  if (!body) throw new Error(getMainI18n().t('errors:customIcon.downloadFailed'))

  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(getMainI18n().t('errors:customIcon.tooLarge'))
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** Download and validate the image behind a link. */
export async function downloadRemoteIcon(raw: string): Promise<RemoteIcon> {
  const url = parseIconUrl(raw)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  let response: Response
  try {
    response = await chromiumFetch(url.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' }
    })
  } catch (error) {
    log.warn('Custom icon download failed', { host: url.hostname, error })
    throw new Error(getMainI18n().t('errors:customIcon.downloadFailed'))
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    log.warn('Custom icon download rejected', { host: url.hostname, status: response.status })
    throw new Error(getMainI18n().t('errors:customIcon.downloadFailed'))
  }

  const ext = pickIconExtension(url, response.headers.get('content-type'))
  if (!ext) throw new Error(getMainI18n().t('errors:customIcon.unsupportedUrl'))

  const bytes = await readCapped(response, CUSTOM_ICON_MAX_INPUT_BYTES)
  if (bytes.length === 0) throw new Error(getMainI18n().t('errors:customIcon.downloadFailed'))

  // SVG is the one format stored verbatim, so it is the one format whose bytes
  // nothing else inspects — a host that labels an error page `image/svg+xml`
  // would otherwise land in the library as an icon that renders as nothing.
  if (ext === 'svg' && !/<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
    throw new Error(getMainI18n().t('errors:customIcon.unreadableImage'))
  }

  return { bytes, ext, name: iconNameFromUrl(url) }
}
