/**
 * Open large-file-class files for the read-only streaming viewer.
 *
 * A session is one open file handle plus the sparse line-offset index built for
 * it. Nothing in this module ever reads the file as a whole: `open` stats, the
 * scan streams, and every read is a window at a byte offset. That is the point
 * — above 512 MB there is no string that could hold the file, and well below it
 * a whole-file read is a main-process allocation and GC pause on its own.
 *
 * Seam for in-file search (#1464): a search runs over exactly this session —
 * the same handle and the same index — so it belongs beside `readLargeFileLines`
 * rather than opening the file a second time. `withSession` is what a search
 * handler needs.
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { toAbsolutePath, getVaultRoot } from './notes-io'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { buildLineIndex } from './large-file-index-bridge'
import { fileHandleReader, readLines, type ByteReader, type LineIndex } from './large-file-index'
import { runFileSearch, type FileSearchRun } from './large-file-search-bridge'
import {
  NotesChannels,
  type LargeFileIndexEvent,
  type LargeFileLinesResult,
  type LargeFileOpenResult,
  type LargeFileSearchResult
} from '@memry/contracts/notes-api'

const logger = createLogger('LargeFileSession')

/**
 * Hard ceiling on what the viewer will open.
 *
 * SQLite's MAX_LENGTH — the largest value the rest of the app can carry for one
 * file — is where this number comes from. 512 MB (V8's string cap) was
 * considered and rejected: a 512 MB file cannot be one string either, so the
 * viewer chunks regardless, and once it chunks 512 MB and 2 GB cost the same.
 */
export const VIEWER_MAX_BYTES = 2_147_483_645

/**
 * Open sessions kept alive at once. Each pins one OS file handle, and a viewer
 * that never evicts holds one per file the user opened this session.
 */
export const MAX_OPEN_SESSIONS = 4

interface Session {
  id: string
  noteId: string
  absolutePath: string
  handle: FileHandle
  read: ByteReader
  fileBytes: number
  mtimeMs: number
  index: LineIndex | null
  /** The in-file search crossing this file right now, if any. */
  search: FileSearchRun | null
  /** Bumped per search, so a superseded query's progress is ignored. */
  searchToken: number
}

/** Insertion-ordered, which is what makes the oldest entry the eviction target. */
const sessions = new Map<string, Session>()

function emit(event: LargeFileIndexEvent): void {
  broadcastToAllWindows(NotesChannels.events.LARGE_FILE_INDEX, event)
}

function findByNote(noteId: string): Session | undefined {
  for (const session of sessions.values()) {
    if (session.noteId === noteId) return session
  }
  return undefined
}

async function disposeSession(session: Session): Promise<void> {
  sessions.delete(session.id)
  // A search left running would keep crossing a file nobody is looking at, and
  // its worker would outlive the handle it was opened for.
  session.search?.cancel()
  session.search = null
  await session.handle.close().catch((err) => {
    logger.warn('Failed to close large-file handle', { path: session.absolutePath, err })
  })
}

async function evictOldest(): Promise<void> {
  while (sessions.size >= MAX_OPEN_SESSIONS) {
    const oldest = sessions.values().next().value
    if (!oldest) return
    await disposeSession(oldest)
  }
}

/**
 * Prepare a large-file-class file for reading.
 *
 * Returns as soon as the handle is open; the whole-file newline scan runs
 * behind it and reports on `NotesChannels.events.LARGE_FILE_INDEX`. Awaiting
 * the scan here would be the freeze this feature exists to remove, only moved.
 */
export async function openLargeFileSession(noteId: string): Promise<LargeFileOpenResult> {
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  if (!cached) return { status: 'missing' }

  const absolutePath = toAbsolutePath(cached.path)
  if (!isInsideVault(absolutePath)) {
    // The renderer only ever names a note id, and the path behind it comes from
    // the index DB — but that DB is a file on disk the app does not own
    // exclusively, and `path.join` resolves `../` out of the vault without
    // complaint. Nothing outside the vault is ours to open.
    logger.warn('Refusing to open a path outside the vault', { path: cached.path })
    return { status: 'missing' }
  }

  // Open first, then measure through the handle. Stat-then-open reads whatever
  // the path points at by the time the open lands, which need not be the file
  // that was measured — and the whole session rests on that measurement.
  const handle = await fs.open(absolutePath, 'r').catch((err) => {
    logger.warn('Failed to open large file', { path: cached.path, err })
    return null
  })
  if (!handle) return { status: 'missing' }

  const closeHandle = async (): Promise<void> => {
    await handle.close().catch(() => {})
  }

  const stats = await handle.stat().catch(() => null)
  if (!stats) {
    await closeHandle()
    return { status: 'missing' }
  }

  if (stats.size > VIEWER_MAX_BYTES) {
    await closeHandle()
    logger.info('File is past the viewer ceiling; not opening', {
      path: cached.path,
      fileBytes: stats.size,
      maxBytes: VIEWER_MAX_BYTES
    })
    return { status: 'too-large', fileBytes: stats.size, maxBytes: VIEWER_MAX_BYTES }
  }

  // A tab switch back to an already-scanned file must not pay for the scan
  // again. Size and mtime together are what make the cached index still true.
  const existing = findByNote(noteId)
  if (existing) {
    const unchanged = existing.fileBytes === stats.size && existing.mtimeMs === stats.mtimeMs
    if (unchanged) {
      await closeHandle()
      return existing.index
        ? {
            status: 'ready',
            sessionId: existing.id,
            fileBytes: existing.fileBytes,
            lineCount: existing.index.lineCount
          }
        : { status: 'indexing', sessionId: existing.id, fileBytes: existing.fileBytes }
    }
    // The file moved underneath the index: every checkpoint offset is now a
    // guess. Start over rather than seek into stale positions.
    await disposeSession(existing)
  }

  await evictOldest()

  const session: Session = {
    id: randomUUID(),
    noteId,
    absolutePath,
    handle,
    read: fileHandleReader(handle),
    fileBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    index: null,
    search: null,
    searchToken: 0
  }
  sessions.set(session.id, session)

  void startScan(session)

  return { status: 'indexing', sessionId: session.id, fileBytes: session.fileBytes }
}

