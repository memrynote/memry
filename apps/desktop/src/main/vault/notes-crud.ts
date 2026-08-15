/**
 * Note CRUD, listing, folders, tags/links, file import, and small utilities.
 * Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-crud
 */

import path from 'path'
import fs from 'fs/promises'
import { isDeepStrictEqual } from 'util'
import { shell } from 'electron'
import { and, desc, eq } from 'drizzle-orm'
import {
  parseNote,
  serializeNote,
  serializeParsedNote,
  extractInlineTagsFromMarkdown,
  type NoteFrontmatter
} from './frontmatter'
import { syncNoteToCache, deleteNoteFromCache } from './note-sync'
import { reconcileTaskCheckboxesFromMarkdown } from '../tasks/reconcile-markdown-tasks'
import { classifyMarkdownStat, classifyMarkdownContent } from '@memry/shared/markdown-class'
import { hasPendingWriteback } from '../sync/crdt-writeback'
import {
  atomicWrite,
  safeRead,
  deleteFile,
  ensureDirectory,
  listDirectories,
  generateNotePath,
  generateUniquePath
} from './file-ops'
import {
  getNoteCacheById,
  getNoteCacheByPath,
  getNoteTags,
  ensureTagDefinitions,
  getNotePropertiesAsRecord,
  resolveNoteByTitle
} from '@main/database/queries/notes'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import {
  NotesChannels,
  type NoteSizeClass,
  type NoteLargeFileReason
} from '@memry/contracts/notes-api'
import type { FolderInfo } from '@memry/contracts/templates-api'
import { readFolderConfig } from './folders'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import { getFileType, getExtension } from '@memry/shared/file-types'
import { getStatus, getConfig } from './index'
import {
  emitNoteEvent,
  getDefaultNoteDir,
  getVaultRoot,
  toAbsolutePath,
  toRelativePath
} from './notes-io'
import { maybeCreateSignificantSnapshot } from './notes-versions'
import { noteToListItem } from './notes-queries'
import { createRemindersService, type RemindersServiceHooks } from '@memry/app-core/reminders'
import { syncNoteDateReminders, clearNoteDateReminders } from '../notes/note-date-reminders'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

const logger = createLogger('VaultNotesCrud')

// Forwards app-core reminder writes to the sync queue. app-core cannot import
// desktop sync code directly (architecture boundary), so this is injected.
const reminderSyncHooks: RemindersServiceHooks = {
  onMutate: (op, id, snapshot) => {
    if (op === 'create') enqueueLocalSyncCreate('reminder', id)
    else if (op === 'update') enqueueLocalSyncUpdate('reminder', id)
    else enqueueLocalSyncDelete('reminder', id, snapshot)
  }
}

// ============================================================================
// Types
// ============================================================================

export interface Note {
  id: string
  path: string
  title: string
  content: string
  frontmatter: NoteFrontmatter
  created: Date
  modified: Date
  tags: string[]
  aliases: string[]
  wordCount: number
  properties: Record<string, unknown>
  emoji?: string | null
  /** See the same fields on the contracts `Note`, which this shape feeds. */
  sizeClass?: NoteSizeClass
  largeFileReason?: NoteLargeFileReason | null
  contentOmitted?: boolean
}

export interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  wordCount: number
  snippet?: string
  emoji?: string | null
  localOnly?: boolean
  properties?: Record<string, unknown>
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  mimeType?: string | null
  fileSize?: number | null
}

export interface FileMetadata {
  id: string
  path: string
  absolutePath: string
  title: string
  fileType: 'pdf' | 'image' | 'audio' | 'video'
  mimeType: string | null
  fileSize: number | null
  created: Date
  modified: Date
  transcription?: string | null
  transcriptionStatus?: 'pending' | 'processing' | 'complete' | 'failed' | null
}

export interface NoteCreateInput {
  /** Preset note id (importers that save attachments under the id before the
   *  note exists, to avoid a create-then-update round trip). Defaults to a new id. */
  id?: string
  title: string
  content?: string
  folder?: string
  tags?: string[]
  template?: string
  properties?: Record<string, unknown>
  /** ISO timestamps to preserve on import; default to now when omitted. */
  created?: string
  modified?: string
}

export interface NoteUpdateInput {
  id: string
  title?: string
  content?: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
  properties?: Record<string, unknown>
  emoji?: string | null
}

