/**
 * Inbox Filing Operations
 *
 * Handles filing inbox items to folders, converting to notes,
 * and linking to existing notes.
 *
 * @module inbox/filing
 */

import path from 'path'
import { rename, copyFile, unlink, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getDatabase, requireDatabase, getIndexDatabase } from '../database'
import { createNote, getNoteById, updateNote, createFolder, getFolders } from '../vault/notes'
import { setNoteTags } from '../database/queries/notes'
import { indexBinaryFile } from '../vault/indexer'
import { getFileType } from '@memry/shared/file-types'
import { getStatus } from '../vault/index'
import { inboxItems, inboxItemTags, filingHistory } from '@memry/db-schema/schema/inbox'
import { generateId } from '../lib/id'
import { normalizeRelativePath } from '../lib/paths'
import { eq } from 'drizzle-orm'
import {
  InboxChannels,
  NotesChannels,
  TasksChannels,
  CalendarChannels
} from '@memry/contracts/ipc-channels'
import type { FilingAction } from '@memry/contracts/inbox-api'
import type { NoteListItem } from '@memry/contracts/notes-api'
import { upsertCalendarEvent } from '../calendar/repositories/calendar-events-repository'
import { syncCalendarEventCreate } from '../calendar/runtime-effects'
import { createReminder } from '../lib/reminders'
import { resolveAttachmentUrl, deleteInboxAttachments } from './attachments'
import { extractYouTubeVideoId } from '@memry/shared/youtube'
import { extractDomain } from './metadata-utils'
import { publishInboxUpserted, syncInboxUpdate } from './runtime-effects'
import { syncTaskCreate } from '../tasks/runtime-effects'
import { trackMainError } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'

const log = createLogger('Inbox:Filing')

// ============================================================================
// Helpers
// ============================================================================

export function extractItemProperties(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const properties = (metadata as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return undefined
  return properties as Record<string, unknown>
}

// ============================================================================
// Types
// ============================================================================

export interface FileResponse {
  success: boolean
  filedTo: string | null
  noteId?: string
  error?: string
}

type InboxItemRow = typeof inboxItems.$inferSelect

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get vault path, throwing if not available
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.isOpen || !status.path) {
    throw new Error('No vault is open. Please open a vault first.')
  }
  return status.path
}

/**
 * Check if inbox item type is binary (moves file directly).
 * Binary types: image, voice, pdf, video
 * Text types (everything else): note, clip, link, social, reminder
 */
function isBinaryType(type: string): boolean {
  return ['image', 'voice', 'pdf', 'video'].includes(type)
}

/**
 * Items with no usable text body — they can only become a plain Note, not a
 * task/event/reminder. Distinct from isBinaryType: voice is excluded here
 * because its transcription is the text, while clip (a text type for filing)
 * is included because it has no standalone body worth scheduling.
 */
function isNoteOnlyType(type: string): boolean {
  return ['image', 'pdf', 'video', 'clip'].includes(type)
}

/**
 * Get a unique file path by appending -1, -2, etc. if file exists
 */
function getUniqueFilePath(filePath: string): string {
  if (!existsSync(filePath)) {
    return filePath
  }

  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)

  let counter = 1
  let newPath = filePath

  while (existsSync(newPath)) {
    newPath = path.join(dir, `${base}-${counter}${ext}`)
    counter++
  }

  return newPath
}

/**
 * Emit inbox event to all windows
 */
function emitInboxEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

/**
 * Format date as YYYY-MM-DD HH:mm
 */
