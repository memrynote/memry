/**
 * Tier 1 of vault ingest: the idle metadata and search backfill.
 *
 * Tier 0 puts a row in the sidebar from `stat`, the path and the filename, and
 * reads nothing. This is where the body is finally measured — off the add path,
 * smallest file first, so a queued 250 MB paste never holds up the notes the
 * user is actually looking at.
 *
 * Two shapes of work, decided by `stat`:
 *
 * - Note class (under `NOTE_MAX_BYTES`) is cheap to read whole, so it takes the
 *   ordinary parse-and-sync path and, if its largest block is also within
 *   bounds, gets its CRDT doc here. That decision cannot be made at `add` time:
 *   the block bound needs the content, and the add path never reads it.
 * - Large-file class is streamed. Nothing is held as one string, so a file past
 *   V8's 536 870 888-character ceiling is measured rather than thrown at.
 *
 * @module vault/ingest-backfill
 */

import fs from 'fs/promises'
import type { Stats } from 'fs'
import { classifyMarkdownContent, classifyMarkdownStat } from '@memry/shared/markdown-class'
import { JournalChannels, NotesChannels } from '@memry/contracts/ipc-channels'
import {
  ensureTagDefinitions,
  extractDateFromPath,
  getNoteCacheById,
  isJournalEntry
} from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { flushProjectionEvents } from '../projections'
import { syncNoteCreate } from '../notes/runtime-effects'
import { enqueueJournalCreate, initializeJournalCrdt } from '../journal/runtime-effects'
import { createSnippet, extractProperties, extractTags, parseNote } from './frontmatter'
import { safeRead } from './file-ops'
import { scanMarkdownFile } from './file-scan'
import { syncLargeFileBodyToCache, syncNoteToCache } from './note-sync'

const logger = createLogger('IngestBackfill')

/**
 * Quiet period after the last `add` before the queue is worked. Paste and
 * import both arrive as bursts, and the point of the tier is to stay off the
 * critical path while they land.
 */
const IDLE_DELAY_MS = 500

/**
 * How much of a large-file-class file reaches the search index and the snippet.
 * The whole body cannot: a 250 MB file would put 250 MB in the FTS index for a
 * file that is read-only and never edited.
 */
const LARGE_FILE_INDEX_CHARS = 256 * 1024

export interface IngestBackfillEntry {
  noteId: string
  absolutePath: string
  relativePath: string
  /** From `stat` at ingest. Only used to order the queue. */
  fileBytes: number
}

const queue = new Map<string, IngestBackfillEntry>()
let idleTimer: NodeJS.Timeout | null = null
let inFlight: Promise<void> | null = null

export function enqueueIngestBackfill(entry: IngestBackfillEntry): void {
  queue.set(entry.noteId, entry)
  scheduleDrain()
}

export function clearIngestBackfill(): void {
  queue.clear()
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

// Deliberately not conditional on a run being in flight. A file queued in the
// window between the drain loop finding the queue empty and the run clearing
// itself would then never be scheduled at all, and would sit unmeasured until
// something else was added. Arming the timer regardless costs nothing: the
// callback joins the run in flight instead of starting a second one.
function scheduleDrain(): void {
  if (idleTimer) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    void drainIngestBackfill().catch((error: unknown) => {
      logger.error('Ingest backfill drain failed', { error })
    })
  }, IDLE_DELAY_MS)
  idleTimer.unref?.()
}

/**
 * Work the queue to empty. Concurrent callers join the run in flight rather
 * than starting a second one.
 */
export async function drainIngestBackfill(): Promise<void> {
  if (inFlight) {
    await inFlight
    return
  }

  inFlight = runQueue()
  try {
    await inFlight
  } finally {
    inFlight = null
  }
}

async function runQueue(): Promise<void> {
  for (let next = takeSmallest(); next !== null; next = takeSmallest()) {
    try {
      await backfillOne(next)
    } catch (error) {
      // One unreadable file must not strand every other queued note.
      logger.warn('Failed to backfill vault file', { path: next.relativePath, error })
    }
  }
}

function takeSmallest(): IngestBackfillEntry | null {
  let smallest: IngestBackfillEntry | null = null
  for (const entry of queue.values()) {
    if (smallest === null || entry.fileBytes < smallest.fileBytes) smallest = entry
  }
  if (smallest) queue.delete(smallest.noteId)
  return smallest
}

async function backfillOne(entry: IngestBackfillEntry): Promise<void> {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, entry.noteId)

  // Deleted, or renamed and re-queued under its new path, between `add` and
  // now. Either way this entry is stale and writing it back would resurrect a
  // path that no longer exists.
  if (!cached || cached.path !== entry.relativePath) return

  const stats = await fs.stat(entry.absolutePath).catch(() => null)
  if (!stats) return

  const statClass = classifyMarkdownStat(stats.size)
  if (statClass !== null) {
    await backfillLargeFile(entry, cached, stats.mtime)
    return
  }

  await backfillNote(entry, cached, stats)
}