/** True when `absolutePath` resolves inside the open vault. */
function isInsideVault(absolutePath: string): boolean {
  const root = path.resolve(getVaultRoot())
  const relative = path.relative(root, path.resolve(absolutePath))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function startScan(session: Session): Promise<void> {
  try {
    const index = await buildLineIndex(
      session.absolutePath,
      session.fileBytes,
      // The in-process fallback reuses this session's handle rather than
      // resolving the path a second time.
      session.read,
      (bytesScanned) => {
        if (!sessions.has(session.id)) return
        emit({
          sessionId: session.id,
          status: 'scanning',
          bytesScanned,
          fileBytes: session.fileBytes
        })
      }
    )

    // Evicted or closed while scanning: the handle is already gone, so there is
    // nothing the index could be used for.
    if (!sessions.has(session.id)) return

    session.index = index
    emit({
      sessionId: session.id,
      status: 'ready',
      fileBytes: session.fileBytes,
      lineCount: index.lineCount
    })
  } catch (err) {
    logger.error('Line-offset scan failed', { path: session.absolutePath, err })
    if (!sessions.has(session.id)) return
    emit({
      sessionId: session.id,
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
    await disposeSession(session)
  }
}

/**
 * Run `run` against a live, fully indexed session.
 *
 * The seam #1464 needs: in-file search reads through the same handle and the
 * same index rather than reopening the file.
 */
export async function withSession<T>(
  sessionId: string,
  run: (read: ByteReader, index: LineIndex) => Promise<T>
): Promise<T | null> {
  const session = sessions.get(sessionId)
  if (!session || !session.index) return null
  return run(session.read, session.index)
}

export async function readLargeFileLines(input: {
  sessionId: string
  startLine: number
  count: number
}): Promise<LargeFileLinesResult | null> {
  return withSession(input.sessionId, async (read, index) => {
    const window = await readLines(read, index, input.startLine, input.count)
    return { ...window, lineCount: index.lineCount }
  })
}

/**
 * Find every occurrence of `query` in an open session's file.
 *
 * The path comes from the session, never from the caller, and the pass runs on
 * a worker. One search per session at a time: a newer query cancels the older
 * one, which resolves `cancelled` so its caller stops waiting on an answer the
 * user has already typed past.
 */
export async function searchLargeFileSession(input: {
  sessionId: string
  query: string
}): Promise<LargeFileSearchResult | null> {
  const session = sessions.get(input.sessionId)
  if (!session) return null

  session.search?.cancel()
  session.searchToken += 1
  const token = session.searchToken

  const run = runFileSearch(
    session.absolutePath,
    input.query,
    session.read,
    (bytesSearched, total) => {
      // A count from the query before last would overwrite the current one.
      if (session.searchToken !== token || !sessions.has(session.id)) return
      broadcastToAllWindows(NotesChannels.events.LARGE_FILE_SEARCH_PROGRESS, {
        sessionId: session.id,
        query: input.query,
        bytesSearched,
        fileBytes: session.fileBytes,
        total
      })
    }
  )
  session.search = run

  const found = await run.result
  if (session.searchToken === token) session.search = null

  if (found.cancelled) return { status: 'cancelled', query: input.query }
  return {
    status: 'complete',
    query: input.query,
    hits: found.hits,
    total: found.total,
    limited: found.limited
  }
}

export async function closeLargeFileSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  await disposeSession(session)
}

/** Release every handle. Called on vault close and app quit. */
export async function closeAllLargeFileSessions(): Promise<void> {
  for (const session of [...sessions.values()]) {
    await disposeSession(session)
  }
}
