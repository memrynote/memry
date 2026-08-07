/**
 * Per-vault record of OneNote pages already imported, backing the importer's
 * "skip previously imported" option (and letting a cancelled import resume
 * where it stopped).
 *
 * Stored as JSON in the vault's `.memry` sidecar folder so it travels with the
 * vault, not the app install. A missing or corrupt file simply means "nothing
 * imported yet".
 *
 * @module main/import/onenote/onenote-state
 */

import path from 'path'
import { atomicWrite, ensureDirectory, safeRead } from '../../vault/file-ops'
import { getStatus } from '../../vault/index'
import { createLogger } from '../../lib/logger'

const logger = createLogger('OneNoteImport')

const STATE_VERSION = 1

export interface OneNoteImportState {
  version: number
  /** OneNote page id → ISO timestamp of when it was imported. */
  importedPageIds: Record<string, string>
}

function emptyState(): OneNoteImportState {
  return { version: STATE_VERSION, importedPageIds: {} }
}

function stateFilePath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new Error('No vault is currently open')
  }
  return path.join(status.path, '.memry', 'import', 'onenote.json')
}

/** Load the state (missing/corrupt file → empty state). */
export async function loadOneNoteImportState(): Promise<OneNoteImportState> {
  const raw = await safeRead(stateFilePath())
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<OneNoteImportState>
    if (parsed && typeof parsed.importedPageIds === 'object' && parsed.importedPageIds !== null) {
      return { version: STATE_VERSION, importedPageIds: { ...parsed.importedPageIds } }
    }
  } catch (error) {
    logger.warn('OneNote import state unreadable, starting fresh', { error })
  }
  return emptyState()
}

/**
 * Persist the state (atomic write into the vault sidecar folder), merged with
 * whatever is already on disk.
 *
 * Two windows can run a OneNote import at once, each holding the snapshot it
 * loaded at start; a blind overwrite would erase the other run's recorded
 * pages, and those pages would re-import as duplicate notes on the next run.
 * The caller's object is updated in place so it keeps the merged view.
 */
export async function saveOneNoteImportState(state: OneNoteImportState): Promise<void> {
  const filePath = stateFilePath()
  const onDisk = await loadOneNoteImportState()
  const merged = { ...onDisk.importedPageIds, ...state.importedPageIds }
  state.importedPageIds = merged

  await ensureDirectory(path.dirname(filePath))
  await atomicWrite(filePath, JSON.stringify({ version: STATE_VERSION, importedPageIds: merged }))
}