/**
 * Which per-note fields `listNotes` should build. Omit for the full shape —
 * `'tree'` drops what the sidebar never reads (`snippet`, `mimeType`,
 * `fileSize`) so a whole-vault sidebar fetch stops shipping them.
 */
export type NoteListFields = 'full' | 'tree'

export interface NoteListOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title' | 'position'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
  includeProperties?: boolean
  fields?: NoteListFields
}

export interface NoteListResponse {
  notes: NoteListItem[]
  total: number
  hasMore: boolean
}

export interface NoteLink {
  sourceId: string
  targetId: string | null
  targetTitle: string
}

export interface BacklinkContext {
  snippet: string
  linkStart: number
  linkEnd: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  contexts: BacklinkContext[]
  via?: { kind: 'property'; propertyName: string }
}

export interface NoteLinksResponse {
  outgoing: NoteLink[]
  incoming: Backlink[]
}

export interface ImportFilesInput {
  sourcePaths: string[]
  targetFolder?: string
}

export interface ImportedFileInfo {
  destPath: string
  filename: string
  fileType: string
}

export interface ImportFilesResult {
  success: boolean
  imported: number
  failed: number
  errors: string[]
  importedFiles: ImportedFileInfo[]
}

// ============================================================================
// Create
// ============================================================================

export async function createNote(input: NoteCreateInput): Promise<Note> {
  // `input.folder` is vault-relative, so a note created inside a folder lands
  // in that folder. Only an unplaced note falls back to `defaultNoteFolder`.
  const notesDir = input.folder ? getVaultRoot() : getDefaultNoteDir()
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  let templateContent = ''
  let templateTags: string[] = []
  let templateProperties: Record<string, unknown> = {}

  let templateId = input.template
  if (!templateId && input.folder) {
    const { getFolderTemplate } = await import('./folders')
    templateId = (await getFolderTemplate(input.folder)) ?? undefined
  }

  if (templateId) {
    const { getTemplate, applyTemplate } = await import('./templates')
    const template = await getTemplate(templateId)
    if (template) {
      const applied = applyTemplate(template, input.title)
      templateContent = applied.content
      templateTags = applied.tags
      templateProperties = applied.properties
    }
  }

  let filePath = generateNotePath(notesDir, input.title, input.folder)
  filePath = await generateUniquePath(filePath)

  const mergedTags = [...new Set([...templateTags, ...(input.tags ?? [])])]

  const noteId = input.id ?? generateNoteId()
  const now = new Date().toISOString()
  const created = input.created ?? now
  const modified = input.modified ?? now

  // User keys only — no Memry keys in the file; empty frontmatter → no YAML block
  const frontmatter: NoteFrontmatter = {}
  if (mergedTags.length > 0) frontmatter.tags = mergedTags

  const properties = { ...templateProperties, ...(input.properties ?? {}) }
  if (Object.keys(properties).length > 0) {
    ;(frontmatter as NoteFrontmatter & { properties: Record<string, unknown> }).properties =
      properties
  }

  const content = input.content && input.content.trim() ? input.content : templateContent
  const fileContent = serializeNote(frontmatter, content)

  await atomicWrite(filePath, fileContent)

  const relativePath = toRelativePath(filePath)

  const syncResult = syncNoteToCache(
    db,
    {
      id: noteId,
      path: relativePath,
      fileContent,
      frontmatter,
      parsedContent: content,
      title: input.title,
      createdAt: created,
      modifiedAt: modified
    },
    { isNew: true }
  )

  ensureTagDefinitions(dataDb, mergedTags)

  const note: Note = {
    id: noteId,
    path: relativePath,
    title: input.title,
    content,
    frontmatter,
    created: new Date(created),
    modified: new Date(modified),
    tags: mergedTags,
    aliases: frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties,
    emoji: null
  }

  emitNoteEvent(NotesChannels.events.CREATED, {
    note: noteToListItem(note),
    source: 'internal'
  })

  try {
    await syncNoteDateReminders(note.id, content, createRemindersService(dataDb, reminderSyncHooks))
  } catch (err) {
    logger.warn('Failed to sync note_date reminders on create', { noteId: note.id, err })
  }

  if (mergedTags.length > 0) {
    emitNoteEvent('notes:tags-changed', undefined)
  }

  return note
}

