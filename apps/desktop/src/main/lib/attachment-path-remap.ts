import { existsSync } from 'fs'
import path from 'path'

const MARKER = '/attachments/'

/**
 * Remap an attachment path written on another device onto this device's vault.
 *
 * Note blocks store `memry-file://local/<absolute path>` URLs, so a note synced
 * from another machine carries that machine's absolute path (e.g. a macOS
 * `/Users/<name>/…/attachments/<noteId>/<file>` rendered on Linux). The bytes
 * live at the same vault-relative location on every device, so when the
 * requested path is outside this device's allowed roots we resolve the
 * `attachments/<noteId>/<file>` tail against the local vault instead.
 *
 * Returns the local absolute path when the remapped file exists, else null.
 * Rejects any tail with `.`/`..` segments so a crafted URL cannot escape the
 * vault's attachments directory.
 */
export function remapCrossDeviceAttachmentPath(
  requestedPath: string,
  vaultRoots: Array<string | null | undefined>
): string | null {
  const normalized = requestedPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf(MARKER)
  if (idx === -1) return null

  const tail = normalized.slice(idx + MARKER.length)
  const segments = tail.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  if (segments.some((s) => s === '.' || s === '..')) return null

  for (const root of vaultRoots) {
    if (!root) continue
    const attachmentsRoot = path.resolve(root, 'attachments')
    const candidate = path.resolve(attachmentsRoot, ...segments)
    const rel = path.relative(attachmentsRoot, candidate)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (existsSync(candidate)) return candidate
  }

  return null
}
