import fs from 'fs'
import path from 'path'
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

interface PendingNoteFileWrite {
  absolutePath: string
  content: string
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
   * The data DB to run the page's applies through. Same drizzle instance
   * surface, with `.transaction()` remapped onto SAVEPOINTs so per-item handler
   * transactions keep their per-item rollback semantics inside the open page
   * transaction (a nested raw `BEGIN` would throw).
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
  private savepointCounter = 0
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

    this.db = this.dataRaw ? savepointScopedDb(dataDb, this.dataRaw, this) : dataDb
  }

  nextSavepointName(): string {
    return `bulk_apply_item_${++this.savepointCounter}`
  }

  deferWrite(absolutePath: string, content: string): void {
    this.pendingWrites.push({ absolutePath, content })
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
        log.error('Index DB page commit failed after data commit', { error: err })
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
 * The data DB with `.transaction()` remapped onto SAVEPOINTs. Handlers wrap
 * their per-item apply in `ctx.db.transaction((tx) => …)`; inside the open page
 * transaction that raw `BEGIN` would throw, and silently flattening it would
 * lose the per-item rollback the handlers rely on. A savepoint gives them
 * exactly the same per-item atomicity, nested in the page.
 */
function savepointScopedDb(
  db: DrizzleDb,
  raw: Database.Database,
  session: PageApplySession
): DrizzleDb {
  const proxy: DrizzleDb = new Proxy(db as object, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (cb: (tx: unknown) => unknown) => {
          const name = session.nextSavepointName()
          raw.exec(`SAVEPOINT ${name}`)
          try {
            const result = cb(proxy)
            raw.exec(`RELEASE ${name}`)
            return result
          } catch (err) {
            raw.exec(`ROLLBACK TO ${name}`)
            raw.exec(`RELEASE ${name}`)
            throw err
          }
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    }
  }) as DrizzleDb
  return proxy
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

function writeJournal(writes: PendingNoteFileWrite[]): void {
  const target = journalPath()
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(writes), 'utf-8')
  fs.renameSync(tmp, target)
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
 * applies. A journaled file that already exists on disk is left alone — a
 * writeback, an editor, or a partially-completed flush got there first, and
 * whatever it wrote is at least as new as the journaled content.
 */
export function replayBulkApplyJournal(): void {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath(), 'utf-8')
  } catch {
    return
  }

  let entries: PendingNoteFileWrite[] = []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (e): e is PendingNoteFileWrite =>
          !!e &&
          typeof (e as PendingNoteFileWrite).absolutePath === 'string' &&
          typeof (e as PendingNoteFileWrite).content === 'string'
      )
    }
  } catch (err) {
    log.error('Bulk apply journal is unreadable — dropping it', { error: err })
    removeJournal()
    return
  }

  // Same path written twice across pages: the LAST entry is the newest row
  // content, and once the first write lands the exists-check below would skip
  // the second — so collapse to one entry per path before writing anything.
  const latestByPath = new Map<string, PendingNoteFileWrite>()
  for (const entry of entries) latestByPath.set(entry.absolutePath, entry)

  let healed = 0
  for (const entry of latestByPath.values()) {
    try {
      if (fs.existsSync(entry.absolutePath)) continue
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

/** Test seam: forget a session left active by a failing test. */
export function _resetBulkApplyForTests(): void {
  activeSession = null
  unlandedWrites = []
}
