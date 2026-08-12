import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { existsSync, rmSync } from 'fs'
import { createLogger } from '../lib/logger'
import { runCrdtPreflight } from './crdt-preflight'
import { moveStoreDir } from './crdt-store-move'

// Same scope as crdt-provider on purpose: every line below was emitted under
// 'CrdtProvider' before this module was split out of it, and production log
// triage greps for that scope.
const log = createLogger('CrdtProvider')

const PERSISTENCE_PROBE_KEY = '__memry_crdt_probe__'
const PERSISTENCE_PROBE_TIMEOUT_MS = 15_000

export interface CrdtPersistence {
  getYDoc(noteId: string): Promise<Y.Doc>
  clearDocument(noteId: string): Promise<void>
  destroy(): Promise<void> | void
  storeUpdate(noteId: string, update: Uint8Array): Promise<void>
  flushDocument(noteId: string): Promise<void>
}

/**
 * Open the on-disk CRDT store, or return null when it cannot be trusted.
 *
 * Null is not a failure the caller has to handle specially: the provider
 * degrades to in-memory mode, where notes still load from vault markdown and
 * write back to disk and only CRDT history persistence is lost.
 */
export async function openCrdtPersistence(storagePath: string): Promise<CrdtPersistence | null> {
  try {
    // A binding that hard-aborts (unsupported CPU instructions, AV kills)
    // takes the whole process down with no catchable error — observed on
    // 2026.709.x: main died silently before the window painted. Exercise
    // the binding in a disposable child first — against the real store, so
    // corrupt on-disk state aborts the child too. Only load it here if the
    // child survives.
    let preflight = await runCrdtPreflight(storagePath)
    // Only a child that actually opened the store can implicate it. A child
    // that never started (Windows: utility process dies in Chromium/crashpad
    // init) or that died loading the binding never touched the data, and
    // quarantining on that verdict only churned the store dir every launch —
    // with the restore then failing EPERM under AV. See crdt-preflight.ts.
    if (!preflight.ok && preflight.stage === 'store' && existsSync(storagePath)) {
      // The abort may be the store's data (torn LDB/MANIFEST from a past
      // crash or full disk), not the binding. Quarantine the store and give
      // the binding one clean shot at a fresh directory: pass → the data was
      // the problem, keep the quarantine and start fresh (vault markdown is
      // the source of truth; only CRDT history moves aside). Fail → the
      // binding is the problem, so restore the store for a future launch
      // with a working binding and fall through to in-memory mode.
      const quarantinePath = `${storagePath}.broken-${Date.now()}`
      const quarantined = await moveStoreDir(storagePath, quarantinePath)
      if (!quarantined) {
        log.warn('Could not quarantine the CRDT store — leaving it in place', { storagePath })
      } else {
        preflight = await runCrdtPreflight(storagePath)
        if (preflight.ok) {
          log.warn(
            'CRDT store quarantined after failed preflight — continuing with a fresh store',
            {
              storagePath,
              quarantinePath
            }
          )
        } else {
          // The failed re-probe can leave a partial fresh store behind, and
          // on Windows renaming onto an existing directory fails EPERM —
          // exactly what production logs show. That directory holds nothing
          // (the probe never completed), so clear it before restoring.
          try {
            rmSync(storagePath, { recursive: true, force: true })
          } catch (err) {
            log.warn('Could not clear the fresh CRDT store before restoring', {
              storagePath,
              error: err
            })
          }
          if (!(await moveStoreDir(quarantinePath, storagePath))) {
            log.warn('Failed to restore quarantined CRDT store', { quarantinePath, storagePath })
          }
        }
      }
    }
    if (!preflight.ok) {
      throw new Error(`CRDT store preflight failed: ${preflight.reason ?? 'unknown'}`)
    }
    const persistence = new LeveldbPersistence(storagePath) as CrdtPersistence
    await probePersistence(persistence)
    log.debug('CrdtProvider persistence initialized', { storagePath })
    return persistence
  } catch (err) {
    // A broken classic-level native binding (e.g. napi_create_reference
    // failures on ABI mismatch, as shipped in 2026.705.1 on Windows) throws
    // out-of-band or hangs instead of rejecting. Degrade to in-memory:
    // notes still load from vault markdown and write back to disk; only
    // CRDT history persistence is lost.
    log.error(
      'CRDT persistence unavailable — continuing in-memory (notes still load from vault files)',
      { storagePath, error: err }
    )
    return null
  }
}

/**
 * Verify the CRDT store's native binding actually works before trusting it.
 * A broken classic-level binding (ABI mismatch) doesn't reject cleanly — it
 * throws out-of-band from an fs callback (surfacing as uncaughtException) or
 * never invokes its callback at all (hanging the promise). Capture both so a
 * bad binary degrades to in-memory mode instead of crashing note editing.
 */
async function probePersistence(persistence: CrdtPersistence): Promise<void> {
  const probeDoc = new Y.Doc()
  probeDoc.getMap('probe').set('ok', true)
  const update = Y.encodeStateAsUpdate(probeDoc)
  probeDoc.destroy()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('uncaughtException', onUncaught)
      fn()
    }
    const onUncaught = (err: Error): void => settle(() => reject(err))
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(`CRDT persistence probe timed out after ${PERSISTENCE_PROBE_TIMEOUT_MS}ms`)
          )
        ),
      PERSISTENCE_PROBE_TIMEOUT_MS
    )
    process.prependListener('uncaughtException', onUncaught)

    Promise.resolve()
      .then(async () => {
        await persistence.storeUpdate(PERSISTENCE_PROBE_KEY, update)
        const loaded = await persistence.getYDoc(PERSISTENCE_PROBE_KEY)
        loaded.destroy()
        await persistence.clearDocument(PERSISTENCE_PROBE_KEY)
      })
      .then(
        () => settle(resolve),
        (err) => settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      )
  })
}
