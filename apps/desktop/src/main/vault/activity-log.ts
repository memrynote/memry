/**
 * Vault Activity Log
 *
 * A device-local, append-only record of what happened to files that entered or
 * left the vault from outside the app: files the watcher or the open-time scan
 * picked up, removed or renamed, files skipped as unsupported, importer runs,
 * and per-file failures (read, copy, sync upload/download).
 *
 * Before this, those outcomes surfaced as a toast at best, and an unsupported
 * file dropped into the vault folder produced nothing at all (#2359). The log
 * is what lets the user answer "did Memry pick up what I put in the folder?"
 * after the toast is gone.
 *
 * Storage: `<vault>/.memry/activity.jsonl`, one JSON entry per line. `.memry`
 * is ignored by the watcher and the indexer, so the log never becomes a note
 * and never syncs. Retention (days) lives next to it in
 * `activity-settings.json`, device-local like the log itself.
 *
 * Recording never throws and never blocks the caller: entries are buffered in
 * memory and appended on a short timer.
 *
 * @module vault/activity-log
 */

import { randomBytes } from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import {
  VAULT_ACTIVITY_DEFAULT_RETENTION_DAYS,
  VAULT_ACTIVITY_MAX_ITEMS,
  VAULT_ACTIVITY_RETENTION_DAYS,
  VaultActivityChannels,
  VaultActivityEntrySchema,
  type VaultActivityEntry,
  type VaultActivityFilter,
  type VaultActivityRetentionDays
} from '@memry/contracts/vault-activity-api'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { generateId } from '../lib/id'
import { normalizeRelativePath } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { CANVAS_FILE_EXT } from '../canvas/scene-file'

const logger = createLogger('VaultActivity')

const MEMRY_DIR = '.memry'
const LOG_FILE = 'activity.jsonl'
const SETTINGS_FILE = 'activity-settings.json'

/** Entries kept in memory and on disk, whatever the retention window says. */
export const MAX_ACTIVITY_ENTRIES = 5000
/** Growth allowed past the cap before the file is compacted. */
const COMPACT_SLACK = 500
const WRITE_DELAY_MS = 250
const CHANGED_THROTTLE_MS = 500
const MAX_MESSAGE_LENGTH = 500
const DAY_MS = 86_400_000

export type VaultActivityInput = Omit<VaultActivityEntry, 'v' | 'id' | 'at'> & {
  /** A repeat with the same key inside `dedupeWindowMs` is dropped. */
  dedupeKey?: string
  dedupeWindowMs?: number
}

interface ActivityState {
  vaultPath: string
  logPath: string
  settingsPath: string
  /** Oldest first. */
  entries: VaultActivityEntry[]
  retentionDays: VaultActivityRetentionDays
  /** Serialized lines not yet on disk. */
  pending: string[]
  /** The on-disk file no longer matches `entries` minus `pending`; rewrite it whole. */
  needsRewrite: boolean
  writeTimer: NodeJS.Timeout | null
  writeChain: Promise<void>
  /** Paths already reported as unsupported, so a file is reported once per retention window. */
  reportedSkips: Set<string>
  recentKeys: Map<string, number>
}

let state: ActivityState | null = null
let changedTimer: NodeJS.Timeout | null = null

function isRetentionDays(value: unknown): value is VaultActivityRetentionDays {
  return (VAULT_ACTIVITY_RETENTION_DAYS as readonly unknown[]).includes(value)
}

function readRetentionDays(settingsPath: string): VaultActivityRetentionDays {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { retentionDays?: unknown }
    if (isRetentionDays(parsed.retentionDays)) return parsed.retentionDays
  } catch {
    // Missing or unreadable: the default applies.
  }
  return VAULT_ACTIVITY_DEFAULT_RETENTION_DAYS
}

/** Parse the log, dropping lines this build cannot read instead of failing the whole log. */
function readEntries(logPath: string): { entries: VaultActivityEntry[]; dropped: number } {
  let content: string
  try {
    content = fs.readFileSync(logPath, 'utf-8')
  } catch {
    return { entries: [], dropped: 0 }
  }

  const entries: VaultActivityEntry[] = []
  let dropped = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = VaultActivityEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.push(parsed.data)
      else dropped++
    } catch {
      dropped++
    }
  }
  return { entries, dropped }
}

function pruneEntries(
  entries: VaultActivityEntry[],
  retentionDays: VaultActivityRetentionDays,
  now = Date.now()
): VaultActivityEntry[] {
  const cutoff = now - retentionDays * DAY_MS
  const kept = entries.filter((entry) => {
    const at = Date.parse(entry.at)
    return Number.isFinite(at) && at >= cutoff
  })
  return kept.length > MAX_ACTIVITY_ENTRIES ? kept.slice(-MAX_ACTIVITY_ENTRIES) : kept
}

