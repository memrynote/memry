import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { getCrdtProvider } from './crdt-provider'
import { yDocToMarkdown } from './blocknote-converter'
import {
  atomicWrite,
  safeRead,
  fileExists,
  generateNotePath,
  ensureDirectory
} from '../vault/file-ops'
import { parseNote, serializeNote, type NoteFrontmatter } from '../vault/frontmatter'
import {
  getNotesDir,
  toRelativePath,
  toAbsolutePath,
  maybeCreateSignificantSnapshot
} from '../vault/notes'
import { getJournalPath } from '../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../vault/note-sync'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById } from '@shared/db/queries/notes'
import { deleteFile } from '../vault/file-ops'
import { NotesChannels, JournalChannels } from '@shared/ipc-channels'
import { BrowserWindow } from 'electron'
import path from 'path'
import { queueEmbeddingUpdate } from '../inbox/embedding-queue'

const log = createLogger('CrdtWriteback')

const WRITEBACK_DEBOUNCE_MS = 500
const IGNORED_WRITE_TTL_MS = 5000

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const ignoredWrites = new Map<string, number>()
const lastNetworkUpdateMs = new Map<string, number>()

function isJournalId(noteId: string): boolean {
  return noteId.startsWith('j') && /^j\d{4}-\d{2}-\d{2}$/.test(noteId)
}

function journalIdToDate(journalId: string): string {
  return journalId.slice(1)
}

export function isWritebackIgnored(absolutePath: string): boolean {
  const now = Date.now()
  for (const [p, ts] of ignoredWrites) {
    if (now - ts >= IGNORED_WRITE_TTL_MS) ignoredWrites.delete(p)
  }
  const ts = ignoredWrites.get(absolutePath)
  if (!ts) return false
  return now - ts < IGNORED_WRITE_TTL_MS
}

export function clearWritebackIgnore(_absolutePath: string): void {
  // no-op: auto-evicted by TTL in isWritebackIgnored
}

export function markWritebackIgnored(absolutePath: string): void {
  ignoredWrites.set(absolutePath, Date.now())
}

const CONCURRENT_EDIT_WINDOW_MS = 2000

export function recordNetworkUpdate(noteId: string): void {
  lastNetworkUpdateMs.set(noteId, Date.now())
}

export function wasRecentNetworkUpdate(noteId: string): boolean {
  const ts = lastNetworkUpdateMs.get(noteId)
  if (!ts) return false
  if (Date.now() - ts >= CONCURRENT_EDIT_WINDOW_MS) {
    lastNetworkUpdateMs.delete(noteId)
    return false
  }
  return true
}

function emitToRenderer(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

export function scheduleWriteback(noteId: string, doc: Y.Doc): void {
  const existing = pendingTimers.get(noteId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId)
    performWriteback(noteId, doc).catch((err) => {
      log.error('Write-back failed', { noteId, error: err })
      emitToRenderer('sync:write-back-failed', { noteId })
    })
  }, WRITEBACK_DEBOUNCE_MS)

  pendingTimers.set(noteId, timer)
}

export function cancelPendingWritebacks(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
}

async function performWriteback(noteId: string, doc: Y.Doc): Promise<void> {
  const markdown = await yDocToMarkdown(doc)
  if (markdown === null) {
    log.warn('Conversion returned null, keeping stale file', { noteId })
    return
  }

  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)

  if (isJournalId(noteId)) {
    await writebackJournal(noteId, doc, markdown, cached, indexDb)
  } else if (cached) {
    await writebackExisting(noteId, cached.path, doc, markdown, indexDb)
  } else {
    await writebackNewNote(noteId, doc, markdown, indexDb)
  }
}

