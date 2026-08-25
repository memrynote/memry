// Fresh-device bootstrap telemetry (#1835, phase 0 of #1828).
//
// Every later bootstrap-sync phase claims a speed win; this module is how those
// claims get verified on real user data. It measures exactly three things:
//
//   - time to interactive: vault download requested -> vault open resolved
//   - time to full text:   bootstrap start -> CRDT sweep drained (all bodies)
//   - throughput:          bytes moved during the window, split by channel
//     (records / crdt / attachments)
//
// The sync engine calls in through one-line hooks (`beginBootstrap`,
// `recordBootstrapBytes`, `markBootstrapInteractive`, `markBootstrapFullText`)
// so later phases (#1830/#1831/#1836/#1840) can keep the same call points while
// they rearrange what happens between them.
//
// Discipline, in the same spirit as the per-minute IPC error throttle:
//   - Events fire once per bootstrap (guard flags), never per transfer chunk —
//     bytes aggregate in memory and leave in a single summary at the end.
//   - `shouldEmitThrottled` backs the guards with a per-minute floor, so even a
//     begin/complete loop cannot spam.
//   - Emission only happens for a genuine fresh-device bootstrap: the callers
//     gate on "no prior sync cursor" / "vault downloaded from the account",
//     and everything here no-ops while no bootstrap is active.
//   - Consent lives where it always has: `trackMainEvent` -> telemetry client,
//     which drops every event while telemetry is disabled.
//   - Nothing here may break sync: every public entry point catches its own
//     errors, and no note content, title, path or id is ever attached — counts
//     ship only as coarse buckets.
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createLogger } from '../lib/logger'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { trackMainEvent } from '../telemetry/track'

const logger = createLogger('BootstrapMetrics')

export type BootstrapByteChannel = 'records' | 'crdt' | 'attachments'

/**
 * What armed the bootstrap window. `vault_download` is the canonical fresh
 * device (Download vault from the account picker) and is the only source that
 * gets a `time_to_interactive` mark; `first_full_sync` covers a vault whose
 * engine finds no sync cursor at all — the vault was already open, so only
 * full-text and throughput are meaningful there.
 */
export type BootstrapSource = 'vault_download' | 'first_full_sync'

export interface BootstrapVaultStats {
  noteCount: number | null
  vaultSizeBytes: number | null
}

interface BootstrapState {
  source: BootstrapSource
  startedAt: number
  bytes: Record<BootstrapByteChannel, number>
  interactiveEmitted: boolean
}

const BYTE_CHANNELS: readonly BootstrapByteChannel[] = ['records', 'crdt', 'attachments']

// One event name, distinguished by action — the same shape sync_run_completed
// uses for push_completed/pull_completed.
const EVENT_NAME = 'sync_bootstrap' as const

// Belt-and-suspenders behind the per-bootstrap once-flags: even if bootstraps
// were armed back-to-back (two vault downloads in one session), each action
// still leaves at most once per minute.
const EMIT_WINDOW_MS = 60 * 1000

// Coarse buckets only — never raw counts — so an event can never say how big a
// specific user's vault is beyond an order of magnitude.
export const noteCountBucket = (noteCount: number): string => {
  if (!Number.isFinite(noteCount) || noteCount < 0) return 'unknown'
  if (noteCount < 100) return '0-100'
  if (noteCount < 1000) return '100-1k'
  if (noteCount < 10_000) return '1k-10k'
  return '10k+'
}

export const vaultSizeBucket = (sizeBytes: number): string => {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'unknown'
  if (sizeBytes < 100 * 1024 * 1024) return 'lt100mb'
  if (sizeBytes < 1024 * 1024 * 1024) return '100mb-1gb'
  if (sizeBytes < 10 * 1024 * 1024 * 1024) return '1gb-10gb'
  return '10gb+'
}

// Walking a vault is one-shot per bootstrap, but a pathological tree must not
// pin the main process — past this many files the running total is returned
// as-is (the bucket is already in the right order of magnitude by then).
const MAX_SIZE_WALK_ENTRIES = 100_000

const directorySizeBytes = async (rootPath: string): Promise<number> => {
  let total = 0
  let seen = 0
  const entries = await fs.readdir(rootPath, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (++seen > MAX_SIZE_WALK_ENTRIES) break
    try {
      const stat = await fs.stat(path.join(entry.parentPath, entry.name))
      total += stat.size
    } catch {
      // A file deleted mid-walk costs its own bytes, nothing else.
    }
  }
  return total
}

/**
 * Resolves the vault facts the bucket dimensions are built from. Injectable so
 * tests never touch a database or the filesystem; the default reads the index
 * DB's note count and walks the current vault directory, and answers `null`
 * for whatever it cannot resolve (each null becomes the 'unknown' bucket).
 */
const defaultStatsProvider = async (): Promise<BootstrapVaultStats> => {
  let noteCount: number | null = null
  try {
    const { isIndexDatabaseInitialized, getIndexDatabase } = await import('../database/client')
    if (isIndexDatabaseInitialized()) {
      const { countNotes } = await import('../database/queries/notes')
      noteCount = countNotes(getIndexDatabase())
    }
  } catch (error) {
    logger.debug('Bootstrap note count unavailable', { error })
  }

  let vaultSizeBytes: number | null = null
  try {
    const { getCurrentVaultPath } = await import('../store')
    const vaultPath = getCurrentVaultPath()
    if (vaultPath) vaultSizeBytes = await directorySizeBytes(vaultPath)
  } catch (error) {
    logger.debug('Bootstrap vault size unavailable', { error })
  }

  return { noteCount, vaultSizeBytes }
}

let statsProvider: () => Promise<BootstrapVaultStats> = defaultStatsProvider
let state: BootstrapState | null = null

