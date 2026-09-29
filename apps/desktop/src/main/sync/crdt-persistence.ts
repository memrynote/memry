import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { createLogger } from '../lib/logger'
import {
  getCrdtPersistenceGuard,
  recordCrdtPreflightFailure,
  type CrdtPersistenceGuard
} from '../store'
import {
  preflightMachineFields,
  runCrdtPreflight,
  stripAbsolutePaths,
  type CrdtPreflightResult
} from './crdt-preflight'
import { moveStoreDir } from './crdt-store-move'
import { trackMainEvent } from '../telemetry/track'
import { getMainRedactOptions } from '../telemetry/redact-options'
import { redactText } from '@memry/contracts/redact'

// Same scope as crdt-provider on purpose: every line below was emitted under
// 'CrdtProvider' before this module was split out of it, and production log
// triage greps for that scope.
const log = createLogger('CrdtProvider')

const PERSISTENCE_PROBE_KEY = '__memry_crdt_probe__'
const PERSISTENCE_PROBE_TIMEOUT_MS = 15_000

/**
 * classic-level memory knobs, passed through y-leveldb's `levelOptions`.
 *
 * The defaults (8 MiB block cache, 4 MiB write buffer, up to two buffers live)
 * are sized for a server. Here every read is one note's update log, loaded once
 * into a Y.Doc that then stays in memory, so the block cache barely hits, and
 * writes are small per-keystroke updates. Both are runtime-only settings: the
 * on-disk format is unchanged, and a store written with either size opens with
 * the other.
 */
export const CRDT_LEVEL_OPTIONS = {
  cacheSize: 2 * 1024 * 1024,
  writeBufferSize: 1024 * 1024
} as const

/**
 * Consecutive in-memory launches after which this build stops running the
 * preflight at all.
 *
 * Three, the same count the user-facing notice waits for: below it a degraded
 * launch is usually a store that quarantined itself and recovers on its own, so
 * giving up early would strand an install that was about to be fine.
 */
const PREFLIGHT_GIVE_UP_AFTER_SESSIONS = 3

/**
 * How long a given-up build waits before running the preflight again.
 *
 * Without it the only retry was a new build, and some Windows installs ran a
 * whole release in memory (90+ launches on 2026.928.1, issue #2519). A day
 * keeps the cost at one failed probe — at most four crashed children, none of
 * which can touch the store — per day, against the 83 crashes in three days
 * that the give-up was built to stop (#2217).
 */
export const PREFLIGHT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The most control-directory entries worth naming in a telemetry message. */
const MAX_CONTROL_DIR_FILES = 12
/** How much of LevelDB's own LOG tail rides in the local log line. */
const CONTROL_LOG_TAIL_CHARS = 1024

export interface CrdtPersistence {
  getYDoc(noteId: string): Promise<Y.Doc>
  clearDocument(noteId: string): Promise<void>
  destroy(): Promise<void> | void
  storeUpdate(noteId: string, update: Uint8Array): Promise<void>
  flushDocument(noteId: string): Promise<void>
  /**
   * y-leveldb's per-document metadata, keyed under `['v1', noteId, 'meta', …]`
   * — inside the range `clearDocument` wipes, so anything stored here is
   * dropped with the document rather than surviving it. That is what makes it
   * the only correct home for the snapshot watermark; see
   * `crdt-snapshot-watermark.ts`.
   */
  getMeta(noteId: string, metaKey: string): Promise<unknown>
  setMeta(noteId: string, metaKey: string, value: unknown): Promise<void>
}

/**
 * Where the store gave up, as a bounded token safe to ship as telemetry.
 * `probe` is this module's own post-preflight check — the preflight stages
 * come from the child and stop at 'store'.
 */
type FailurePoint = CrdtPreflightResult['stage'] | 'probe' | 'guard'

/**
 * Has this machine already proved, under this exact build, that the preflight
 * only ever ends in a native abort?
 *
 * The preflight exists to contain a binding that takes the process down with no
 * catchable error, and containing it costs a crashed child. On the Windows
 * installs in issue #2217 that child access-violates every single launch
 * (`Utility:crashed:CrdtPreflight`, exit 0xC0000005), twice — once against the
 * store and once against the empty control directory — and the verdict is
 * identical every time. Nothing was remembered between launches, so the crash
 * loop had no end: 83 crashes over three days for one user, all re-deriving a
 * conclusion the previous launch had already reached.
 *
 * A streak under the threshold is NOT a verdict: a store that quarantined
 * itself is degraded for exactly one launch and healthy on the next, and giving
 * up on it would turn a self-healing case into a permanent one.
 *
 * The version is what keeps this from being permanent. A streak is only
 * honoured for the build that recorded it, so shipping a new binary re-arms the
 * preflight automatically — the auto-update is the retry. An install whose
 * streak predates this field has no owning build and is re-armed once, which is
 * also what makes the new field safe to add to configs that never had it.
 *
 * Time bounds it too (#2519): a build waits `PREFLIGHT_RETRY_INTERVAL_MS`
 * after its last failed run and then probes again, so an install is never in
 * memory for longer than a day on account of the gate alone. A missing stamp
 * (a give-up recorded before the stamp existed) or one from the future (a clock
 * that moved backwards) is no evidence, and runs the preflight.
 */