async function writebackExisting(
  noteId: string,
  relativePath: string,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const absolutePath = toAbsolutePath(relativePath)

  const existingRaw = await safeRead(absolutePath)
  let existingFrontmatter: NoteFrontmatter | null = null

  if (existingRaw) {
    const parsed = parseNote(existingRaw, absolutePath)
    existingFrontmatter = parsed.frontmatter
    const title = existingFrontmatter?.title || 'Untitled'
    try {
      const snap = maybeCreateSignificantSnapshot(
        noteId,
        existingRaw,
        parsed.content,
        markdown,
        title
      )
      if (snap) log.info('Snapshot created during writeback', { noteId, snapshotId: snap.id })
    } catch (err) {
      log.error('Snapshot creation failed during writeback', { noteId, error: err })
    }
  }

  const mergedFrontmatter = mergeFrontmatter(noteId, existingFrontmatter, doc)
  const fileContent = serializeNote(mergedFrontmatter, markdown)

  ignoredWrites.set(absolutePath, Date.now())
  await atomicWrite(absolutePath, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: relativePath,
      fileContent,
      frontmatter: mergedFrontmatter,
      parsedContent: markdown
    },
    { isNew: false }
  )

  emitToRenderer(NotesChannels.events.UPDATED, { id: noteId, source: 'sync' })
  queueEmbeddingUpdate(noteId)
  log.debug('Write-back complete', { noteId })
}

