// Firefox MV3 treats manifest host_permissions as opt-in: they are NOT granted
// at install, so every 127.0.0.1 loopback fetch is blocked until the user
// approves. Chrome/Edge grant the declared host at install, so contains() is
// already true there and no prompt is shown.
export const LOOPBACK_ORIGIN = 'http://127.0.0.1/*'

interface PermissionsApi {
  contains(perms: { origins: string[] }): Promise<boolean>
  request(perms: { origins: string[] }): Promise<boolean>
}

// Ensure the loopback host permission before any 127.0.0.1 fetch. Must be called
// from a user gesture (a click) so Firefox allows the request prompt. Returns
// true when the permission is held (already granted, or just approved), false
// when the user denies it. If the permissions API is unavailable the capture is
// not blocked — the manifest still declares the host.
export async function ensureHostPermission(
  permissions: PermissionsApi = browser.permissions
): Promise<boolean> {
  try {
    if (await permissions.contains({ origins: [LOOPBACK_ORIGIN] })) return true
    return await permissions.request({ origins: [LOOPBACK_ORIGIN] })
  } catch {
    return true
  }
}
