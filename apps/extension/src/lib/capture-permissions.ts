import { originPatternOf } from './pdf-capture'

// Firefox MV3 treats manifest host_permissions as opt-in: they are NOT granted
// at install, so every 127.0.0.1 loopback fetch is blocked until the user
// approves. Chrome/Edge grant the declared host at install, so contains() is
// already true there and no prompt is shown.
export const LOOPBACK_ORIGIN = 'http://127.0.0.1/*'

interface PermissionsApi {
  contains(perms: { origins: string[] }): Promise<boolean>
  request(perms: { origins: string[] }): Promise<boolean>
}

// Ensure every origin this capture needs, in ONE request so the user gesture is
// not split — Firefox drops the prompt for a second, await-separated request.
// `pageUrl` is the tab we may need to re-fetch (PDF mode); pass null for captures
// that only talk to the desktop app.
export async function ensureCapturePermissions(
  pageUrl: string | null,
  permissions: PermissionsApi = browser.permissions
): Promise<boolean> {
  const pagePattern = pageUrl ? originPatternOf(pageUrl) : null
  const origins = pagePattern ? [LOOPBACK_ORIGIN, pagePattern] : [LOOPBACK_ORIGIN]
  try {
    if (await permissions.contains({ origins })) return true
    return await permissions.request({ origins })
  } catch {
    return true
  }
}

// Check-only variant for the background service worker, which has no user
// gesture and therefore cannot prompt. Unlike ensureCapturePermissions, an
// unavailable permissions API means "no" — we must not attempt a fetch we
// are not allowed to make.
export async function hasOriginPermission(
  pageUrl: string,
  permissions: PermissionsApi = browser.permissions
): Promise<boolean> {
  const pattern = originPatternOf(pageUrl)
  if (!pattern) return false
  try {
    return await permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}