function collectReportedSkips(entries: VaultActivityEntry[]): Set<string> {
  const skips = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'skipped' && entry.reason === 'unsupported-type' && entry.path) {
      skips.add(entry.path)
    }
  }
  return skips
}

function notifyChanged(): void {
  if (changedTimer) return
  changedTimer = setTimeout(() => {
    changedTimer = null
    broadcastToAllWindows(VaultActivityChannels.events.CHANGED)
  }, CHANGED_THROTTLE_MS)
}

function scheduleWrite(s: ActivityState): void {
  if (s.writeTimer) return
  s.writeTimer = setTimeout(() => {
    s.writeTimer = null
    void writePending(s)
  }, WRITE_DELAY_MS)
}

/**
 * Replace a file through a sibling temp file: unpredictable name, exclusive
 * create, owner-only mode, so the write cannot be hijacked or half-read.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    await fsp.rename(tmpPath, filePath)
  } catch (error) {
    await fsp.rm(tmpPath, { force: true })
    throw error
  }
}

function writePending(s: ActivityState): Promise<void> {
  s.writeChain = s.writeChain
    .then(async () => {
      if (!s.needsRewrite && s.pending.length === 0) return
      await fsp.mkdir(path.dirname(s.logPath), { recursive: true })
      if (s.needsRewrite) {
        s.needsRewrite = false
        s.pending = []
        const body = s.entries.map((entry) => JSON.stringify(entry)).join('\n')
        await writeFileAtomic(s.logPath, body ? `${body}\n` : '')
        return
      }
      const lines = s.pending
      s.pending = []
      await fsp.appendFile(s.logPath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    })
    .catch((error: unknown) => {
      logger.warn('Failed to write the vault activity log', { error })
    })
  return s.writeChain
}

/**
 * Load the log for a freshly opened vault. Entries past the retention window
 * (or the entry cap) are dropped and the file is compacted in the background.
 */
export function openActivityLog(vaultPath: string): void {
  if (state?.vaultPath === vaultPath) return
  if (state) void closeActivityLog()

  const memryDir = path.join(vaultPath, MEMRY_DIR)
  const logPath = path.join(memryDir, LOG_FILE)
  const settingsPath = path.join(memryDir, SETTINGS_FILE)
  const retentionDays = readRetentionDays(settingsPath)
  const { entries: loaded, dropped } = readEntries(logPath)
  const entries = pruneEntries(loaded, retentionDays)

  state = {
    vaultPath,
    logPath,
    settingsPath,
    entries,
    retentionDays,
    pending: [],
    needsRewrite: dropped > 0 || entries.length !== loaded.length,
    writeTimer: null,
    writeChain: Promise.resolve(),
    reportedSkips: collectReportedSkips(entries),
    recentKeys: new Map()
  }

  if (state.needsRewrite) scheduleWrite(state)
}

/** Flush buffered entries and detach from the vault. */
export async function closeActivityLog(): Promise<void> {
  const s = state
  if (!s) return
  state = null
  // Told now rather than after the throttle, so the renderer stops showing a
  // closed vault's entries.
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  broadcastToAllWindows(VaultActivityChannels.events.CHANGED)
  if (s.writeTimer) {
    clearTimeout(s.writeTimer)
    s.writeTimer = null
  }
  await writePending(s)
}

/** Resolve buffered writes. Test and shutdown helper. */
export async function flushActivityLog(): Promise<void> {
  const s = state
  if (!s) return
  if (s.writeTimer) {
    clearTimeout(s.writeTimer)
    s.writeTimer = null
  }
  await writePending(s)
}

/** Vault-relative form of an absolute path; paths outside the vault keep only their name. */
export function toActivityPath(absoluteOrRelative: string): string {
  const s = state
  if (!s || !path.isAbsolute(absoluteOrRelative)) return normalizeRelativePath(absoluteOrRelative)
  const relative = path.relative(s.vaultPath, absoluteOrRelative)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(absoluteOrRelative)
  }
  return normalizeRelativePath(relative)
}

/**
 * Record one entry. A no-op while no vault is open; never throws.
 * @returns whether the entry was recorded (false when deduplicated or no vault).
 */
