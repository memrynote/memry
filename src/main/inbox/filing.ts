/**
 * Inbox Filing Operations
 *
 * Handles filing inbox items to folders, converting to notes,
 * and linking to existing notes.
 *
 * @module inbox/filing
 */

import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { createNote, getNoteById, updateNote, createFolder, getFolders } from '../vault/notes'
import { inboxItems, inboxItemTags, filingHistory } from '@shared/db/schema/inbox'
import { generateId } from '../lib/id'
import { eq } from 'drizzle-orm'
import { InboxChannels } from '@shared/ipc-channels'
import { resolveAttachmentUrl } from './attachments'

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
 * Emit inbox event to all windows
 */
function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Get data database, throwing if not available
 */
function requireDatabase() {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
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
 * Ensure folder exists, create if not
 */
async function ensureFolderExists(folderPath: string): Promise<void> {
  if (!folderPath || folderPath === '' || folderPath === 'root') {
    return // Root folder always exists
  }

  try {
    const existingFolders = await getFolders()
    if (!existingFolders.includes(folderPath)) {
      await createFolder(folderPath)
      console.log(`[Filing] Created folder: ${folderPath}`)
    }
  } catch (error) {
    console.error(`[Filing] Error ensuring folder exists: ${folderPath}`, error)
    throw error
  }
}

/**
 * Generate note title based on inbox item
 */
function generateNoteTitle(item: InboxItemRow): string {
  const now = new Date()

  switch (item.type) {
    case 'link': {
      // Use extracted title or URL domain
      if (item.title && item.title !== item.sourceUrl) {
        return item.title
      }
      // Extract domain from URL
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
      // Use first line of content or default
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

/**
 * Generate note content based on inbox item type
 */
function generateNoteContent(item: InboxItemRow): string {
  const now = new Date()
  const filedDate = formatDateDisplay(now)

  switch (item.type) {
    case 'link': {
      const url = item.sourceUrl || ''
      const description = item.content || ''
      const metadata = item.metadata as Record<string, unknown> | null

      let content = `[Open Original](${url})\n\n`

      if (description) {
        content += `> ${description}\n\n`
      }

      // Add metadata info if available
      if (metadata) {
        if (metadata.author) {
          content += `**Author:** ${metadata.author}\n`
        }
        if (metadata.siteName) {
          content += `**Site:** ${metadata.siteName}\n`
        }
      }

      content += `\n---\n*Filed from Inbox on ${filedDate}*`
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
          content += `\n\n[View Attachment](${attachmentUrl})`
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
async function markItemAsFiled(
  itemId: string,
  filedTo: string,
  filedAction: 'folder' | 'note' | 'linked'
): Promise<void> {
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
async function recordFilingHistory(
  itemType: string,
  itemContent: string | null,
  filedTo: string,
  filedAction: 'folder' | 'note' | 'linked',
  tags: string[]
): Promise<void> {
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
 * File an inbox item to a folder by creating a new note
 *
 * @param itemId - Inbox item ID
 * @param folderPath - Target folder path (relative to vault, empty string for root)
 * @param tags - Additional tags to add to the note
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

    // Ensure folder exists
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
      tags: mergedTags
    })

    // Mark inbox item as filed
    await markItemAsFiled(itemId, note.path, 'folder')

    // Record filing history
    await recordFilingHistory(item.type, item.content, note.path, 'folder', mergedTags)

    return {
      success: true,
      filedTo: note.path,
      noteId: note.id
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Filing] Error filing to folder:', message)
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

    // Generate title with date/time format
    const now = new Date()
    const title = `Inbox Note - ${formatDateTime(now)}`
    const content = generateNoteContent(item)

    // Create note in root folder
    const note = await createNote({
      title,
      content,
      tags: mergedTags
    })

    console.log(`[Filing] Converted to note: ${note.id}`)

    // Mark inbox item as filed
    await markItemAsFiled(itemId, note.path, 'note')

    // Record filing history
    await recordFilingHistory(item.type, item.content, note.path, 'note', mergedTags)

    return {
      success: true,
      filedTo: note.path,
      noteId: note.id
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Filing] Error converting to note:', message)
    return { success: false, filedTo: null, error: message }
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
 * Link an inbox item to multiple existing notes
 * Creates an inbox note and appends wikilinks to "## Inbox Captures" section of all target notes
 *
 * @param itemId - Inbox item ID
 * @param noteIds - Array of target note IDs
 * @param tags - Additional tags to add to the created note
 * @param folderPath - Optional folder path for the created inbox note
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
      tags: mergedTags
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

      console.log(`[Filing] Linked inbox item to note: ${targetNote.id}`)
    }

    // Mark inbox item as filed (linked to first target note for reference)
    await markItemAsFiled(itemId, targetNotes[0].path, 'linked')

    // Record filing history
    await recordFilingHistory(item.type, item.content, targetNotes[0].path, 'linked', mergedTags)

    return { success: true, linkedCount: targetNotes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Filing] Error linking to notes:', message)
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