// ============================================================================
// Read
// ============================================================================

/**
 * What a large-file-class note reports: identity plus cached metadata, and no
 * body. The editor never mounts for these, so there is nothing to hand it — and
 * for the over-ceiling case the bytes were never read in the first place.
 */
function largeFileNote(
  db: ReturnType<typeof getIndexDatabase>,
  id: string,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>
): Note {
  return {
    id,
    path: cached.path,
    title: cached.title,
    content: '',
    frontmatter: {},
    created: new Date(cached.createdAt),
    modified: new Date(cached.modifiedAt),
    tags: getNoteTags(db, id),
    aliases: [],
    wordCount: cached.wordCount ?? 0,
    properties: getNotePropertiesAsRecord(db, id),
    emoji: cached.emoji ?? null
  }
}

export async function getNoteById(id: string): Promise<Note | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  const absolutePath = toAbsolutePath(cached.path)

  // Classify before reading. A file over the byte ceiling must never become a
  // JS string: V8 caps one at ~512 MB, and well below that a 250 MB read is a
  // main-process allocation and GC pause on its own. `stat` settles those
  // without touching the bytes.
  const stats = await fs.stat(absolutePath).catch(() => null)
  const bySize = stats ? classifyMarkdownStat(stats.size) : null
  if (bySize) {
    logger.info('Note is large-file class by size; body not read', {
      id,
      path: cached.path,
      fileBytes: bySize.fileBytes
    })
    return {
      ...largeFileNote(db, id, cached),
      sizeClass: bySize.sizeClass,
      largeFileReason: bySize.reason,
      contentOmitted: true
    }
  }

  const fileContent = await safeRead(absolutePath)

  // `null` = file truly missing (ENOENT). An empty string is a VALID empty
  // note — since the frontmatter diet (#697) a note with no tags/properties and
  // no body serializes to a 0-byte file, so `!fileContent` would wrongly treat
  // every empty note as missing and blank the editor.
  if (fileContent === null) {
    logger.warn('getNoteById: file missing on disk, returning null (watcher handles cleanup)', {
      id,
      path: cached.path
    })
    // Index/file divergence ("my note is empty") must be countable on dashboards.
    trackMainLog('warn', {
      scope: 'Notes',
      action: 'note_file_missing',
      errorCode: 'NOTE_FILE_MISSING'
    })
    return null
  }

  // Under the byte ceiling the file is cheap to read, so the block bound is
  // measured exactly. This is the case a byte ceiling alone gets wrong: a
  // sub-ceiling log dump is one enormous block and parses quadratically.
  const byContent = classifyMarkdownContent(fileContent)
  if (byContent.sizeClass === 'large-file') {
    logger.info('Note is large-file class by block size; not opening as a note', {
      id,
      path: cached.path,
      fileBytes: byContent.fileBytes,
      largestBlockBytes: byContent.largestBlockBytes
    })
    return {
      ...largeFileNote(db, id, cached),
      sizeClass: byContent.sizeClass,
      largeFileReason: byContent.reason,
      contentOmitted: true
    }
  }

  const parsed = parseNote(fileContent, cached.path)

  // Markdown wins for task checkbox state. The watcher covers edits made while
  // the app is running; this covers the rest — a note edited (or imported)
  // while Memry was closed, which the initial scan deliberately skips.
  //
  // Skipped while a writeback is queued or mid-write: the file is then a stale
  // copy of the live doc, and reconciling from it would revert a task the user
  // just ticked in the app. Fire and forget otherwise — the note must render
  // immediately, and the task events that follow refresh the affected rows.
  if (!hasPendingWriteback(id)) {
    void reconcileTaskCheckboxesFromMarkdown(parsed.content).catch((err) => {
      logger.warn('Failed to reconcile task checkboxes on note open', { id, error: err })
    })
  }

  return {
    id,
    path: cached.path,
    title: cached.title,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(cached.createdAt),
    modified: new Date(cached.modifiedAt),
    tags: getNoteTags(db, id),
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount: cached.wordCount ?? 0,
    properties: getNotePropertiesAsRecord(db, id),
    emoji: cached.emoji ?? null
  }
}