export function shouldSkipCrdtPreflight(
  guard: CrdtPersistenceGuard,
  currentVersion: string,
  now: number
): boolean {
  if (guard.sessions < PREFLIGHT_GIVE_UP_AFTER_SESSIONS) return false
  if (guard.appVersion !== currentVersion) return false
  const failedAt = guard.preflightFailedAt
  if (failedAt === undefined || failedAt > now) return false
  return now - failedAt < PREFLIGHT_RETRY_INTERVAL_MS
}

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
 * The stage and transport ride as bounded tokens. The reason string ships too,
 * but only through `redactText` with the main-process vault root and salted
 * hasher — the same path every other error message takes. It stays out of
 * `dimensions`, where `SafeDimensionValueSchema` is a blocklist rather than a
 * guarantee; the redacted `error.message` field is the one built for free text.
 * Without it this event's Error Tracking issue was titled after its own error
 * code and carried nothing else at all (#1989).
 */
function reportPersistenceUnavailable(
  preflight: CrdtPreflightResult | null,
  storagePath: string,
  failedAt?: FailurePoint
): void {
  const at: FailurePoint =
    failedAt ?? (preflight && !preflight.ok ? (preflight.stage ?? 'bootstrap') : 'probe')
  // Every token before `reason` is bounded and path-free, and together they
  // stay well under the 512-char cap, so the cap only ever trims the reason.
  const machine = preflightMachineFields()
  const binding = preflight?.binding
  const message = [
    `CRDT persistence unavailable at ${at}`,
    `transport=${preflight?.transport ?? 'none'}`,
    ...(preflight?.storeOp ? [`op=${preflight.storeOp}`] : []),
    `os=${os.platform()} ${os.release()}`,
    `arch=${machine.arch}`,
    `cpu=${machine.cpuVendor}`,
    `electron=${machine.electron}`,
    `abi=${machine.abi}`,
    ...(binding ? [`classicLevel=${binding.classicLevel}`, `binary=${binding.binary}`] : []),
    `asciiPath=${isAscii(storagePath)}`,
    ...(preflight?.controlDirFiles
      ? [`controlFiles=${preflight.controlDirFiles.join(',') || 'none'}`]
      : []),
    `reason=${preflight?.reason ?? 'unknown'}`
  ].join(' ')
  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: 'init',
    objectType: 'exception',
    source: 'crdt',
    result: 'failed',
    // Same `CODE:detail` shape as the other main-process error codes, so the
    // stage is groupable in error tracking without spending the one dimension.
    errorCode: `CRDT_PERSISTENCE_UNAVAILABLE:${at}`,
    error: { message: redactText(message, getMainRedactOptions()).slice(0, 512) },
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
  const skipped = skipPreflightVerdict()
  if (skipped) {
    // Reported like any other unavailable store, so the fleet count of installs
    // running in memory does not silently drop to zero for exactly the
    // population it was built to measure.
    log.warn('Skipping the CRDT preflight — this build has already failed it repeatedly', {
      storagePath,
      reason: skipped
    })
    reportPersistenceUnavailable({ ok: false, reason: skipped }, storagePath, 'guard')
    return null
  }
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
      preflight = await settleStoreStageFailure(storagePath, preflight)
      lastPreflight = preflight
    }
    if (!preflight.ok) {
      throw new Error(`CRDT store preflight failed: ${preflight.reason ?? 'unknown'}`)
    }
    const persistence = new LeveldbPersistence(storagePath, {
      levelOptions: CRDT_LEVEL_OPTIONS
    }) as CrdtPersistence
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
    reportPersistenceUnavailable(lastPreflight, storagePath)
    // Only a launch that actually ran the preflight starts the retry clock.
    if (lastPreflight) stampPreflightFailure()
    return null
  }
}

function stampPreflightFailure(): void {
  try {
    recordCrdtPreflightFailure(Date.now())
  } catch (err) {
    // Bookkeeping for the gate must never be what stops in-memory mode.
    log.warn('Could not record the CRDT preflight failure time', { error: err })
  }
}

/**
 * Whether a path is plain ASCII. LevelDB's Windows port opens its LOG with a
 * narrow `fopen`, so a non-ASCII profile path is the one path property worth
 * shipping — as a boolean, never the path.
 */
function isAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value)
}

/**
 * Why this launch is skipping the preflight, or null to run it.
 *
 * Reading the guard must never be what stops the store from opening, so a store
 * that cannot be read is treated as no evidence and the preflight runs.
 */