export function recordActivity(input: VaultActivityInput): boolean {
  const s = state
  if (!s) return false

  try {
    const { dedupeKey, dedupeWindowMs, ...fields } = input
    const now = Date.now()
    if (dedupeKey) {
      const last = s.recentKeys.get(dedupeKey)
      if (last !== undefined && now - last < (dedupeWindowMs ?? 0)) return false
      s.recentKeys.set(dedupeKey, now)
    }

    const entry: VaultActivityEntry = {
      v: 1,
      id: generateId(),
      at: new Date(now).toISOString(),
      ...fields
    }
    if (entry.message && entry.message.length > MAX_MESSAGE_LENGTH) {
      entry.message = `${entry.message.slice(0, MAX_MESSAGE_LENGTH)}…`
    }
    if (entry.items && entry.items.length > VAULT_ACTIVITY_MAX_ITEMS) {
      entry.items = entry.items.slice(0, VAULT_ACTIVITY_MAX_ITEMS)
    }
    // Strip explicit undefineds so the line stays as small as the entry.
    for (const key of Object.keys(entry) as (keyof VaultActivityEntry)[]) {
      if (entry[key] === undefined) delete entry[key]
    }

    s.entries.push(entry)
    if (s.entries.length > MAX_ACTIVITY_ENTRIES + COMPACT_SLACK) {
      s.entries = s.entries.slice(-MAX_ACTIVITY_ENTRIES)
      s.needsRewrite = true
    } else if (!s.needsRewrite) {
      s.pending.push(JSON.stringify(entry))
    }
    scheduleWrite(s)
    notifyChanged()
    return true
  } catch (error) {
    logger.warn('Failed to record vault activity', { error })
    return false
  }
}

/**
 * Report a file the vault ignores because of its type. Each path is reported
 * once while its entry is retained: the watcher re-evaluates an ignored file on
 * every change in its folder, and the open-time scan sees it on every launch.
 */
export function recordSkippedFile(
  relativePath: string,
  source: 'watcher' | 'scan' | 'drop'
): boolean {
  const s = state
  if (!s) return false
  const normalized = normalizeRelativePath(relativePath)
  if (s.reportedSkips.has(normalized) || isNotUserContent(normalized)) return false
  s.reportedSkips.add(normalized)
  const ext = path.extname(normalized).replace(/^\./, '').toLowerCase()
  return recordActivity({
    kind: 'skipped',
    source,
    path: normalized,
    reason: 'unsupported-type',
    ...(ext ? { message: `.${ext}` } : {})
  })
}

/** A file dropped onto the sidebar that could not be copied into the vault. */
export function recordDropCopyFailure(fileName: string, message: string): void {
  recordActivity({ kind: 'failed', source: 'drop', path: fileName, reason: 'copy-failed', message })
}

// ============================================================================
// Open-time scan
// ============================================================================

/** What one vault walk found, as collected by the indexer. */
export interface ScanActivity {
  /** Paths indexed for the first time (capped at {@link SCAN_COLLECT_LIMIT}). */
  added: string[]
  addedCount: number
  failed: { path: string; reason: 'read-failed' | 'index-failed'; message?: string }[]
  failedCount: number
  /** Unsupported file paths (capped at {@link SCAN_COLLECT_LIMIT}). */
  unsupported: string[]
  unsupportedCount: number
}

export const SCAN_COLLECT_LIMIT = 10_000
/** A scan that found more new files than this records one summary instead. */
const SCAN_PER_FILE_ADDED_LIMIT = 20
const SCAN_PER_FILE_FAILED_LIMIT = 50
/**
 * New unsupported files reported per scan. A vault holding thousands of them
 * converges over a few launches instead of flooding one.
 */
const SCAN_PER_FILE_SKIPPED_LIMIT = 500

export function createScanActivity(): ScanActivity {
  return {
    added: [],
    addedCount: 0,
    failed: [],
    failedCount: 0,
    unsupported: [],
    unsupportedCount: 0
  }
}

/**
 * Record what a vault walk found.
 *
 * `rebuild` is a walk over an empty index (first open, corruption recovery, a
 * structural config change): every file reads as new, so none of them is
 * reported as added — one summary says the index was built.
 */