export async function getFileById(id: string): Promise<FileMetadata | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  const fileType = cached.fileType ?? 'markdown'
  if (fileType === 'markdown') {
    return null
  }

  const absolutePath = toAbsolutePath(cached.path)
  try {
    await fs.access(absolutePath)
  } catch {
    deleteNoteFromCache(db, id)
    return null
  }

  const filedVoice =
    fileType === 'audio'
      ? getDatabase()
          .select({
            transcription: inboxItems.transcription,
            transcriptionStatus: inboxItems.transcriptionStatus
          })
          .from(inboxItems)
          .where(and(eq(inboxItems.type, 'voice'), eq(inboxItems.filedTo, cached.path)))
          .orderBy(desc(inboxItems.filedAt))
          .get()
      : null

  return {
    id: cached.id,
    path: cached.path,
    absolutePath,
    title: cached.title,
    fileType: fileType,
    mimeType: cached.mimeType ?? null,
    fileSize: cached.fileSize ?? null,
    created: new Date(cached.createdAt),
    modified: new Date(cached.modifiedAt),
    transcription: filedVoice?.transcription ?? null,
    transcriptionStatus:
      (filedVoice?.transcriptionStatus as FileMetadata['transcriptionStatus'] | undefined) ?? null
  }
}

export async function getNoteByPath(notePath: string): Promise<Note | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheByPath(db, notePath)
  if (cached) {
    return getNoteById(cached.id)
  }

  const absolutePath = toAbsolutePath(notePath)
  const fileContent = await safeRead(absolutePath)

  // `null` = truly missing (ENOENT); an empty string is a valid empty note.
  if (fileContent === null) {
    return null
  }

  const stats = await fs.stat(absolutePath).catch(() => null)
  const parsed = parseNote(fileContent, notePath, stats ?? undefined)

  const syncResult = syncNoteToCache(
    db,
    {
      id: parsed.id,
      path: notePath,
      fileContent,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: parsed.title,
      createdAt: parsed.created,
      modifiedAt: parsed.modified
    },
    { isNew: true }
  )

  return {
    id: parsed.id,
    path: notePath,
    title: parsed.title,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(parsed.created),
    modified: new Date(parsed.modified),
    tags: syncResult.tags,
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties: syncResult.properties,
    emoji: syncResult.emoji
  }
}

// ============================================================================
// Update
// ============================================================================