function formatDateTime(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format date for display (e.g., "Dec 28, 2025")
 */
function formatDateDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/**
 * Get inbox item by ID
 */
function getInboxItem(db: ReturnType<typeof getDatabase>, itemId: string): InboxItemRow | null {
  return db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get() || null
}

/**
 * Get tags for an inbox item
 */
function getItemTags(db: ReturnType<typeof getDatabase>, itemId: string): string[] {
  const tags = db.select().from(inboxItemTags).where(eq(inboxItemTags.itemId, itemId)).all()
  return tags.map((t) => t.tag)
}

/**
 * Persist tags onto a filed binary (image/PDF/audio/video).
 *
 * Binaries have no frontmatter, so tags can't ride along in file content the way
 * markdown notes do. Instead we eagerly index the moved file to obtain its
 * `note_cache` id (idempotent — the filesystem watcher reuses the same id by
 * path and never touches `note_tags`) and write the tags to the index DB.
 * No-op for unsupported/markdown extensions. See #800.
 */
/**
 * Index a filed binary and hand back the tree entry it produced.
 *
 * The vault watcher cannot cover this: indexing happens before chokidar reports
 * the moved file, so the watcher's add handler finds an existing `note_cache`
 * row and returns early without emitting. Whoever writes the row therefore owns
 * the announcement, exactly as `createNote` does for markdown.
 *
 * Returns null when there is nothing to announce — a file type the tree does not
 * carry, or an index write that failed.
 */
async function indexFiledBinary(
  relativePath: string,
  absolutePath: string,
  tags: string[]
): Promise<NoteListItem | null> {
  const fileType = getFileType(path.extname(absolutePath))
  if (!fileType || fileType === 'markdown') return null

  // Best-effort: the caller has already moved the file and deleted the inbox
  // attachment folder, so a failure here (e.g. index DB unavailable) must not
  // abort filing and leave the inbox item pointing at a now-missing attachment.
  // Log and continue. See #800.
  try {
    const indexDb = getIndexDatabase()
    const noteId = await indexBinaryFile(indexDb, relativePath, absolutePath, fileType)
    if (tags.length > 0) setNoteTags(indexDb, noteId, tags)

    const stats = await stat(absolutePath)
    return {
      id: noteId,
      path: relativePath,
      title: path.basename(absolutePath, path.extname(absolutePath)),
      created: stats.birthtime,
      modified: stats.mtime,
      tags,
      wordCount: 0
    }
  } catch (error) {
    log.warn(
      'Failed to index filed binary (continuing):',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

/**
 * Tell every window a filed binary joined the tree, so the sidebar and folder
 * view update in place instead of waiting for a restart.
 */
function announceFiledBinary(note: NoteListItem | null): void {
  if (!note) return
  broadcastToAllWindows(NotesChannels.events.CREATED, { note, source: 'internal' })
}

/**
 * Ensure folder exists, create if not
 */
async function ensureFolderExists(folderPath: string): Promise<void> {
  if (!folderPath || folderPath === '' || folderPath === 'root') {
    return // Root folder always exists
  }

  try {
    const existingFolders = await getFolders()
    if (!existingFolders.some((f) => f.path === folderPath)) {
      await createFolder(folderPath)
      log.debug(`Created folder: ${folderPath}`)
    }
  } catch (error) {
    log.error(`Error ensuring folder exists: ${folderPath}`, error)
    throw error
  }
}

/**
 * Generate note title based on inbox item
 * Priority: item.title > content-based > default fallback
 */
function generateNoteTitle(item: InboxItemRow): string {
  const now = new Date()

  // Always prioritize the inbox item's title first (this is what's shown in inbox UI)
  if (item.title && item.title.trim().length > 0) {
    // For links, don't use title if it's just the URL
    if (item.type === 'link' && item.title === item.sourceUrl) {
      // Fall through to type-specific handling below
    } else {
      return item.title.trim()
    }
  }

  // Type-specific fallbacks when no meaningful title exists
  switch (item.type) {
    case 'link': {
      // Extract domain from URL as fallback
      try {
        const url = new URL(item.sourceUrl || '')
        return `Link from ${url.hostname}`
      } catch {
        return `Inbox Note - ${formatDateTime(now)}`
      }
    }
    case 'note':
    case 'clip':
    default:
      // Use first line of content as fallback
      if (item.content) {
        const firstLine = item.content.split('\n')[0].trim()
        if (firstLine.length > 0 && firstLine.length <= 100) {
          // Clean up markdown headers
          return firstLine.replace(/^#+\s*/, '')
        }
      }
      return `Inbox Note - ${formatDateTime(now)}`
  }
}

function sanitizeFiledVoiceFilenameBase(title: string): string {
  const sanitized = title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '')
    .slice(0, 200)

  return sanitized.length > 0 ? sanitized : 'Voice memo'
}

function getFiledBinaryFilename(item: InboxItemRow): string {
  const storedFilename = path.basename(item.attachmentPath ?? '')
  if (item.type !== 'voice') {
    return storedFilename
  }

  const extension = path.extname(storedFilename)
  return `${sanitizeFiledVoiceFilenameBase(generateNoteTitle(item))}${extension}`
}

// Inbox screenshot/clip bodies embed images by their vault-relative attachment
// path (e.g. attachments/inbox/<id>/screenshot.png). The note editor only renders
// the memry-file:// protocol, so resolve those paths the same way thumbnails are
// resolved below. http(s) article images are left untouched.
function resolveInlineAttachmentPaths(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\((attachments\/[^)\s]+)\)/g, (match, alt, relPath) => {
    const url = resolveAttachmentUrl(relPath)
    return url ? `![${alt}](${url})` : match
  })
}

/**
 * Generate note content based on inbox item type
 */
export function generateNoteContent(item: InboxItemRow): string {
  const now = new Date()
  const filedDate = formatDateDisplay(now)

  switch (item.type) {
    case 'link': {
      const url = item.sourceUrl || ''
      const description = resolveInlineAttachmentPaths(item.content || '')
      const metadata = item.metadata as Record<string, unknown> | null
      const title = item.title || ''
      const domain = url ? extractDomain(url) : ''
      const isYouTube = !!extractYouTubeVideoId(url)
      const extractionStatus = metadata?.extractionStatus
      const hasArticle = extractionStatus === 'full' || extractionStatus === 'partial'

      let content = ''

      if (isYouTube) {
        content += `![embed](${url})\n\n`
      } else {
        const mentionText = title && title !== url ? `${domain} \u00B7 ${title}` : domain
        content += `[${mentionText}](${url} "mention")\n\n`
      }

      if (hasArticle && description) {
        // Extracted article: use the full readable markdown as the note body.
        // Its author/site/published live in the note frontmatter, so skip the
        // inline meta lines here.
        content += `${description}\n\n`
      } else {
        if (description) {
          content += `> ${description}\n\n`
        }

        if (metadata) {
          const metaLines: string[] = []
          if (metadata.author && typeof metadata.author === 'string') {
            metaLines.push(`**Author:** ${metadata.author}`)
          }
          if (metadata.siteName && typeof metadata.siteName === 'string') {
            metaLines.push(`**Site:** ${metadata.siteName}`)
          }
          if (metadata.publishedDate && typeof metadata.publishedDate === 'string') {
            metaLines.push(`**Published:** ${metadata.publishedDate}`)
          }
          if (metaLines.length > 0) {
            content += metaLines.join('  \n') + '\n'
          }
        }
      }

      content += `\n---\n*Filed from Inbox on ${filedDate}*`
      return content
    }

    case 'social': {
      const socialMeta = item.metadata as Record<string, unknown> | null
      const url = item.sourceUrl || ''
      const fullPostContent =
        (typeof socialMeta?.postContent === 'string' && socialMeta.postContent) ||
        item.content ||
        ''

      let content = `[Open Original](${url})\n\n`

      if (socialMeta?.authorHandle && typeof socialMeta.authorHandle === 'string') {
        content += `**${socialMeta.authorHandle}**`
        if (socialMeta.authorName && typeof socialMeta.authorName === 'string') {
          content += ` (${socialMeta.authorName})`
        }
        content += '\n\n'
      }

      if (fullPostContent) {
        content += `> ${fullPostContent.replace(/\n/g, '\n> ')}\n\n`
      }

      content += `---\n*Filed from Inbox on ${filedDate}*`
      return content
    }

    case 'note':
    case 'clip':
    default: {
      let content = item.content || ''

      // Add source info for clips
      if (item.type === 'clip' && item.sourceUrl) {
        content += `\n\n**Source:** [${item.sourceTitle || item.sourceUrl}](${item.sourceUrl})`
      }

      // Add image reference if available
      if (item.thumbnailPath) {
        const thumbnailUrl = resolveAttachmentUrl(item.thumbnailPath)
        if (thumbnailUrl) {
          content += `\n\n![Thumbnail](${thumbnailUrl})`
        }
      }

      // Add attachment reference if available
      if (item.attachmentPath) {
        const attachmentUrl = resolveAttachmentUrl(item.attachmentPath)
        if (attachmentUrl) {
          // content += `\n\n[View Attachment](${attachmentUrl})`
        }
      }

      content += `\n\n---\n*Filed from Inbox on ${filedDate}*`
      return content
    }
  }
}

/**
 * Generate wikilink reference for inbox capture section
 */
function generateInboxCaptureEntry(item: InboxItemRow, noteTitle: string): string {
  const now = new Date()
  const dateStr = formatDate(now)

  let description = ''
  if (item.type === 'link' && item.sourceUrl) {
    try {
      const url = new URL(item.sourceUrl)
      description = ` - Link from ${url.hostname}`
    } catch {
      description = ' - Link'
    }
  } else if (item.content) {
    const firstLine = item.content.split('\n')[0].trim().substring(0, 50)
    description = firstLine ? ` - ${firstLine}${item.content.length > 50 ? '...' : ''}` : ''
  }

  return `- [[${noteTitle}]]${description} *(${dateStr})*`
}

/**
 * Mark inbox item as filed (update DB, don't delete)
 * Also clears any snooze status since the item is now filed
 */
function markItemAsFiled(itemId: string, filedTo: string, filedAction: FilingAction): void {
  const db = requireDatabase()
  const now = new Date().toISOString()

  db.update(inboxItems)
    .set({
      filedAt: now,
      filedTo,
      filedAction,
      modifiedAt: now,
      // Clear snooze status when filing - allows re-snoozing if item is restored
      snoozedUntil: null,
      snoozeReason: null
    })
    .where(eq(inboxItems.id, itemId))
    .run()

  // Filing must reach the other devices. Without a push the filed state never
  // leaves this device, and a peer that still holds `filedAt: null` pushes that
  // whole row on its next change — which applyUpsert reads as a deliberate
  // unfile and applies here, resurrecting the item the user already filed.
  // Best-effort like convertToTask's enqueue: a sync outage must not fail a
  // filing that already succeeded locally, but it must stay countable.
  try {
    syncInboxUpdate(itemId)
  } catch (error) {
    log.warn('syncInboxUpdate failed; filing persisted locally', error)
    trackMainError('inbox', 'filing_sync_enqueue', error)
    // syncInboxUpdate publishes the projection itself; republish here so a
    // failed enqueue doesn't also leave the local Inbox list stale.
    publishInboxUpserted(itemId)
  }

  // Emit filed event
  emitInboxEvent(InboxChannels.events.FILED, {
    id: itemId,
    filedTo,
    filedAction
  })
}

/**
 * Record filing decision for future AI suggestions
 */
function recordFilingHistory(
  itemType: string,
  itemContent: string | null,
  filedTo: string,
  filedAction: FilingAction,
  tags: string[]
): void {
  const db = requireDatabase()

  db.insert(filingHistory)
    .values({
      id: generateId(),
      itemType,
      itemContent: itemContent?.substring(0, 500) || null,
      filedTo,
      filedAction,
      tags: tags,
      filedAt: new Date().toISOString()
    })
    .run()
}

// ============================================================================
// Main Filing Functions
// ============================================================================

/**
 * File a binary inbox item (image, voice, pdf, video) to a folder.
 * Moves the file directly without creating a markdown wrapper.
 *
 * @param itemId - Inbox item ID
 * @param folderPath - Target folder path (relative to vault, empty string for root)
 */
async function fileBinaryToFolder(
  itemId: string,
  folderPath: string,
  tags: string[] = []
): Promise<FileResponse> {
  try {
    const db = requireDatabase()

    // Get inbox item
    const item = getInboxItem(db, itemId)
    if (!item) {
      return { success: false, filedTo: null, error: 'Inbox item not found' }
    }

    // Check if already filed
    if (item.filedAt) {
      return { success: false, filedTo: null, error: 'Item has already been filed' }
    }

    // Verify attachment exists
    if (!item.attachmentPath) {
      return { success: false, filedTo: null, error: 'No attachment found for this item' }
    }

    // Merge tags (existing inbox tags + new, deduplicated) — same shape as the
    // markdown path so binaries keep their assigned tags after filing.
    const mergedTags = [...new Set([...getItemTags(db, itemId), ...tags, 'inbox'])]

    // Ensure destination folder exists
    await ensureFolderExists(folderPath)

    // Build source and destination paths
    const vaultPath = getVaultPath()
    const sourcePath = path.join(vaultPath, item.attachmentPath)
    const filename = getFiledBinaryFilename(item)

    // folderPath is vault-relative (the folder picker speaks vault paths).
    const destFolder = path.join(vaultPath, folderPath || '')
    const destPath = path.join(destFolder, filename)

    // Handle filename conflicts by appending -1, -2, etc.
    const finalPath = getUniqueFilePath(destPath)

    // Move the file (try rename first, fall back to copy+delete for cross-device)
    try {
      await rename(sourcePath, finalPath)
    } catch (renameError) {
      // Cross-device link error - use copy + delete
      if ((renameError as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(sourcePath, finalPath)
        await unlink(sourcePath)
      } else {
        throw renameError
      }
    }

    // Clean up the inbox attachment folder
    await deleteInboxAttachments(itemId)

    // Calculate relative path from vault root for storage
    const relativePath = normalizeRelativePath(path.relative(vaultPath, finalPath))

    // Index the filed file and announce it, so the tree picks it up live.
    announceFiledBinary(await indexFiledBinary(relativePath, finalPath, mergedTags))

    // Mark inbox item as filed
    markItemAsFiled(itemId, relativePath, 'folder')

    // Record filing history
    recordFilingHistory(item.type, null, relativePath, 'folder', mergedTags)

    log.info(`Filed binary item to: ${relativePath}`)

    return {
      success: true,
      filedTo: relativePath
      // Note: No noteId returned - this isn't a markdown note
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error filing binary to folder:', message)
    trackMainError('inbox', 'file_binary', error)
    return { success: false, filedTo: null, error: message }
  }
}

/**
 * File an inbox item to a folder.
 * Routes to appropriate handler based on item type:
 * - Text types (note, clip): Creates a markdown note
 * - Binary types (image, voice, pdf, video): Moves file directly
 *
 * @param itemId - Inbox item ID
 * @param folderPath - Target folder path (relative to vault, empty string for root)
 * @param tags - Additional tags to add to the note (only for text types)
 */
export async function fileToFolder(
  itemId: string,
  folderPath: string,
  tags: string[] = []
): Promise<FileResponse> {
  try {
    const db = requireDatabase()

    // Get inbox item
    const item = getInboxItem(db, itemId)
    if (!item) {
      return { success: false, filedTo: null, error: 'Inbox item not found' }
    }

    // Check if already filed
    if (item.filedAt) {
      return { success: false, filedTo: null, error: 'Item has already been filed' }
    }

    // Binary types: move file directly (no markdown wrapper), preserving tags
    if (isBinaryType(item.type)) {
      return fileBinaryToFolder(itemId, folderPath, tags)
    }

    // Text + link types: create markdown note
    await ensureFolderExists(folderPath)

    // Get existing tags from inbox item
    const existingTags = getItemTags(db, itemId)

    // Merge tags (existing + new, deduplicated)
    const mergedTags = [...new Set([...existingTags, ...tags, 'inbox'])]

    // Generate note title and content
    const title = generateNoteTitle(item)
    const content = generateNoteContent(item)

    // Create note
    const note = await createNote({
      title,
      content,
      folder: folderPath || undefined,
      tags: mergedTags,
      properties: extractItemProperties(item.metadata)
    })

    // Mark inbox item as filed
    markItemAsFiled(itemId, note.path, 'folder')

    // Record filing history
    recordFilingHistory(item.type, item.content, note.path, 'folder', mergedTags)

    return {
      success: true,
      filedTo: note.path,
      noteId: note.id
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error filing to folder:', message)
    trackMainError('inbox', 'file_folder', error)
    return { success: false, filedTo: null, error: message }
  }
}

/**
 * Convert an inbox item to a standalone note
 * Title format: "Inbox Note - YYYY-MM-DD HH:mm"
 *
 * @param itemId - Inbox item ID
 */
export async function convertToNote(itemId: string): Promise<FileResponse> {
  try {
    const db = requireDatabase()

    // Get inbox item
    const item = getInboxItem(db, itemId)
    if (!item) {
      return { success: false, filedTo: null, error: 'Inbox item not found' }
    }

    // Check if already filed
    if (item.filedAt) {
      return { success: false, filedTo: null, error: 'Item has already been filed' }
    }

    // Get existing tags from inbox item
    const existingTags = getItemTags(db, itemId)

    // Merge tags with 'inbox' tag
    const mergedTags = [...new Set([...existingTags, 'inbox'])]

    // Generate title from item content
    const title = generateNoteTitle(item)
    const content = generateNoteContent(item)

    // Create note in root folder
    const note = await createNote({
      title,
      content,
      tags: mergedTags,
      properties: extractItemProperties(item.metadata)
    })

    log.info(`Converted to note: ${note.id}`)

    // Mark inbox item as filed
    markItemAsFiled(itemId, note.path, 'note')

    // Record filing history
    recordFilingHistory(item.type, item.content, note.path, 'note', mergedTags)

    return {
      success: true,
      filedTo: note.path,
      noteId: note.id
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to note:', message)
    trackMainError('inbox', 'convert_note', error)
    return { success: false, filedTo: null, error: message }
  }
}

/**
 * Convert an inbox item to a task.
 * Creates a task with the item title, content as description,
 * and tags carried over. Marks the inbox item as filed.
 *
 * @param itemId - Inbox item ID
 */
export async function convertToTask(
  itemId: string,
  input?: {
    projectId?: string
    dueDate?: string | null
    dueTime?: string | null
    priority?: number
  }
): Promise<{ success: boolean; taskId: string | null; error?: string }> {
  try {
    const db = requireDatabase()

    const item = getInboxItem(db, itemId)
    if (!item) {
      return { success: false, taskId: null, error: 'Inbox item not found' }
    }

    if (item.filedAt) {
      return { success: false, taskId: null, error: 'Item has already been filed' }
    }

    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, 'inbox'])]

    const title = generateNoteTitle(item)
    const description = item.content || null

    const taskId = generateId()
    const { insertTask, getNextTaskPosition, setTaskTags } =
      await import('../database/queries/tasks')
    const { getInboxProject } = await import('../database/queries/projects')

    const inboxProject = getInboxProject(db)
    const projectId = input?.projectId ?? inboxProject?.id
    if (!projectId) {
      return { success: false, taskId: null, error: 'No inbox project found' }
    }

    const position = getNextTaskPosition(db, projectId, null)
    const task = insertTask(db, {
      id: taskId,
      projectId,
      statusId: null,
      parentId: null,
      title,
      description,
      priority: input?.priority ?? 0,
      position,
      dueDate: input?.dueDate ?? null,
      dueTime: input?.dueTime ?? null,
      startDate: null,
      repeatConfig: null,
      repeatFrom: null,
      sourceNoteId: null
    })

    if (mergedTags.length > 0) {
      setTaskTags(db, taskId, mergedTags)
    }

    log.info(`Converted to task: ${taskId}`)

    markItemAsFiled(itemId, taskId, 'task')
    recordFilingHistory(item.type, item.content, taskId, 'task', mergedTags)

    const enrichedTask = { ...task, linkedNoteIds: [] as string[] }
    broadcastToAllWindows(TasksChannels.events.CREATED, { task: enrichedTask })

    try {
      syncTaskCreate(taskId)
    } catch (error) {
      log.warn('syncTaskCreate failed; task persisted locally', error)
      trackMainError('inbox', 'task_conversion_sync_enqueue', error)
    }

    // Tasks born here bypass the tasks domain publisher (direct insertTask),
    // so the publisher's task_created never fires for this path.
    trackMainEvent('task_created', {
      surface: 'inbox',
      action: 'created',
      objectType: 'task',
      source: 'inbox_conversion',
      result: 'success'
    })

    return { success: true, taskId }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to task:', message)
    trackMainError('inbox', 'convert_task', error)
    return { success: false, taskId: null, error: message }
  }
}

/**
 * Convert an inbox item to a calendar event.
 * Reuses the existing calendar_events create path (upsert + sync + emit),
 * carries the item title/body, and marks the inbox item as filed.
 *
 * @param itemId - Inbox item ID
 * @param input - Event timing/location
 */
export async function convertToEvent(
  itemId: string,
  input: { startAt: string; endAt?: string | null; isAllDay?: boolean; location?: string | null }
): Promise<{ success: boolean; eventId: string | null; error?: string }> {
  try {
    const db = requireDatabase()
    const item = getInboxItem(db, itemId)
    if (!item) return { success: false, eventId: null, error: 'Inbox item not found' }
    if (item.filedAt) {
      return { success: false, eventId: null, error: 'Item has already been filed' }
    }
    if (isNoteOnlyType(item.type)) {
      return {
        success: false,
        eventId: null,
        error: 'Only text and voice items can become an event'
      }
    }

    const content = item.type === 'voice' ? item.transcription : item.content
    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, 'inbox'])]

    const id = generateId()
    const now = new Date().toISOString()
    upsertCalendarEvent(db, {
      id,
      title: generateNoteTitle(item),
      description: content ?? null,
      location: input.location ?? null,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      timezone: 'UTC',
      isAllDay: input.isAllDay ?? false,
      createdAt: now,
      modifiedAt: now
    })

    try {
      syncCalendarEventCreate(id)
    } catch (error) {
      log.warn('syncCalendarEventCreate failed; event persisted locally', error)
      // The event exists locally but never enqueues for sync — a silent
      // device-divergence failure, so it must be countable.
      trackMainError('inbox', 'convert_event_sync_enqueue', error)
    }
    broadcastToAllWindows(CalendarChannels.events.CHANGED, { entityType: 'calendar_event', id })

    markItemAsFiled(itemId, id, 'event')
    recordFilingHistory(item.type, item.content, id, 'event', mergedTags)
    log.info(`Converted to event: ${id}`)

    // Bypasses CREATE_EVENT (direct upsert), so calendar_event_created never
    // fires otherwise — same pattern as promote-external-event.ts.
    trackMainEvent('calendar_event_created', {
      surface: 'calendar',
      action: 'created',
      source: 'inbox_conversion',
      result: 'success'
    })

    return { success: true, eventId: id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to event:', message)
    trackMainError('inbox', 'convert_event', error)
    return { success: false, eventId: null, error: message }
  }
}

/**
 * Convert an inbox item to a reminder.
 * Creates a standalone note (reminders need a target) and schedules a
 * note-target reminder via the existing reminders service.
 *
 * @param itemId - Inbox item ID
 * @param input - Reminder timing (must be in the future)
 */
export async function convertToReminder(
  itemId: string,
  input: { remindAt: string }
): Promise<{ success: boolean; noteId: string | null; error?: string }> {
  try {
    const db = requireDatabase()
    const item = getInboxItem(db, itemId)
    if (!item) return { success: false, noteId: null, error: 'Inbox item not found' }
    if (item.filedAt) {
      return { success: false, noteId: null, error: 'Item has already been filed' }
    }
    if (isNoteOnlyType(item.type)) {
      return {
        success: false,
        noteId: null,
        error: 'Only text and voice items can become a reminder'
      }
    }
    if (new Date(input.remindAt).getTime() <= Date.now()) {
      return { success: false, noteId: null, error: 'Reminder time must be in the future' }
    }

    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, 'inbox'])]
    const title = generateNoteTitle(item)
    const note = await createNote({
      title,
      content: generateNoteContent(item),
      tags: mergedTags,
      properties: extractItemProperties(item.metadata)
    })

    createReminder({ targetType: 'note', targetId: note.id, remindAt: input.remindAt, title })

    markItemAsFiled(itemId, note.path, 'reminder')
    recordFilingHistory(item.type, item.content, note.path, 'reminder', mergedTags)
    log.info(`Converted to reminder: note ${note.id}`)
    return { success: true, noteId: note.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to reminder:', message)
    trackMainError('inbox', 'convert_reminder', error)
    return { success: false, noteId: null, error: message }
  }
}