export function recordScanActivity(scan: ScanActivity, mode: 'scan' | 'rebuild'): void {
  const s = state
  if (!s) return

  const addedPerFile = mode === 'scan' && scan.addedCount <= SCAN_PER_FILE_ADDED_LIMIT
  if (addedPerFile) {
    for (const addedPath of scan.added) {
      recordActivity({ kind: 'added', source: 'scan', path: addedPath })
    }
  }

  for (const failure of scan.failed.slice(0, SCAN_PER_FILE_FAILED_LIMIT)) {
    recordActivity({
      kind: 'failed',
      source: 'scan',
      path: failure.path,
      reason: failure.reason,
      ...(failure.message ? { message: failure.message } : {})
    })
  }

  const candidates = scan.unsupported.map(normalizeRelativePath).filter((p) => !isNotUserContent(p))
  let reported = 0
  for (const unsupportedPath of candidates) {
    if (reported >= SCAN_PER_FILE_SKIPPED_LIMIT) break
    if (recordSkippedFile(unsupportedPath, 'scan')) reported++
  }
  const unreportedPaths = candidates.filter((p) => !s.reportedSkips.has(p))
  // Past the collection cap the paths are unknown; they still count.
  const unreported = unreportedPaths.length + (scan.unsupportedCount - scan.unsupported.length)

  const needsSummary =
    mode === 'rebuild' ||
    (!addedPerFile && scan.addedCount > 0) ||
    scan.failedCount > SCAN_PER_FILE_FAILED_LIMIT ||
    unreported > 0
  if (!needsSummary) return

  const counts: Record<string, number> = {}
  if (scan.addedCount > 0) counts.added = scan.addedCount
  if (scan.failedCount > 0) counts.failed = scan.failedCount
  if (unreported > 0) counts.unsupported = unreported

  const items =
    !addedPerFile && mode === 'scan'
      ? scan.added.slice(0, VAULT_ACTIVITY_MAX_ITEMS)
      : unreportedPaths.slice(0, VAULT_ACTIVITY_MAX_ITEMS)

  recordActivity({
    kind: 'scan',
    source: 'scan',
    ...(mode === 'rebuild' ? { reason: 'index-rebuilt' } : {}),
    counts,
    ...(items.length > 0 ? { items } : {})
  })
}

/**
 * Files that are neither unsupported user content nor worth a line: canvases
 * (the canvas store owns them, not the note index), and the lock/partial files
 * editors and browsers leave next to a document while it is open.
 */
const TRANSIENT_FILE_RE = /(^~\$)|(~$)|\.(tmp|temp|part|partial|crdownload|download|swp|lock)$/i

function isNotUserContent(relativePath: string): boolean {
  const name = path.posix.basename(relativePath)
  return name.toLowerCase().endsWith(CANVAS_FILE_EXT) || TRANSIENT_FILE_RE.test(name)
}

function isProblem(entry: VaultActivityEntry): boolean {
  if (entry.kind === 'skipped' || entry.kind === 'failed') return true
  const counts = entry.counts
  if (!counts) return false
  return (counts.failed ?? 0) > 0 || (counts.skipped ?? 0) > 0 || (counts.unsupported ?? 0) > 0
}

export function listActivity(
  options: { limit?: number; filter?: VaultActivityFilter } = {}
): VaultActivityEntry[] {
  const s = state
  if (!s) return []
  const limit = options.limit ?? 200
  const result: VaultActivityEntry[] = []
  for (let i = s.entries.length - 1; i >= 0 && result.length < limit; i--) {
    const entry = s.entries[i]
    if (options.filter === 'problems' && !isProblem(entry)) continue
    result.push(entry)
  }
  return result
}

export function isActivityLogOpen(): boolean {
  return state !== null
}

export function getActivityRetentionDays(): VaultActivityRetentionDays {
  return state?.retentionDays ?? VAULT_ACTIVITY_DEFAULT_RETENTION_DAYS
}

/**
 * Flush buffered entries and make sure the file exists, so revealing it in
 * Finder/Explorer shows the file even before anything was recorded.
 * @returns the log path, or null when no vault is open.
 */
export async function prepareActivityLogFile(): Promise<string | null> {
  const s = state
  if (!s) return null
  await flushActivityLog()
  try {
    await fsp.mkdir(path.dirname(s.logPath), { recursive: true })
    await fsp.appendFile(s.logPath, '', { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    logger.warn('Failed to create the vault activity log file', { error })
  }
  return s.logPath
}

export async function setActivityRetentionDays(days: VaultActivityRetentionDays): Promise<void> {
  const s = state
  if (!s) return
  s.retentionDays = days
  const pruned = pruneEntries(s.entries, days)
  if (pruned.length !== s.entries.length) {
    s.entries = pruned
    s.reportedSkips = collectReportedSkips(pruned)
    s.needsRewrite = true
    scheduleWrite(s)
    notifyChanged()
  }
  await fsp.mkdir(path.dirname(s.settingsPath), { recursive: true })
  await writeFileAtomic(s.settingsPath, `${JSON.stringify({ retentionDays: days }, null, 2)}\n`)
}

export async function clearActivity(): Promise<void> {
  const s = state
  if (!s) return
  s.entries = []
  s.pending = []
  s.reportedSkips.clear()
  s.recentKeys.clear()
  s.needsRewrite = true
  notifyChanged()
  await flushActivityLog()
}
