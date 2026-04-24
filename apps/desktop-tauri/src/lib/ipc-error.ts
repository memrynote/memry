/**
 * Extract a human-readable message from an unknown error value.
 *
 * Tauri surfaces backend failures as plain strings (serialized `AppError`s) or
 * `Error` objects. This helper normalises both into a short, user-facing
 * string while falling back to `fallback` when no useful content is present.
 *
 * The Electron-era version stripped `Error occurred in handler for '...'` and
 * similar `ipcMain.invoke` framing; Tauri has no analogous prefix, so the
 * implementation is intentionally small.
 */
export function extractErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string') return err || fallback
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message
    if (typeof message === 'string') return message || fallback
  }
  return fallback
}
