import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import { markWritebackIgnored } from './crdt-writeback'
import { getRawIndexDatabase, isIndexDatabaseInitialized } from '../database/client'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import type Database from 'better-sqlite3'

const log = createLogger('BulkApply')

/**
 * Page-scoped apply machinery for the pull path: one SQLite transaction per
 * pulled page (data DB + index DB), with note markdown writes deferred out of
 * the synchronous apply loop and flushed asynchronously after commit.
 *
 * CRASH-SAFETY INVARIANT (heal path, not write-before-commit): the DB rows for
 * a page commit FIRST, then the page's note files are written asynchronously.
 * The window between the two is covered by a journal: the pending file writes
 * are recorded in a single synchronous journal write immediately BEFORE the DB
 * commit, and the journal is deleted only after every file landed. A crash
 * inside the window is healed by `replayBulkApplyJournal()` at the start of the
 * next pull: it re-materializes exactly the files whose rows committed but
 * whose bytes never reached the vault.
 *
 * Why files are not written before the commit instead: the apply loop must stay
 * fully synchronous while the transaction is open. better-sqlite3 shares one
 * connection per DB across the whole main process, so an `await` inside an open
 * transaction would let unrelated main-process code (IPC handlers, timers) run
 * its own statements into — or its own `BEGIN` against — this transaction.
 * Deferring the (async) file writes to after the synchronous commit is what
 * keeps the transaction interleaving-free, and the journal is what keeps that
 * reordering crash-safe.
 */

/** Journal of file writes whose DB rows may already be committed. */
const JOURNAL_FILE_NAME = 'sync-bulk-apply-journal.json'

/**
 * On-disk journal shape. `writtenAt` is the wall clock of the last journal
 * rewrite; replay uses it to tell bytes a post-crash writer produced from
 * bytes the crash window left stale (see `replayBulkApplyJournal`).
 */
interface JournalFile {
  writtenAt: number
  entries: PendingNoteFileWrite[]
}