export async function updateNote(input: NoteUpdateInput): Promise<Note> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  const existing = await getNoteById(input.id)
  if (!existing) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }

  const newTitle = input.title ?? existing.title
  const newContent = input.content ?? existing.content
  let newTags = input.tags ?? existing.tags

  if (input.content !== undefined && input.tags === undefined) {
    const oldInline = new Set(extractInlineTagsFromMarkdown(existing.content))
    const newInline = new Set(extractInlineTagsFromMarkdown(input.content))

    const removedInline = [...oldInline].filter((t) => !newInline.has(t))
    const addedInline = [...newInline].filter((t) => !oldInline.has(t))

    if (removedInline.length > 0 || addedInline.length > 0) {
      newTags = newTags.filter((t) => !removedInline.includes(t))
      for (const tag of addedInline) {
        if (!newTags.includes(tag)) newTags.push(tag)
      }
    }
  }
  const newProperties = input.properties ?? existing.properties
  const newEmoji = input.emoji !== undefined ? input.emoji : existing.emoji

  if (input.content !== undefined && input.content !== existing.content) {
    logger.info('updateNote: content changed, attempting snapshot', { noteId: input.id })
    try {
      const absolutePath = toAbsolutePath(existing.path)
      const currentFileContent = await fs.readFile(absolutePath, 'utf-8')
      const snap = maybeCreateSignificantSnapshot(
        input.id,
        currentFileContent,
        existing.content,
        newContent,
        existing.title
      )
      if (snap) {
        logger.info('updateNote: snapshot created', { noteId: input.id, snapshotId: snap.id })
      } else {
        logger.info('updateNote: snapshot skipped (below threshold)', { noteId: input.id })
      }
    } catch (err) {
      logger.error('Failed to read current file for snapshot:', err)
    }
  } else if (input.content !== undefined) {
    logger.info('updateNote: content unchanged, skipping snapshot', { noteId: input.id })
  }

  // User keys only — Memry state (title, dates, emoji, localOnly) lives in the DBs
  const newFrontmatter: NoteFrontmatter & { properties?: Record<string, unknown> } = {
    ...existing.frontmatter,
    ...input.frontmatter
  }

  if (newTags.length > 0) {
    newFrontmatter.tags = newTags
  } else {
    delete newFrontmatter.tags
  }

  if (Object.keys(newProperties).length > 0) {
    newFrontmatter.properties = newProperties
  } else {
    delete newFrontmatter.properties
  }

  const tagsChanged =
    newTags.length !== existing.tags.length || newTags.some((t) => !existing.tags.includes(t))

  // Honest edit flag: the frontmatter block is re-stringified only when the
  // caller actually changed something that lives in it; otherwise the raw
  // block is re-emitted verbatim (byte preservation).
  const frontmatterEdited =
    tagsChanged ||
    (input.properties !== undefined && !isDeepStrictEqual(input.properties, existing.properties)) ||
    (input.frontmatter !== undefined &&
      !isDeepStrictEqual({ ...existing.frontmatter, ...input.frontmatter }, existing.frontmatter))

  const absolutePath = toAbsolutePath(existing.path)
  const currentRaw = await safeRead(absolutePath)
  let fileContent: string
  if (currentRaw !== null) {
    const parsedCurrent = parseNote(currentRaw, existing.path)
    const nextBody = input.content !== undefined ? newContent : parsedCurrent.content
    fileContent = serializeParsedNote({ ...parsedCurrent, frontmatter: newFrontmatter }, nextBody, {
      frontmatterEdited
    })
  } else {
    fileContent = serializeNote(newFrontmatter, newContent)
  }

  const wrote = currentRaw === null || fileContent !== currentRaw
  if (wrote) {
    await atomicWrite(absolutePath, fileContent)
  }

  // Identical bytes = no watcher echo, no sync item, no mtime bump. Sidecar
  // state (title/emoji) still updates the DBs without touching the file.
  const sidecarChanged = newTitle !== existing.title || newEmoji !== existing.emoji
  const changed = wrote || sidecarChanged

  const cached = getNoteCacheById(db, input.id)
  const newModified = changed
    ? new Date().toISOString()
    : (cached?.modifiedAt ?? existing.modified.toISOString())

  const syncResult = changed
    ? syncNoteToCache(
        db,
        {
          id: input.id,
          path: existing.path,
          fileContent,
          frontmatter: newFrontmatter,
          parsedContent: newContent,
          title: newTitle,
          createdAt: cached?.createdAt ?? existing.created.toISOString(),
          modifiedAt: newModified,
          localOnly: cached?.localOnly ?? false,
          emoji: newEmoji
        },
        { isNew: false, tagsOverride: newTags }
      )
    : null

  if (tagsChanged) {
    ensureTagDefinitions(dataDb, newTags)
  }

  const note: Note = {
    id: input.id,
    path: existing.path,
    title: newTitle,
    content: newContent,
    frontmatter: newFrontmatter,
    created: existing.created,
    modified: new Date(newModified),
    tags: newTags,
    aliases: newFrontmatter.aliases ?? [],
    wordCount: syncResult?.wordCount ?? cached?.wordCount ?? existing.wordCount,
    properties: newProperties,
    emoji: newEmoji
  }

  if (changed) {
    emitNoteEvent(NotesChannels.events.UPDATED, {
      id: input.id,
      changes: {
        title: newTitle,
        content: newContent,
        tags: newTags,
        properties: newProperties,
        emoji: newEmoji
      },
      source: 'internal'
    })
  }

  if (wrote) {
    try {
      await syncNoteDateReminders(
        input.id,
        newContent,
        createRemindersService(dataDb, reminderSyncHooks)
      )
    } catch (err) {
      logger.warn('Failed to sync note_date reminders on update', { noteId: input.id, err })
    }
  }

  if (tagsChanged) {
    emitNoteEvent('notes:tags-changed', undefined)
  }

  return note
}

// ============================================================================
// Delete
// ============================================================================

export async function deleteNote(id: string): Promise<void> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  await deleteFile(absolutePath)

  deleteNoteFromCache(db, id)

  emitNoteEvent(NotesChannels.events.DELETED, {
    id,
    path: cached.path,
    source: 'internal'
  })

  try {
    await clearNoteDateReminders(id, createRemindersService(getDatabase(), reminderSyncHooks))
  } catch (err) {
    logger.warn('Failed to clear note_date reminders on delete', { noteId: id, err })
  }
}

