import { session, type Session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createLogger } from './lib/logger'

const permissionLog = createLogger('SessionPermissions')

/**
 * Renderer permissions the app actually uses. Everything else is denied:
 * - `media`: voice recorder microphone capture (audio only — video is never requested)
 * - `clipboard-read`: quick capture reads the clipboard to prefill a capture
 * - `clipboard-sanitized-write`: copy actions across the app (navigator.clipboard.writeText)
 * - `notifications`: inbox review notifications via the HTML5 Notification API
 * - `fileSystem`: the canvas library panel imports/exports `.excalidrawlib`
 *   files through the File System Access API (Excalidraw uses
 *   browser-fs-access). Denying it let the OS picker open and then failed the
 *   subsequent `handle.getFile()` read, surfacing as "Couldn't load library".
 *   Every access is still driven by a picker the user opens themselves, and
 *   `isTrustedAppOrigin` keeps it away from embedded web content.
 * - `local-fonts`: the appearance settings font picker enumerates the fonts
 *   installed on this machine with `queryLocalFonts()` so every row can preview
 *   its own typeface. Chromium answers it through the check handler without a
 *   user prompt, and `isTrustedAppOrigin` keeps this fingerprinting surface away
 *   from embedded web content.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fileSystem',
  'local-fonts'
])

export interface PermissionPolicyOptions {
  /**
   * Trust http://localhost / http://127.0.0.1 origins (Vite dev server).
   * Must be false in packaged builds.
   */
  allowDevServerOrigins: boolean
}

export interface PermissionDecisionDetails {
  /** Media types attached to a `media` permission request or check. */
  mediaTypes?: readonly string[]
}

/**
 * Whether a permission request comes from the app's own pages: the packaged
 * renderer loads via file://, vault assets via the memry-file:// scheme, and
 * the dev renderer from a localhost Vite server. Everything else (embedded
 * iframes such as YouTube, arbitrary web content) is untrusted.
 */
export function isTrustedAppOrigin(
  requestingOrigin: string | undefined,
  options: PermissionPolicyOptions
): boolean {
  if (!requestingOrigin) return false

  let parsed: URL
  try {
    parsed = new URL(requestingOrigin)
  } catch {
    return false
  }

  if (parsed.protocol === 'file:' || parsed.protocol === 'memry-file:') return true

  if (
    options.allowDevServerOrigins &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true
  }

  return false
}

/**
 * Pure deny-by-default permission decision shared by the request handler and
 * the check handler so both always agree.
 */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string | undefined,
  details: PermissionDecisionDetails,
  options: PermissionPolicyOptions
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (!isTrustedAppOrigin(requestingOrigin, options)) return false

  if (permission === 'media') {
    // The voice recorder captures audio only; any video (or unknown) capture
    // request is denied. Checks without an explicit media type (e.g. device
    // enumeration) are allowed since the origin is already trusted.
    const mediaTypes = details.mediaTypes ?? []
    return mediaTypes.every((type) => type === 'audio')
  }

  return true
}

/**
 * Registers deny-by-default permission handlers on the session the app's
 * windows use. Without these, Electron auto-grants every renderer permission
 * request (camera, geolocation, midi, ...).
 */
export function configureSessionPermissions(targetSession: Session = session.defaultSession): void {
  const options: PermissionPolicyOptions = { allowDevServerOrigins: is.dev }

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details.requestingUrl || webContents.getURL()
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    const allowed = isPermissionAllowed(permission, requestingOrigin, { mediaTypes }, options)
    if (!allowed) {
      permissionLog.warn('Denied renderer permission request', { permission, requestingOrigin })
    }
    callback(allowed)
  })

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType === undefined ? undefined : [details.mediaType]
    const allowed = isPermissionAllowed(permission, requestingOrigin, { mediaTypes }, options)
    if (!allowed) {
      permissionLog.debug('Denied renderer permission check', { permission, requestingOrigin })
    }
    return allowed
  })

  permissionLog.info('Deny-by-default session permission handlers configured')
}
