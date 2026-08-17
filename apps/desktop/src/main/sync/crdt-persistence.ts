import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { existsSync, rmSync } from 'fs'
import { createLogger } from '../lib/logger'
import { runCrdtPreflight, type CrdtPreflightResult } from './crdt-preflight'
import { moveStoreDir } from './crdt-store-move'
import { trackMainEvent } from '../telemetry/track'

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
 * Where the store gave up, as a bounded token safe to ship as telemetry.
 * `probe` is this module's own post-preflight check — the preflight stages
 * come from the child and stop at 'store'.
 */
type FailurePoint = CrdtPreflightResult['stage'] | 'probe'

/**
 * Report that this install has no CRDT persistence.
 *
 * Until this existed the outcome was a log line and nothing else, so the only
 * Windows signal was `Utility:crashed:CrdtPreflight` from `child-process-gone`
 * — which also fires in the case we RECOVER from (the utility process fails to
 * boot and the Chromium-free fallback then passes). Crash count and breakage
 * were therefore indistinguishable, and "how many users are running in-memory"
 * had no answer. This event is the answer; the preflight crash is not.
 *
 * Everything shipped is a bounded token: the stage and transport enums and the
 * event name. The reason string is deliberately NOT sent — it can carry a
 * store path, and `SafeDimensionValueSchema` is a blocklist, not a guarantee.
 */
function reportPersistenceUnavailable(preflight: CrdtPreflightResult | null): void {
  const at: FailurePoint = preflight && !preflight.ok ? (preflight.stage ?? 'bootstrap') : 'probe'
  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: 'init',
    objectType: 'exception',
    source: 'crdt',
    result: 'failed',
    // Same `CODE:detail` shape as the other main-process error codes, so the
    // stage is groupable in error tracking without spending the one dimension.
    errorCode: `CRDT_PERSISTENCE_UNAVAILABLE:${at}`,
    // At most one dimension is allowed to leave the device, and this is the
    // one worth having: a 'node' verdict means the Chromium-free fallback
    // failed too, i.e. the binding is broken on this machine rather than the
    // utility process being unable to start.
    ...(preflight?.transport ? { dimensions: { transport: preflight.transport } } : {})
  })
}

/**
 * Open the on-disk CRDT store, or return null when it cannot be trusted.
 *
 * Null is not a failure the caller has to handle specially: the provider
 * degrades to in-memory mode, where notes still load from vault markdown and
 * write back to disk and only CRDT history persistence is lost.
 */
export async function openCrdtPersistence(storagePath: string): Promise<CrdtPersistence | null> {
  // Held outside the try so the catch can attribute the failure. The throw
  // below is this function's own, but the catch also covers the binding
  // aborting out-of-band from probePersistence, where there is no verdict.
  let lastPreflight: CrdtPreflightResult | null = null
  try {
    // A binding that hard-aborts (unsupported CPU instructions, AV kills)
    // takes the whole process down with no catchable error — observed on
    // 2026.709.x: main died silently before the window painted. Exercise
    // the binding in a disposable child first — against the real store, so
    // corrupt on-disk state aborts the child too. Only load it here if the
    // child survives.
    let preflight = await runCrdtPreflight(storagePath)
    lastPreflight = preflight
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
        lastPreflight = preflight
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
    reportPersistenceUnavailable(lastPreflight)
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
