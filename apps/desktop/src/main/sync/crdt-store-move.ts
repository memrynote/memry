import { cpSync, renameSync, rmSync } from 'fs'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtStoreMove')

const MOVE_RETRY_DELAYS_MS = [50, 150, 400]

/**
 * Move a CRDT store directory, tolerating a locked source.
 *
 * On Windows the store dir is regularly still held for a moment after the
 * preflight child exits — by AV scanning the LDB files, by the vault watcher,
 * or by the dying child itself — and `rename` fails EPERM. Retry with backoff,
 * then fall back to copy+delete so the user's CRDT history is never stranded
 * in a `.broken-*` dir. Returns false only if the directory could not be moved
 * at all; the caller decides what that means.
 */
export async function moveStoreDir(from: string, to: string): Promise<boolean> {
  // One attempt, then one per backoff delay.
  for (let attempt = 0; attempt <= MOVE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(from, to)
      return true
    } catch (err) {
      if (attempt === MOVE_RETRY_DELAYS_MS.length) {
        log.warn('Renaming the CRDT store failed — falling back to copy', { from, to, error: err })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, MOVE_RETRY_DELAYS_MS[attempt]))
    }
  }

  try {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
    return true
  } catch (err) {
    log.warn('Copying the CRDT store failed', { from, to, error: err })
    // Leave the source as the single copy rather than two half-moved ones.
    try {
      rmSync(to, { recursive: true, force: true })
    } catch {
      // best effort
    }
    return false
  }
}
