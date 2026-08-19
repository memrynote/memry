import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { openCrdtPersistence, type CrdtPersistence } from './crdt-persistence'

// Same scope as crdt-provider on purpose: production log triage greps for
// 'CrdtProvider' when it is looking at the CRDT store.
const log = createLogger('CrdtProvider')

/**
 * Name prefix for a document that was inherited but cannot be attributed.
 *
 * A note id is a bare token — 12 lowercase alphanumerics, or `j` + an ISO date
 * for a journal — so nothing the app opens can ever collide with this prefix.
 * Setting a document aside under it therefore takes it out of reach of every
 * note without deleting a single byte the user might one day want back.
 */
export const UNATTRIBUTABLE_DOC_PREFIX = '__memry_unattributable__/'

/**
 * Is this document's id one that two vaults could genuinely both have written?
 *
 * Note ids are random 12-character tokens, so a legacy document under one is
 * the history of exactly one vault's note even when it is the *wrong* vault's:
 * the inheriting vault never opens that id, and the entry sits inert. Journal
 * notes are the exception — their id is derived from the date (`j2026-08-13`),
 * so every vault names its journal for a given day identically, and the legacy
 * store holds one document per day for all of them merged together. That is
 * the only id the app generates deterministically today.
 */
export function isCrossVaultAmbiguousDocId(docName: string): boolean {
  return /^j\d{4}-\d{2}-\d{2}$/.test(docName)
}

/**
 * `getAllDocNames` is on y-leveldb's persistence but not on the narrow surface
 * `CrdtPersistence` declares, because nothing else in the app enumerates the
 * store. Widening the shared interface for a one-shot migration would put a
 * method on every consumer's type that only this file calls.
 */
type EnumerableCrdtPersistence = CrdtPersistence & {
  getAllDocNames?: () => Promise<string[]>
}

/**
 * Take every cross-vault-ambiguous document in an inherited store out of reach
 * of the notes that would otherwise load it.
 *
 * Each one is copied to a reserved name and then cleared from its own, so the
 * vault's journal for that day re-seeds from its own markdown — the same path
 * every non-inheriting vault already takes — while the ambiguous history stays
 * on disk instead of being deleted. Returns false when the pass did not
 * complete, so the caller can leave it pending and retry on the next launch.
 *
 * The store is opened through `openCrdtPersistence`, not `new
 * LeveldbPersistence`, because that is where the preflight lives: a native
 * binding that hard-aborts takes the process down with no catchable error, and
 * main must never be the first thing to touch the store directory. The cost is
 * one extra preflight child on the single launch that migrates, which is also
 * why this runs from the pending flag rather than on every open.
 */
export async function setAsideAmbiguousLegacyDocs(storagePath: string): Promise<boolean> {
  const persistence = (await openCrdtPersistence(storagePath)) as EnumerableCrdtPersistence | null
  if (!persistence) {
    // Preflight refused the store, or the binding is unusable. The provider is
    // about to reach the same verdict and run in-memory, where the ambiguous
    // documents cannot be loaded either — so nothing is at risk while this
    // stays pending.
    log.warn('Could not open the inherited CRDT store to partition it; will retry', { storagePath })
    return false
  }

  try {
    if (typeof persistence.getAllDocNames !== 'function') {
      log.warn('Inherited CRDT store cannot be enumerated; leaving it whole', { storagePath })
      return false
    }

    const ambiguous = (await persistence.getAllDocNames()).filter(isCrossVaultAmbiguousDocId)
    for (const docName of ambiguous) {
      const doc = await persistence.getYDoc(docName)
      try {
        // Re-running this replays the identical update into the same document,
        // which Yjs applies as a no-op — so an interrupted pass is safe to
        // repeat, and so is clearing a document that is already cleared.
        await persistence.storeUpdate(
          `${UNATTRIBUTABLE_DOC_PREFIX}${docName}`,
          Y.encodeStateAsUpdate(doc)
        )
      } finally {
        doc.destroy()
      }
      await persistence.clearDocument(docName)
    }

    if (ambiguous.length > 0) {
      log.info('Set aside legacy CRDT documents that more than one vault could have written', {
        storagePath,
        count: ambiguous.length
      })
    }
    return true
  } catch (err) {
    log.warn('Could not partition the inherited CRDT store; will retry', {
      storagePath,
      error: err
    })
    return false
  } finally {
    // Release the LevelDB lock before the provider opens the same directory.
    await persistence.destroy()
  }
}