// ============================================================================
// Folders
// ============================================================================

export async function getFolders(): Promise<FolderInfo[]> {
  const notesDir = getVaultRoot()
  const config = getConfig()
  // Hide structural/excluded top-level folders (journal, attachments, node_modules,
  // etc.) from the collection tree; journals live in the Journal view.
  const hiddenRoots = new Set(
    [config.journalFolder, config.attachmentsFolder, ...config.excludePatterns]
      .filter(Boolean)
      .map((p) => p.replace(/\/+$/, '').split('/')[0])
  )
  const paths = (await listDirectories(notesDir, notesDir)).filter(
    (folderPath) => !hiddenRoots.has(folderPath.split('/')[0])
  )
  const db = getDatabase()

  return Promise.all(
    paths.map(async (folderPath) => {
      if (db) {
        const dbRow = db
          .select({ icon: folderConfigs.icon })
          .from(folderConfigs)
          .where(eq(folderConfigs.path, folderPath))
          .get()
        if (dbRow) {
          return { path: folderPath, icon: dbRow.icon ?? null }
        }
      }

      const config = await readFolderConfig(folderPath)
      return { path: folderPath, icon: config?.icon ?? null }
    })
  )
}

export async function createFolder(folderPath: string): Promise<void> {
  const notesDir = getVaultRoot()
  const absolutePath = path.join(notesDir, folderPath)
  await ensureDirectory(absolutePath)
}

export async function renameFolder(oldPath: string, newPath: string): Promise<void> {
  const notesDir = getVaultRoot()
  const oldAbsPath = path.join(notesDir, oldPath)
  const newAbsPath = path.join(notesDir, newPath)

  const { rename } = await import('fs/promises')
  await rename(oldAbsPath, newAbsPath)
}

export async function deleteFolder(folderPath: string): Promise<void> {
  const notesDir = getVaultRoot()
  const absPath = path.join(notesDir, folderPath)

  const { rm } = await import('fs/promises')
  await rm(absPath, { recursive: true, force: true })
}

// ============================================================================
// Utilities
// ============================================================================

export function noteExists(titleOrPath: string): boolean {
  const db = getIndexDatabase()

  if (titleOrPath.endsWith('.md')) {
    const cached = getNoteCacheByPath(db, titleOrPath)
    return cached !== undefined
  }

  const resolved = resolveNoteByTitle(db, titleOrPath)
  return resolved !== undefined
}

export async function openExternal(id: string): Promise<void> {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  await shell.openPath(absolutePath)
}

export function revealInFinder(id: string): void {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  shell.showItemInFolder(absolutePath)
}

// ============================================================================
// File Import
// ============================================================================

export async function importFiles(input: ImportFilesInput): Promise<ImportFilesResult> {
  const { sourcePaths, targetFolder = '' } = input
  const status = getStatus()

  if (!status.isOpen || !status.path) {
    throw new Error('No vault is open')
  }

  const notesPath = path.join(status.path, 'notes', targetFolder)

  await ensureDirectory(notesPath)

  const errors: string[] = []
  const importedFiles: ImportedFileInfo[] = []
  let imported = 0
  let failed = 0

  for (const sourcePath of sourcePaths) {
    try {
      await fs.access(sourcePath)

      const filename = path.basename(sourcePath)

      let destFilename = filename
      let destPath = path.join(notesPath, destFilename)
      let counter = 1

      while (true) {
        try {
          await fs.access(destPath)
          const ext = path.extname(filename)
          const base = path.basename(filename, ext)
          destFilename = `${base} (${counter})${ext}`
          destPath = path.join(notesPath, destFilename)
          counter++
        } catch {
          break
        }
      }

      await fs.copyFile(sourcePath, destPath)
      imported++

      const fileType = getFileType(getExtension(destPath)) ?? 'markdown'
      importedFiles.push({ destPath, filename, fileType })
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Failed to import ${path.basename(sourcePath)}: ${message}`)
      logger.warn('Failed to import file', { sourcePath, error })
    }
  }

  if (failed > 0) {
    trackMainLog('warn', {
      scope: 'Notes',
      action: 'import_files_failed',
      metrics: { itemCount: failed }
    })
  }

  return {
    success: failed === 0,
    imported,
    failed,
    errors,
    importedFiles
  }
}
