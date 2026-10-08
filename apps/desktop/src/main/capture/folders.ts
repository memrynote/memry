import { createHash } from 'node:crypto'
import path from 'node:path'
import { getStatus } from '../vault'
import { getFolders } from '../vault/notes'
import { fileToFolder } from '../inbox/filing'
import { createLogger } from '../lib/logger'

const log = createLogger('Capture:Folders')

export interface CaptureFolderList {
  vaultId: string
  vaultName: string
  folders: string[]
}

// Opaque per-machine vault id for the extension. A hash, so the vault's absolute
// path never reaches extension storage (a queued capture stores this id).
function vaultIdFor(vaultPath: string): string {
  return createHash('sha256').update(vaultPath).digest('hex').slice(0, 32)
}

// Same folder set as the sidebar notes tree (getFolders applies the visibility
// filter), vault-relative, sorted for a stable picker.
export async function listCaptureFolders(): Promise<CaptureFolderList | null> {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) return null
  const folders = (await getFolders()).map((f) => f.path).sort((a, b) => a.localeCompare(b))
  return { vaultId: vaultIdFor(vaultPath), vaultName: path.basename(vaultPath), folders }
}

export type RouteResult = { filedTo: string } | { filedTo: null; reason: string }

// The clip is already in the Inbox. File it only when it targets the vault that
// is open now and a folder that still exists; fileToFolder would otherwise
// create the folder, and a stale or foreign path must not plant one. Any failure
// leaves the item in the Inbox.
export async function routeCaptureToFolder(
  itemId: string,
  folder: string,
  vaultId: string | undefined
): Promise<RouteResult> {
  try {
    const list = await listCaptureFolders()
    if (!list || list.vaultId !== vaultId) return { filedTo: null, reason: 'vault-mismatch' }
    if (!list.folders.includes(folder)) return { filedTo: null, reason: 'folder-missing' }
    const res = await fileToFolder(itemId, folder)
    if (!res.success) {
      log.warn('filing capture failed, kept in inbox', { itemId, error: res.error })
      return { filedTo: null, reason: 'file-failed' }
    }
    return { filedTo: folder }
  } catch (err) {
    log.warn('filing capture threw, kept in inbox', { itemId, err })
    return { filedTo: null, reason: 'file-failed' }
  }
}