type CachedNote = NonNullable<ReturnType<typeof getNoteCacheById>>

async function backfillNote(
  entry: IngestBackfillEntry,
  cached: CachedNote,
  stats: Stats
): Promise<void> {
  const content = await safeRead(entry.absolutePath)
  if (content === null) return

  const parsed = parseNote(content, entry.relativePath, stats)
  const db = getIndexDatabase()

  const syncResult = syncNoteToCache(
    db,
    {
      id: cached.id,
      path: entry.relativePath,
      fileContent: content,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: cached.title,
      createdAt: cached.createdAt,
      modifiedAt: parsed.modified,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )
  await flushProjectionEvents()

  const tags = syncResult.tags
  if (tags.length > 0) {
    ensureTagDefinitions(getDatabase(), tags)
  }

  // The first point at which the file's size class is known: it needs the
  // largest block, and the add path never reads the file. Both the sync item
  // and the CRDT doc are gated on it, so both are decided here.
  const classification = classifyMarkdownContent(content)
  const isLargeFile = classification.sizeClass === 'large-file'
  const isJournal = isJournalEntry(entry.relativePath)

  if (isLargeFile) {
    // Under the byte ceiling but holding one block too big to parse — the log
    // dump shape. Listed and searchable, but never seeded and never synced.
    logger.warn('Backfilled file is large-file class; not seeding or syncing it', {
      path: entry.relativePath,
      reason: classification.reason,
      fileBytes: classification.fileBytes,
      largestBlockBytes: classification.largestBlockBytes
    })
  }

  // The CRDT tag array is what write-back serializes back into the file's
  // `tags:` block, so it may only carry tags the file itself declares.
  // `syncResult.tags` merges the body's `#hashtag`s in for the index; seeding
  // those would inject a `tags:` block into a note that never had one, the
  // first time it is opened — "opening a note modified it" (#1454).
  const declaredTags = extractTags(parsed.frontmatter)

  if (isJournal) {
    if (!isLargeFile) {
      const journalDate = extractDateFromPath(entry.relativePath) ?? ''
      enqueueJournalCreate(cached.id, journalDate)
      void initializeJournalCrdt(cached.id, journalDate, declaredTags)
    }
  } else {
    syncNoteCreate(cached.id, cached.title, declaredTags, {
      sizeClass: classification.sizeClass
    })
  }

  broadcastToAllWindows(NotesChannels.events.UPDATED, {
    id: cached.id,
    changes: {
      title: cached.title,
      content: parsed.content,
      tags,
      properties: extractProperties(parsed.frontmatter),
      modified: new Date(parsed.modified),
      wordCount: syncResult.wordCount,
      snippet: syncResult.snippet
    },
    source: 'external'
  })

  if (isJournal) {
    const journalDate = extractDateFromPath(entry.relativePath) ?? ''
    broadcastToAllWindows(JournalChannels.events.ENTRY_CREATED, {
      date: journalDate,
      entry: {
        date: journalDate,
        content: parsed.content,
        tags,
        wordCount: syncResult.wordCount,
        characterCount: syncResult.characterCount,
        modified: new Date(parsed.modified),
        created: new Date(cached.createdAt)
      },
      source: 'external'
    })
  }
}

async function backfillLargeFile(
  entry: IngestBackfillEntry,
  cached: CachedNote,
  modifiedAt: Date
): Promise<void> {
  const scan = await scanMarkdownFile(entry.absolutePath, LARGE_FILE_INDEX_CHARS)
  if (scan === null) return

  syncLargeFileBodyToCache(getIndexDatabase(), {
    id: cached.id,
    path: entry.relativePath,
    title: cached.title,
    createdAt: cached.createdAt,
    modifiedAt: modifiedAt.toISOString(),
    localOnly: cached.localOnly ?? false,
    emoji: cached.emoji ?? null,
    wordCount: scan.wordCount,
    characterCount: scan.characterCount,
    contentHash: scan.contentHash,
    indexedHead: scan.head
  })
  await flushProjectionEvents()

  logger.info('Backfilled large-file-class vault file', {
    path: entry.relativePath,
    characterCount: scan.characterCount,
    indexedChars: scan.head.length
  })

  broadcastToAllWindows(NotesChannels.events.UPDATED, {
    id: cached.id,
    changes: {
      modified: modifiedAt,
      wordCount: scan.wordCount,
      snippet: createSnippet(scan.head)
    },
    source: 'external'
  })
}