async function writebackNewNote(
  noteId: string,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const meta = doc.getMap('meta')
  const title = (meta.get('title') as string) || 'Untitled'

  const notesDir = getNotesDir()
  const absolutePath = generateNotePath(notesDir, title)
  const relativePath = toRelativePath(absolutePath)

  const frontmatter = mergeFrontmatter(noteId, null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  ignoredWrites.set(absolutePath, Date.now())
  await atomicWrite(absolutePath, fileContent)

  syncNoteToCache(
    indexDb,
    { id: noteId, path: relativePath, fileContent, frontmatter, parsedContent: markdown },
    { isNew: true }
  )

  queueEmbeddingUpdate(noteId)

  emitToRenderer(NotesChannels.events.CREATED, {
    note: { id: noteId, path: relativePath, title },
    source: 'sync'
  })

  log.info('Created new note from sync', { noteId, title })
}

async function writebackJournal(
  noteId: string,
  doc: Y.Doc,
  markdown: string,
  cached: ReturnType<typeof getNoteCacheById> | undefined,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const date = journalIdToDate(noteId)
  const journalPath = getJournalPath(date)

  await ensureDirectory(path.dirname(journalPath))

  if (cached) {
    const absolutePath = toAbsolutePath(cached.path)
    const existingRaw = await safeRead(absolutePath)
    const existing = existingRaw ? parseNote(existingRaw, absolutePath).frontmatter : null

    if (existing && existing.id !== noteId) {
      await handleJournalCollision(noteId, date, existing.id, doc, markdown, indexDb)
      return
    }

    if (existingRaw) {
      const parsed = parseNote(existingRaw, absolutePath)
      const title = existing?.title || `Journal ${date}`
      try {
        const snap = maybeCreateSignificantSnapshot(
          noteId,
          existingRaw,
          parsed.content,
          markdown,
          title
        )
        if (snap)
          log.info('Journal snapshot created during writeback', { noteId, snapshotId: snap.id })
      } catch (err) {
        log.error('Journal snapshot creation failed during writeback', { noteId, error: err })
      }
    }

    const mergedFrontmatter = mergeJournalFrontmatter(noteId, date, existing, doc)
    const fileContent = serializeNote(mergedFrontmatter, markdown)

    ignoredWrites.set(absolutePath, Date.now())
    await atomicWrite(absolutePath, fileContent)

    syncNoteToCache(
      indexDb,
      {
        id: noteId,
        path: cached.path,
        fileContent,
        frontmatter: mergedFrontmatter,
        parsedContent: markdown
      },
      { isNew: false }
    )

    queueEmbeddingUpdate(noteId)
    log.debug('Journal write-back complete', { noteId, date })
    return
  }

  if (await fileExists(journalPath)) {
    const raw = await safeRead(journalPath)
    if (raw) {
      const parsed = parseNote(raw, journalPath)
      if (parsed.frontmatter.id !== noteId) {
        await handleJournalCollision(noteId, date, parsed.frontmatter.id, doc, markdown, indexDb)
        return
      }
    }
  }

  const relativePath = toRelativePath(journalPath)
  const frontmatter = mergeJournalFrontmatter(noteId, date, null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  ignoredWrites.set(journalPath, Date.now())
  await atomicWrite(journalPath, fileContent)

  syncNoteToCache(
    indexDb,
    { id: noteId, path: relativePath, fileContent, frontmatter, parsedContent: markdown },
    { isNew: true }
  )

  queueEmbeddingUpdate(noteId)

  emitToRenderer(JournalChannels.events.ENTRY_CREATED, {
    date,
    source: 'sync'
  })

  log.info('Created journal from sync', { noteId, date })
}

async function handleJournalCollision(
  incomingId: string,
  date: string,
  existingId: string,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const shortId = incomingId.slice(0, 8)
  const collisionFilename = `${date}-${shortId}.md`
  const journalDir = path.dirname(getJournalPath(date))
  const collisionPath = path.join(journalDir, collisionFilename)
  const relativePath = toRelativePath(collisionPath)

  const frontmatter = mergeJournalFrontmatter(incomingId, date, null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  await ensureDirectory(journalDir)
  ignoredWrites.set(collisionPath, Date.now())
  await atomicWrite(collisionPath, fileContent)

  syncNoteToCache(
    indexDb,
    { id: incomingId, path: relativePath, fileContent, frontmatter, parsedContent: markdown },
    { isNew: true }
  )

  queueEmbeddingUpdate(incomingId)

  emitToRenderer('sync:journal-conflict', {
    date,
    incomingId,
    existingId,
    collisionPath: relativePath
  })

  log.warn('Journal date collision', { date, incomingId, existingId, collisionPath: relativePath })
}

export async function handleSyncDeletion(noteId: string): Promise<void> {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return

  const absolutePath = toAbsolutePath(cached.path)
  deleteNoteFromCache(indexDb, noteId)

  ignoredWrites.set(absolutePath, Date.now())
  await deleteFile(absolutePath).catch((err) => {
    log.error('Failed to delete synced note file', { noteId, error: err })
  })

  getCrdtProvider().close(noteId)

  const channel = isJournalId(noteId)
    ? JournalChannels.events.ENTRY_DELETED
    : NotesChannels.events.DELETED

  emitToRenderer(channel, {
    id: noteId,
    path: cached.path,
    date: isJournalId(noteId) ? journalIdToDate(noteId) : undefined,
    source: 'sync'
  })

  log.info('Deleted from sync', { noteId })
}

function mergeFrontmatter(
  noteId: string,
  existing: NoteFrontmatter | null,
  doc: Y.Doc
): NoteFrontmatter {
  const meta = doc.getMap('meta')
  const yjsTitle = meta.get('title') as string | undefined
  const yjsTags = getYjsTags(doc)

  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  const authorityTitle = cached?.title

  if (!existing) {
    return {
      id: noteId,
      title: authorityTitle || yjsTitle,
      created: (meta.get('date') as string) || new Date().toISOString(),
      modified: new Date().toISOString(),
      tags: yjsTags.length > 0 ? yjsTags : undefined
    }
  }

  return {
    ...existing,
    title: authorityTitle || existing.title || yjsTitle,
    modified: new Date().toISOString(),
    tags: yjsTags.length > 0 ? yjsTags : existing.tags
  }
}

function mergeJournalFrontmatter(
  noteId: string,
  date: string,
  existing: NoteFrontmatter | null,
  doc: Y.Doc
): NoteFrontmatter {
  const yjsTags = getYjsTags(doc)

  if (!existing) {
    return {
      id: noteId,
      date,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      tags: yjsTags.length > 0 ? yjsTags : undefined
    }
  }

  return {
    ...existing,
    date,
    modified: new Date().toISOString(),
    tags: yjsTags.length > 0 ? yjsTags : existing.tags
  }
}

function getYjsTags(doc: Y.Doc): string[] {
  const tagArray = doc.getArray('tags')
  const tags: string[] = []
  for (let i = 0; i < tagArray.length; i++) {
    const val = tagArray.get(i)
    if (typeof val === 'string') tags.push(val)
  }
  return tags
}