/**
 * Arm the bootstrap window. Callers gate this on genuine fresh-device signals
 * — the vault-download flow, or a first fullSync that found no sync cursor —
 * and it no-ops while a bootstrap is already running, so the download seam
 * (which fires first) keeps the earlier, truer start time.
 */
export const beginBootstrap = (source: BootstrapSource): void => {
  try {
    if (state) return
    state = {
      source,
      startedAt: Date.now(),
      bytes: { records: 0, crdt: 0, attachments: 0 },
      interactiveEmitted: false
    }
    logger.info('Bootstrap window opened', { source })
  } catch (error) {
    logger.warn('beginBootstrap failed', { error })
  }
}

export const isBootstrapActive = (): boolean => state !== null

/**
 * Aggregate transfer bytes into the active bootstrap window. Steady-state
 * syncs call this too — it no-ops unless a bootstrap is running, so the hooks
 * in the pull/CRDT/attachment paths never need their own gating.
 */
export const recordBootstrapBytes = (channel: BootstrapByteChannel, byteCount: number): void => {
  try {
    if (!state) return
    if (!Number.isFinite(byteCount) || byteCount <= 0) return
    state.bytes[channel] += byteCount
  } catch (error) {
    logger.warn('recordBootstrapBytes failed', { error })
  }
}

/**
 * The vault open resolved — the user can interact with the app. Emits the
 * `time_to_interactive` milestone once per bootstrap; safe to call again and
 * safe to call with no bootstrap active (both no-op).
 */
export const markBootstrapInteractive = (): void => {
  try {
    if (!state || state.interactiveEmitted) return
    // Flag before the throttle check: a suppressed emission still consumes
    // this bootstrap's one interactive mark, so state never wedges on it.
    state.interactiveEmitted = true
    if (!shouldEmitThrottled(`${EVENT_NAME}:interactive`, EMIT_WINDOW_MS)) return
    trackMainEvent(EVENT_NAME, {
      surface: 'sync',
      action: 'interactive',
      source: state.source,
      result: 'success',
      metrics: { durationMs: Date.now() - state.startedAt }
    })
  } catch (error) {
    logger.warn('markBootstrapInteractive failed', { error })
  }
}

/**
 * The CRDT sweep drained — every note body the server holds is now current on
 * this device. Emits the `time_to_full_text` milestone plus one throughput
 * summary per byte channel, then closes the bootstrap window. One-shot: the
 * window is consumed synchronously, so concurrent or repeated calls no-op.
 */
export const markBootstrapFullText = (): void => {
  try {
    if (!state) return
    // Consume the window before anything async runs and BEFORE the throttle
    // check: byte counters stop here, a second call can never race the stats
    // fetch into a double emit, and a throttled completion must still close
    // the window rather than leave it open counting steady-state bytes.
    const finished = state
    state = null
    if (!shouldEmitThrottled(`${EVENT_NAME}:full_text`, EMIT_WINDOW_MS)) return
    const durationMs = Date.now() - finished.startedAt

    void statsProvider()
      .catch((error): BootstrapVaultStats => {
        logger.debug('Bootstrap stats provider failed', { error })
        return { noteCount: null, vaultSizeBytes: null }
      })
      .then((stats) => {
        emitCompletion(finished, durationMs, stats)
      })
      .catch((error) => {
        logger.warn('Bootstrap completion emit failed', { error })
      })
  } catch (error) {
    logger.warn('markBootstrapFullText failed', { error })
  }
}

const emitCompletion = (
  finished: BootstrapState,
  durationMs: number,
  stats: BootstrapVaultStats
): void => {
  trackMainEvent(EVENT_NAME, {
    surface: 'sync',
    action: 'full_text',
    source: finished.source,
    result: 'success',
    metrics: { durationMs },
    dimensions: { note_bucket: noteCountBucket(stats.noteCount ?? Number.NaN) }
  })

  // Throughput is one summary event per channel — never a per-chunk stream.
  // The channel rides in `source` (the split), the vault size bucket in the
  // single dimension slot, and bytes/duration/rate in the metric fields.
  const elapsedSeconds = Math.max(durationMs, 1) / 1000
  const sizeBucket = vaultSizeBucket(stats.vaultSizeBytes ?? Number.NaN)
  for (const channel of BYTE_CHANNELS) {
    const byteCount = finished.bytes[channel]
    trackMainEvent(EVENT_NAME, {
      surface: 'sync',
      action: 'throughput',
      source: channel,
      result: 'success',
      metrics: {
        durationMs,
        byteCount,
        value: Math.round(byteCount / elapsedSeconds)
      },
      dimensions: { size_bucket: sizeBucket }
    })
  }
  logger.info('Bootstrap window closed', {
    source: finished.source,
    durationMs,
    bytes: finished.bytes
  })
}

/**
 * Drop an in-flight bootstrap without emitting anything — for callers that
 * know the window no longer describes one vault's bootstrap (e.g. session
 * teardown mid-download). Currently exercised by tests and kept deliberately
 * cheap for future wiring.
 */
export const abandonBootstrap = (): void => {
  if (!state) return
  logger.info('Bootstrap window abandoned', { source: state.source })
  state = null
}

/** Test seam: swap the vault stats source. Returns the previous provider. */
export const setBootstrapStatsProvider = (
  provider: () => Promise<BootstrapVaultStats>
): (() => Promise<BootstrapVaultStats>) => {
  const previous = statsProvider
  statsProvider = provider
  return previous
}

/** Test seam: clear all bootstrap state (the throttle has its own reset). */
export const resetBootstrapMetrics = (): void => {
  state = null
  statsProvider = defaultStatsProvider
}