function skipPreflightVerdict(): string | null {
  try {
    const guard = getCrdtPersistenceGuard()
    const version = app.getVersion()
    const now = Date.now()
    if (!shouldSkipCrdtPreflight(guard, version, now)) return null
    const hoursSinceRun = Math.floor((now - (guard.preflightFailedAt ?? now)) / 3_600_000)
    return `preflight skipped after ${guard.sessions} in-memory launches on ${version}, last failed run ${hoursSinceRun}h ago`
  } catch (err) {
    log.warn('Could not read the CRDT persistence guard — running the preflight', { error: err })
    return null
  }
}

/**
 * Decide what a `store`-stage preflight failure actually means, and act on it.
 *
 * The child died using the store, which has exactly two causes: the store's own
 * data (torn LDB/MANIFEST from a past crash, a full disk) or the binding. They
 * are told apart by a control: probe a directory that is guaranteed EMPTY and
 * therefore cannot be at fault.
 *
 * - control passes → the data is the cause. Quarantine the store; LevelDB
 *   recreates the directory, vault markdown reseeds the notes, and only CRDT
 *   history moves aside. This is the darwin/linux case, and it self-heals.
 * - control fails → the binding is the cause and the data is innocent. Restage
 *   as `binding-in-use` and leave the store completely alone.
 *
 * The control runs BEFORE anything is moved, which is the whole point. The
 * previous order quarantined first and re-probed the (now empty) real path, so
 * every Windows install in issue #1583 paid a rename → failed re-probe →
 * `rmSync` → rename-back cycle on its CRDT store on EVERY launch, forever, and
 * not one of them ever came out of it with a working store: zero win32 rows for
 * "quarantined ... continuing with a fresh store" across the whole window.
 */
async function settleStoreStageFailure(
  storagePath: string,
  preflight: CrdtPreflightResult
): Promise<CrdtPreflightResult> {
  // A fixed name, not a timestamped one: on the machines this runs for, every
  // launch would otherwise strand another directory next to the store. One
  // directory, cleared before use and after.
  const controlPath = `${storagePath}.probe`
  if (!clearPath(controlPath, 'CRDT preflight control directory')) {
    // Inconclusive: no clean control means no evidence, and evidence is the
    // only thing that may move a user's store.
    log.warn('Could not clear the CRDT preflight control directory — leaving the store alone', {
      controlPath
    })
    return preflight
  }

  const control = await runCrdtPreflight(controlPath)
  // Read before the clear: what LevelDB managed to write into an empty
  // directory is how far its open got before the child died.
  const controlDir = control.ok ? null : describeControlDir(controlPath)
  clearPath(controlPath, 'CRDT preflight control directory')

  if (!control.ok) {
    log.warn('CRDT preflight fails on an empty directory too — the store data is not at fault', {
      storagePath,
      reason: control.reason,
      stage: control.stage,
      storeOp: control.storeOp,
      transport: control.transport,
      binding: control.binding,
      controlDirFiles: controlDir?.files,
      controlDirLogTail: controlDir?.logTail,
      ...preflightMachineFields()
    })
    // Restage so telemetry stops reporting a data problem that does not exist.
    // Never derived from stderr — only a second child's verdict can say this.
    return {
      ...control,
      stage: 'binding-in-use',
      ...(controlDir ? { controlDirFiles: controlDir.files } : {})
    }
  }

  const quarantinePath = `${storagePath}.broken-${Date.now()}`
  if (!(await moveStoreDir(storagePath, quarantinePath))) {
    log.warn('Could not quarantine the CRDT store — leaving it in place', { storagePath })
    return preflight
  }
  log.warn('CRDT store quarantined after failed preflight — continuing with a fresh store', {
    storagePath,
    quarantinePath
  })
  return control
}

/**
 * The file names LevelDB left in the control directory, and the tail of its own
 * LOG (flushed per line, so it survives the crash). Only the probe ever wrote
 * there, so nothing in it is user data; absolute paths are stripped anyway.
 * Null when the directory cannot be read — a diagnostic never fails the verdict.
 */
function describeControlDir(controlPath: string): { files: string[]; logTail?: string } | null {
  try {
    const files = readdirSync(controlPath).sort().slice(0, MAX_CONTROL_DIR_FILES)
    let logTail: string | undefined
    if (files.includes('LOG')) {
      const levelDbLog = readFileSync(path.join(controlPath, 'LOG'), 'utf8')
      logTail = stripAbsolutePaths(levelDbLog.slice(-CONTROL_LOG_TAIL_CHARS))
    }
    return { files, logTail }
  } catch {
    return null
  }
}

/** Remove a path if it exists. False means it is still there. */
function clearPath(target: string, label: string): boolean {
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch (err) {
    log.warn(`Could not remove ${label}`, { target, error: err })
    return !existsSync(target)
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