interface PendingNoteFileWrite {
  absolutePath: string
  content: string
  /** sha256 of `content`, recorded when the write is deferred. */
  sha256?: string
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

function journalPath(): string {
  return path.join(app.getPath('userData'), JOURNAL_FILE_NAME)
}

/**
 * Every file write journaled but not yet confirmed on disk, across pages.
 * Pages are strictly sequential (the pull lock serializes them, and each page
 * awaits its own flush), so this is only ever appended to by a committing page
 * and drained by that page's flush — but it outlives a single session so a
 * partially-failed flush is never overwritten by the next page's commit.
 */
let unlandedWrites: PendingNoteFileWrite[] = []

/**
 * The atomic tmp-write-then-rename every synced note file gets, sync path and
 * deferred flush alike. `markWritebackIgnored` is called here, at actual write
 * time, because its ignore window is TTL-based — marking at enqueue time could
 * expire before a deferred flush reaches the file.
 */
function writeNoteFileNow(absolutePath: string, content: string): void {
  markWritebackIgnored(absolutePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  const tmpPath = absolutePath + '.tmp'
  fs.writeFileSync(tmpPath, content, 'utf-8')
  fs.renameSync(tmpPath, absolutePath)
}

async function writeNoteFileNowAsync(absolutePath: string, content: string): Promise<void> {
  markWritebackIgnored(absolutePath)
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
  const tmpPath = absolutePath + '.tmp'
  await fs.promises.writeFile(tmpPath, content, 'utf-8')
  await fs.promises.rename(tmpPath, absolutePath)
}

let activeSession: PageApplySession | null = null

/**
 * Write a synced note's markdown file, or defer it into the active page apply
 * session. Outside a session (steady-state small pulls, deferred retries,
 * orphan repair, recovered items) this is byte-for-byte the synchronous
 * tmp-write + rename the note handler always performed.
 */
export function writeSyncedNoteFile(absolutePath: string, content: string): void {
  if (activeSession) {
    activeSession.deferWrite(absolutePath, content)
    return
  }
  writeNoteFileNow(absolutePath, content)
}

export interface PageApplyHandle {
  /**
   * The data DB to run the page's applies through. Handlers wrap their
   * per-item apply in `ctx.db.transaction((tx) => …)`; drizzle routes that to
   * better-sqlite3's native `transaction()`, which detects the open page
   * transaction and nests itself on a SAVEPOINT automatically — so per-item
   * rollback semantics hold inside the page without any remapping here.
   */
  db: DrizzleDb
  /** Journal the deferred file writes, then COMMIT both DBs (data first). */
  commit(): void
  /** ROLLBACK both DBs and discard the page's deferred file writes. */
  rollback(): void
  /**
   * Write the deferred note files (after commit). Resolves once every file
   * settled; the journal is removed only when all of them landed, so a partial
   * flush is retried by the next replay.
   */
  flushFiles(): Promise<void>
}

class PageApplySession implements PageApplyHandle {
  readonly db: DrizzleDb
  private readonly dataRaw: Database.Database | null
  private readonly indexRaw: Database.Database | null
  private pendingWrites: PendingNoteFileWrite[] = []
  private finished = false

  constructor(dataDb: DrizzleDb) {
    this.dataRaw = extractRawClient(dataDb)
    this.indexRaw = resolveIndexRaw()

    if (this.dataRaw && !this.dataRaw.inTransaction) {
      this.dataRaw.exec('BEGIN IMMEDIATE')
    } else if (this.dataRaw?.inTransaction) {
      // Already inside someone else's transaction — never nest a raw BEGIN.
      // The page then runs on implicit per-statement transactions, which is
      // the pre-batching behavior.
      log.warn('Data DB already in a transaction — page apply runs untransacted')
      this.dataRaw = null
    }

    if (this.indexRaw && !this.indexRaw.inTransaction) {
      try {
        this.indexRaw.exec('BEGIN IMMEDIATE')
      } catch (err) {
        log.warn('Could not open the index DB page transaction', { error: err })
        this.indexRaw = null
      }
    } else {
      this.indexRaw = null
    }

    this.db = dataDb
  }

  deferWrite(absolutePath: string, content: string): void {
    this.pendingWrites.push({ absolutePath, content, sha256: sha256Hex(content) })
  }

  commit(): void {
    if (this.finished) return
    this.finished = true
    if (activeSession === this) activeSession = null

    // The journal must be durable before the rows it covers: a crash right
    // after the data commit must still find every pending file's bytes.
    unlandedWrites.push(...this.pendingWrites)
    if (unlandedWrites.length > 0) {
      writeJournal(unlandedWrites)
    }

    try {
      // Data first, index second. The index DB is a rebuildable cache; a crash
      // between the two commits leaves data rows whose index rows are missing,
      // which the next re-pull of the page treats as an update (no duplicate
      // paths). The reverse order would leave index ghosts that collide with the
      // re-pulled creates.
      this.dataRaw?.exec('COMMIT')
      try {
        this.indexRaw?.exec('COMMIT')
      } catch (err) {
        // Same rule as the data connection below: a failed COMMIT leaves the
        // connection inside an open transaction, and an index one left open
        // would run every later FTS/graph statement uncommitted-visible and
        // fail every future BEGIN IMMEDIATE for the life of the process. The
        // data rows are already safe and the index is a rebuildable cache, so
        // the rolled-back page's index rows simply re-apply on the next pull.
        log.error('Index DB page commit failed after data commit', { error: err })
        try {
          if (this.indexRaw?.inTransaction) this.indexRaw.exec('ROLLBACK')
        } catch (rollbackErr) {
          log.error('Could not roll back the index DB page transaction', { error: rollbackErr })
        }
      }
    } catch (err) {
      // A failed COMMIT leaves the connection inside an open transaction — it
      // must be rolled back here, or every later statement in the process runs
      // inside this half-dead page transaction forever. The journaled writes
      // cover rows that no longer exist, so drop the journal with them: stray
      // markdown without a row is inert, and the page is re-pulled whole.
      log.error('Data DB page commit failed — rolled back', { error: err })
      try {
        if (this.dataRaw?.inTransaction) this.dataRaw.exec('ROLLBACK')
      } catch (rollbackErr) {
        log.error('Could not roll back after a failed page commit', { error: rollbackErr })
      }
      unlandedWrites = unlandedWrites.filter((w) => !this.pendingWrites.includes(w))
      if (unlandedWrites.length === 0) removeJournal()
      else writeJournal(unlandedWrites)
      throw err
    }
  }

  rollback(): void {
    if (this.finished) return
    this.finished = true
    if (activeSession === this) activeSession = null

    for (const [label, raw] of [
      ['index', this.indexRaw],
      ['data', this.dataRaw]
    ] as const) {
      try {
        if (raw?.inTransaction) raw.exec('ROLLBACK')
      } catch (err) {
        log.error(`Could not roll back the ${label} DB page transaction`, { error: err })
      }
    }

    // These rows never committed, so their file writes must not survive in the
    // journal either. Earlier pages' still-unlanded entries stay.
    if (this.pendingWrites.length > 0) {
      unlandedWrites = unlandedWrites.filter((w) => !this.pendingWrites.includes(w))
      if (unlandedWrites.length === 0) removeJournal()
      else writeJournal(unlandedWrites)
    }
    this.pendingWrites = []
  }

  async flushFiles(): Promise<void> {
    const writes = this.pendingWrites
    this.pendingWrites = []
    if (writes.length === 0) return

    const landed = new Set<string>()
    const failed: PendingNoteFileWrite[] = []
    await Promise.all(
      writes.map(async (write) => {
        try {
          await writeNoteFileNowAsync(write.absolutePath, write.content)
          landed.add(write.absolutePath)
        } catch (err) {
          failed.push(write)
          log.error('Deferred synced-note file write failed — journal replay will retry', {
            path: write.absolutePath,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })
    )

    // Only entries confirmed on disk leave the journal; anything else — this
    // page's failures or an earlier page's — stays for `replayBulkApplyJournal`.
    unlandedWrites = unlandedWrites.filter((w) => !landed.has(w.absolutePath))
    if (unlandedWrites.length === 0) removeJournal()
    else writeJournal(unlandedWrites)
  }
}

function extractRawClient(db: DrizzleDb): Database.Database | null {
  const candidate = (db as { $client?: unknown }).$client
  if (
    candidate &&
    typeof (candidate as Database.Database).exec === 'function' &&
    typeof (candidate as Database.Database).inTransaction === 'boolean'
  ) {
    return candidate as Database.Database
  }
  // Test stubs and non-better-sqlite3 shims land here: the page still applies,
  // just without an explicit transaction — identical to the pre-batching path.
  return null
}

function resolveIndexRaw(): Database.Database | null {
  try {
    if (!isIndexDatabaseInitialized()) return null
    return getRawIndexDatabase()
  } catch {
    return null
  }
}

/**
 * Open the page apply session: transactions on both DBs, deferred note file
 * writes. One at a time by construction — the pull lock serializes pages — and
 * a nested begin is refused loudly rather than silently stacked.
 */
export function beginPageApply(dataDb: DrizzleDb): PageApplyHandle {
  if (activeSession) {
    throw new Error('A bulk page apply session is already active')
  }
  const session = new PageApplySession(dataDb)
  activeSession = session
  return session
}

/**
 * Write the journal durably. fsync on the file BEFORE the rename and a
 * best-effort fsync on the parent directory after it, so the bytes cannot
 * still be in the page cache when the DB commit below makes them load-bearing:
 * power loss between that commit and an unfsynced journal would leave committed
 * rows with neither their files nor the record that rebuilds them.
 */
function writeJournal(writes: PendingNoteFileWrite[]): void {
  const target = journalPath()
  const tmp = target + '.tmp'
  const payload = JSON.stringify({
    writtenAt: Date.now(),
    entries: writes
  } satisfies JournalFile)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, payload, null, 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, target)
  fsyncDirectory(path.dirname(target))
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems; the file's
    // own fsync is the guarantee this depends on.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing to do — the fd may already be closed by a failed fsync path.
      }
    }
  }
}

function removeJournal(): void {
  try {
    fs.unlinkSync(journalPath())
  } catch {
    // Already gone — nothing to remove.
  }
}

/**
 * Heal the crash window: files journaled before a page commit whose async
 * flush never completed. Called at the start of every pull, before any page
 * applies.
 *
 * Replay decision per path (last journal entry wins):
 *
 *   - file bytes hash to the entry's sha256 → the flush landed them; skip.
 *   - the file differs but was modified AFTER the journal was written → a
 *     writer that acted after the crash got there first — a writeback, an
 *     editor, an external change. Its state also lives in the CRDT doc and is
 *     re-merged from the file by the watcher, so it supersedes the journal;
 *     leave it standing.
 *   - otherwise → pre-crash bytes the flush never replaced: write the journal
 *     content. This is the case that matters: skipping on mere existence kept
 *     an UPDATE's old bytes on disk forever while its row moved on. The
 *     journal content is exactly what the committed row describes, so
 *     overwriting restores row/file agreement; `markWritebackIgnored` keeps
 *     the replay's own echo out of the watcher.
 */
export function replayBulkApplyJournal(): void {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath(), 'utf-8')
  } catch {
    return
  }

  let entries: PendingNoteFileWrite[] = []
  let writtenAt = 0
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      // Pre-`writtenAt` journals were a bare array; no mtime evidence survives,
      // so replay falls back to overwrite-on-mismatch for them.
      entries = parsed.filter(isPendingNoteFileWrite)
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as JournalFile).entries)
    ) {
      const journal = parsed as JournalFile
      if (typeof journal.writtenAt === 'number') writtenAt = journal.writtenAt
      entries = journal.entries.filter(isPendingNoteFileWrite)
    }
  } catch (err) {
    log.error('Bulk apply journal is unreadable — dropping it', { error: err })
    removeJournal()
    return
  }

  // Same path written twice across pages: the LAST entry is the newest row
  // content, so collapse to one entry per path before writing anything.
  const latestByPath = new Map<string, PendingNoteFileWrite>()
  for (const entry of entries) latestByPath.set(entry.absolutePath, entry)

  let healed = 0
  for (const entry of latestByPath.values()) {
    try {
      if (isAlreadyLanded(entry, writtenAt)) continue
      writeNoteFileNow(entry.absolutePath, entry.content)
      healed++
    } catch (err) {
      log.error('Could not heal a journaled note file', {
        path: entry.absolutePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  removeJournal()
  if (healed > 0) {
    log.info('Healed note files from the bulk apply journal', { healed, total: latestByPath.size })
  }
}

function isPendingNoteFileWrite(e: unknown): e is PendingNoteFileWrite {
  return (
    !!e &&
    typeof (e as PendingNoteFileWrite).absolutePath === 'string' &&
    typeof (e as PendingNoteFileWrite).content === 'string'
  )
}

/**
 * True when nothing about this entry still needs to reach the disk: either the
 * flush already wrote these exact bytes, or a post-journal writer left newer
 * ones there (see the replay decision on `replayBulkApplyJournal`). A missing
 * or unstatable file is always "not landed".
 */
function isAlreadyLanded(entry: PendingNoteFileWrite, journalWrittenAt: number): boolean {
  let stat: fs.Stats
  try {
    stat = fs.statSync(entry.absolutePath)
  } catch {
    return false
  }
  const intendedSha = entry.sha256 ?? sha256Hex(entry.content)
  try {
    const onDiskSha = sha256Hex(fs.readFileSync(entry.absolutePath, 'utf-8'))
    if (onDiskSha === intendedSha) return true
  } catch {
    return false
  }
  // Whole milliseconds on both sides: st.mtimeMs carries sub-ms fractions,
  // and a file written microseconds before the journal would otherwise read
  // as "later" than its own millisecond bucket. A post-journal write inside
  // that same bucket is lost to the overwrite — rare, and its bytes live on
  // in the CRDT doc either way.
  return journalWrittenAt > 0 && Math.floor(stat.mtimeMs) > journalWrittenAt
}

/** Test seam: forget a session left active by a failing test. */
export function _resetBulkApplyForTests(): void {
  activeSession = null
  unlandedWrites = []
}