/**
 * Link an inbox item to an existing note
 * Appends content to "## Inbox Captures" section with wikilinks
 *
 * @param itemId - Inbox item ID
 * @param noteId - Target note ID
 * @param tags - Additional tags to add to the created note
 * @param folderPath - Optional folder path for the created inbox note
 */
export async function linkToNote(
  itemId: string,
  noteId: string,
  tags: string[] = [],
  folderPath?: string
): Promise<{ success: boolean; error?: string }> {
  // Delegate to linkToNotes with single note
  return linkToNotes(itemId, [noteId], tags, folderPath)
}

/**
 * Link a binary file to existing notes.
 * Moves file to folder and adds wiki-link references to target notes.
 *
 * @param itemId - Inbox item ID
 * @param item - Inbox item row
 * @param noteIds - Array of target note IDs
 * @param folderPath - Optional folder path for the file
 */
async function linkBinaryToNotes(
  itemId: string,
  item: InboxItemRow,
  noteIds: string[],
  tags: string[] = [],
  folderPath?: string
): Promise<{ success: boolean; error?: string; linkedCount?: number }> {
  try {
    // Verify attachment exists
    if (!item.attachmentPath) {
      return { success: false, error: 'No attachment found for this item' }
    }

    // Merge tags (existing inbox tags + new, deduplicated) — mirror the
    // markdown link path so linked binaries keep their assigned tags. See #800.
    const db = requireDatabase()
    const mergedTags = [...new Set([...getItemTags(db, itemId), ...tags, 'inbox'])]

    // Validate all target notes exist first
    const targetNotes: Array<{ id: string; content: string; path: string }> = []
    for (const noteId of noteIds) {
      const targetNote = await getNoteById(noteId)
      if (!targetNote) {
        return { success: false, error: `Target note not found: ${noteId}` }
      }
      targetNotes.push({ id: noteId, content: targetNote.content, path: targetNote.path })
    }

    // Determine destination folder:
    // 1. Use provided folderPath
    // 2. Or same folder as first target note
    // 3. Or root notes folder
    let destFolder: string
    if (folderPath) {
      await ensureFolderExists(folderPath)
      destFolder = folderPath
    } else if (targetNotes[0].path.includes('/')) {
      // Extract folder from first target note's path
      destFolder = path.dirname(targetNotes[0].path)
    } else {
      destFolder = '' // Root folder
    }

    // Build source and destination paths
    const vaultPath = getVaultPath()
    const sourcePath = path.join(vaultPath, item.attachmentPath)
    const filename = getFiledBinaryFilename(item)

    // destFolder is vault-relative (derived from an existing note's path).
    const destFolderPath = path.join(vaultPath, destFolder)
    const destPath = path.join(destFolderPath, filename)

    // Handle filename conflicts
    const finalPath = getUniqueFilePath(destPath)

    // Move the file (try rename first, fall back to copy+delete for cross-device)
    try {
      await rename(sourcePath, finalPath)
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(sourcePath, finalPath)
        await unlink(sourcePath)
      } else {
        throw renameError
      }
    }

    // Clean up the inbox attachment folder
    await deleteInboxAttachments(itemId)

    // Generate wiki-link entry
    // Use title (filename without extension) for wiki-link because that's how
    // files are indexed in the database (watcher sets title = basename without ext)
    const fileTitle = path.basename(finalPath, path.extname(finalPath))
    // Use ![[]] for images to embed them inline, [[]] for other files
    const isImage = item.type === 'image'
    const wikiLink = isImage ? `[[${fileTitle}]]` : `[[${fileTitle}]]`
    const dateStr = formatDate(new Date())
    const captureEntry = `- ${wikiLink} *(${dateStr})*`

    const inboxCapturesRegex = /^## Inbox Captures$/m

    // Add wiki-link to ALL target notes
    for (const targetNote of targetNotes) {
      let updatedContent = targetNote.content

      if (inboxCapturesRegex.test(updatedContent)) {
        // Append to existing section
        updatedContent = updatedContent.replace(/^(## Inbox Captures)$/m, `$1\n${captureEntry}`)
      } else {
        // Add new section at the end
        updatedContent = `${updatedContent.trimEnd()}\n\n## Inbox Captures\n\n${captureEntry}`
      }

      // Update target note
      await updateNote({
        id: targetNote.id,
        content: updatedContent
      })

      log.debug(`Linked binary item to note: ${targetNote.id}`)
    }

    // Calculate relative path for storage
    const relativePath = normalizeRelativePath(path.relative(vaultPath, finalPath))

    // Index the filed file and announce it, so the tree picks it up live.
    announceFiledBinary(await indexFiledBinary(relativePath, finalPath, mergedTags))

    // Mark inbox item as filed
    markItemAsFiled(itemId, relativePath, 'linked')

    // Record filing history
    recordFilingHistory(item.type, null, relativePath, 'linked', mergedTags)

    log.info(`Linked binary item to ${targetNotes.length} note(s): ${relativePath}`)

    return { success: true, linkedCount: targetNotes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error linking binary to notes:', message)
    trackMainError('inbox', 'link_binary', error)
    return { success: false, error: message }
  }
}

/**
 * Link an inbox item to multiple existing notes.
 * Routes to appropriate handler based on item type:
 * - Text types (note, clip): Creates markdown note and adds wikilinks
 * - Binary types (image, voice, pdf, video): Moves file and adds wikilinks
 *
 * @param itemId - Inbox item ID
 * @param noteIds - Array of target note IDs
 * @param tags - Additional tags to add to the created note (only for text types)
 * @param folderPath - Optional folder path for the created note/file
 */
export async function linkToNotes(
  itemId: string,
  noteIds: string[],
  tags: string[] = [],
  folderPath?: string
): Promise<{ success: boolean; error?: string; linkedCount?: number }> {
  try {
    const db = requireDatabase()

    if (!noteIds || noteIds.length === 0) {
      return { success: false, error: 'At least one note ID is required' }
    }

    // Get inbox item
    const item = getInboxItem(db, itemId)
    if (!item) {
      return { success: false, error: 'Inbox item not found' }
    }

    // Check if already filed
    if (item.filedAt) {
      return { success: false, error: 'Item has already been filed' }
    }

    // Binary types: move file and add wiki-links to target notes
    if (isBinaryType(item.type)) {
      return linkBinaryToNotes(itemId, item, noteIds, tags, folderPath)
    }

    // Text types: create markdown note and add wiki-links (existing logic)
    // Ensure folder exists if specified
    if (folderPath) {
      await ensureFolderExists(folderPath)
    }

    // Validate all target notes exist first
    const targetNotes: Array<{ id: string; content: string; path: string }> = []
    for (const noteId of noteIds) {
      const targetNote = await getNoteById(noteId)
      if (!targetNote) {
        return { success: false, error: `Target note not found: ${noteId}` }
      }
      targetNotes.push({ id: noteId, content: targetNote.content, path: targetNote.path })
    }

    // Create a new note from the inbox item (so we can wikilink to it)
    // Merge existing tags + new tags + 'inbox' tag
    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, ...tags, 'inbox'])]

    const inboxNoteTitle = generateNoteTitle(item)
    const inboxNoteContent = generateNoteContent(item)

    // Create the inbox note in the specified folder (we need this so the wikilink has a target)
    await createNote({
      title: inboxNoteTitle,
      content: inboxNoteContent,
      folder: folderPath || undefined,
      tags: mergedTags,
      properties: extractItemProperties(item.metadata)
    })

    // Generate the wikilink entry
    const captureEntry = generateInboxCaptureEntry(item, inboxNoteTitle)
    const inboxCapturesRegex = /^## Inbox Captures$/m

    // Add wikilink to ALL target notes
    for (const targetNote of targetNotes) {
      let updatedContent = targetNote.content

      if (inboxCapturesRegex.test(updatedContent)) {
        // Append to existing section
        updatedContent = updatedContent.replace(/^(## Inbox Captures)$/m, `$1\n${captureEntry}`)
      } else {
        // Add new section at the end
        updatedContent = `${updatedContent.trimEnd()}\n\n## Inbox Captures\n\n${captureEntry}`
      }

      // Update target note
      await updateNote({
        id: targetNote.id,
        content: updatedContent
      })

      log.debug(`Linked inbox item to note: ${targetNote.id}`)
    }

    // Mark inbox item as filed (linked to first target note for reference)
    markItemAsFiled(itemId, targetNotes[0].path, 'linked')

    // Record filing history
    recordFilingHistory(item.type, item.content, targetNotes[0].path, 'linked', mergedTags)

    return { success: true, linkedCount: targetNotes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error linking to notes:', message)
    trackMainError('inbox', 'link_notes', error)
    return { success: false, error: message }
  }
}

/**
 * Bulk file multiple items to a folder
 *
 * @param itemIds - Array of inbox item IDs
 * @param folderPath - Target folder path
 * @param tags - Additional tags to add
 */
export async function bulkFileToFolder(
  itemIds: string[],
  folderPath: string,
  tags: string[] = []
): Promise<{
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}> {
  const errors: Array<{ itemId: string; error: string }> = []
  let processedCount = 0

  for (const itemId of itemIds) {
    const result = await fileToFolder(itemId, folderPath, tags)
    if (result.success) {
      processedCount++
    } else {
      errors.push({ itemId, error: result.error || 'Unknown error' })
    }
  }

  return {
    success: errors.length === 0,
    processedCount,
    errors
  }
}
