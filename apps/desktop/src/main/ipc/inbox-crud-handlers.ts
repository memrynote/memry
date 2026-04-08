import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { InboxUpdateSchema, type CaptureResponse, type InboxItem } from '@memry/contracts/inbox-api'
import { withErrorHandler } from './validate'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq, and } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { deleteInboxAttachments } from '../inbox/attachments'
import { getInboxSyncService } from '../sync/inbox-sync'
import type { DrizzleDb } from '../database'
import { publishProjectionEvent } from '../projections'

type InboxCrudLogger = {
  info: (message: string) => void
  error: (...args: unknown[]) => void
}

export interface InboxCrudHandlerDeps {
  requireDatabase: () => DrizzleDb
  getItemTags: (db: DrizzleDb, itemId: string) => string[]
  toInboxItem: (row: typeof inboxItems.$inferSelect, tags: string[]) => InboxItem
  emitInboxEvent: (channel: string, data: unknown) => void
  syncInboxUpdate: (db: DrizzleDb, itemId: string) => void
  logger: InboxCrudLogger
}

export interface InboxCrudHandlers {
  handleGet: (id: string) => Promise<InboxItem | null>
  handleUpdate: (input: unknown) => Promise<CaptureResponse>
  handleArchive: (id: string) => Promise<{ success: boolean; error?: string }>
  handleAddTag: (itemId: string, tag: string) => Promise<{ success: boolean; error?: string }>
  handleRemoveTag: (itemId: string, tag: string) => Promise<{ success: boolean; error?: string }>
  handleMarkViewed: (itemId: string) => Promise<{ success: boolean; error?: string }>
  handleUnarchive: (id: string) => Promise<{ success: boolean; error?: string }>
  handleDeletePermanent: (id: string) => Promise<{ success: boolean; error?: string }>
  handleUndoFile: (id: string) => Promise<{ success: boolean; error?: string }>
  handleUndoArchive: (id: string) => Promise<{ success: boolean; error?: string }>
}

export function createInboxCrudHandlers(deps: InboxCrudHandlerDeps): InboxCrudHandlers {
  async function handleGet(id: string): Promise<InboxItem | null> {
    const db = deps.requireDatabase()
    const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()

    if (!row) return null

    const tags = deps.getItemTags(db, id)
    return deps.toInboxItem(row, tags)
  }

  async function handleUpdate(input: unknown): Promise<CaptureResponse> {
    try {
      const parsed = InboxUpdateSchema.parse(input)
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, parsed.id)).get()
      if (!existing) {
        return { success: false, item: null, error: 'Item not found' }
      }

      const updates: Partial<typeof inboxItems.$inferInsert> = {
        modifiedAt: new Date().toISOString()
      }

      if (parsed.title !== undefined) updates.title = parsed.title
      if (parsed.content !== undefined) updates.content = parsed.content

      db.update(inboxItems).set(updates).where(eq(inboxItems.id, parsed.id)).run()

      const updated = db.select().from(inboxItems).where(eq(inboxItems.id, parsed.id)).get()
      if (!updated) {
        return { success: false, item: null, error: 'Failed to update item' }
      }

      const tags = deps.getItemTags(db, parsed.id)
      const item = deps.toInboxItem(updated, tags)

      deps.emitInboxEvent(InboxChannels.events.UPDATED, { id: parsed.id, changes: updates })
      deps.syncInboxUpdate(db, parsed.id)

      return { success: true, item }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, item: null, error: message }
    }
  }

  const handleArchive = withErrorHandler(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      db.update(inboxItems)
        .set({ archivedAt: new Date().toISOString() })
        .where(eq(inboxItems.id, id))
        .run()

      deps.emitInboxEvent(InboxChannels.events.ARCHIVED, { id })
      deps.syncInboxUpdate(db, id)

      return { success: true }
    },
    'Unknown error'
  )

  const handleAddTag = withErrorHandler(
    async (itemId: string, tag: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      const existingTag = db
        .select()
        .from(inboxItemTags)
        .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, tag)))
        .get()

      if (existingTag) {
        return { success: true }
      }

      db.insert(inboxItemTags)
        .values({
          id: generateId(),
          itemId,
          tag,
          createdAt: new Date().toISOString()
        })
        .run()

      return { success: true }
    },
    'Unknown error'
  )

  const handleRemoveTag = withErrorHandler(
    async (itemId: string, tag: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      db.delete(inboxItemTags)
        .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, tag)))
        .run()

      return { success: true }
    },
    'Unknown error'
  )

  const handleMarkViewed = withErrorHandler(
    async (itemId: string): Promise<{ success: boolean; error?: string }> => {
      if (!itemId) {
        return { success: false, error: 'itemId is required' }
      }

      const db = deps.requireDatabase()
      const now = new Date().toISOString()

      db.update(inboxItems)
        .set({
          viewedAt: now,
          modifiedAt: now
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      deps.emitInboxEvent(InboxChannels.events.UPDATED, {
        id: itemId,
        changes: { viewedAt: now }
      })
      deps.syncInboxUpdate(db, itemId)

      deps.logger.info(`Marked item ${itemId} as viewed`)
      return { success: true }
    },
    'Unknown error'
  )

  const handleUnarchive = withErrorHandler(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      if (!existing.archivedAt) {
        return { success: false, error: 'Item is not archived' }
      }

      db.update(inboxItems)
        .set({
          archivedAt: null,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, id))
        .run()

      deps.emitInboxEvent(InboxChannels.events.UPDATED, { id, changes: { archivedAt: null } })
      deps.syncInboxUpdate(db, id)

      return { success: true }
    },
    'Unknown error'
  )

  const handleDeletePermanent = withErrorHandler(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      await deleteInboxAttachments(id)

      db.delete(inboxItemTags).where(eq(inboxItemTags.itemId, id)).run()

      const snapshot = JSON.stringify(existing)
      db.delete(inboxItems).where(eq(inboxItems.id, id)).run()
      getInboxSyncService()?.enqueueDelete(id, snapshot)
      publishProjectionEvent({ type: 'inbox.deleted', itemId: id })

      return { success: true }
    },
    'Unknown error'
  )

  const handleUndoFile = withErrorHandler(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      if (!existing.filedAt) {
        return { success: false, error: 'Item is not filed' }
      }

      db.update(inboxItems)
        .set({
          filedAt: null,
          filedTo: null,
          filedAction: null,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, id))
        .run()

      deps.emitInboxEvent(InboxChannels.events.UPDATED, {
        id,
        changes: { filedAt: null, filedTo: null, filedAction: null }
      })
      deps.syncInboxUpdate(db, id)

      deps.logger.info(`Undo file for item ${id}`)
      return { success: true }
    },
    'Unknown error'
  )

  const handleUndoArchive = withErrorHandler(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const db = deps.requireDatabase()

      const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      if (!existing) {
        return { success: false, error: 'Item not found' }
      }

      if (!existing.archivedAt) {
        return { success: false, error: 'Item is not archived' }
      }

      db.update(inboxItems)
        .set({
          archivedAt: null,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, id))
        .run()

      deps.emitInboxEvent(InboxChannels.events.UPDATED, { id, changes: { archivedAt: null } })
      deps.syncInboxUpdate(db, id)

      deps.logger.info(`Undo archive for item ${id}`)
      return { success: true }
    },
    'Unknown error'
  )

  return {
    handleGet,
    handleUpdate,
    handleArchive,
    handleAddTag,
    handleRemoveTag,
    handleMarkViewed,
    handleUnarchive,
    handleDeletePermanent,
    handleUndoFile,
    handleUndoArchive
  }
}

export function registerInboxCrudHandlers(handlers: InboxCrudHandlers): void {
  ipcMain.handle(InboxChannels.invoke.GET, (_, id) => handlers.handleGet(id))
  ipcMain.handle(InboxChannels.invoke.UPDATE, (_, input) => handlers.handleUpdate(input))
  ipcMain.handle(InboxChannels.invoke.ARCHIVE, (_, id) => handlers.handleArchive(id))
  ipcMain.handle(InboxChannels.invoke.ADD_TAG, (_, itemId, tag) =>
    handlers.handleAddTag(itemId, tag)
  )
  ipcMain.handle(InboxChannels.invoke.REMOVE_TAG, (_, itemId, tag) =>
    handlers.handleRemoveTag(itemId, tag)
  )
  ipcMain.handle(InboxChannels.invoke.MARK_VIEWED, (_, itemId) => handlers.handleMarkViewed(itemId))
  ipcMain.handle(InboxChannels.invoke.UNARCHIVE, (_, id) => handlers.handleUnarchive(id))
  ipcMain.handle(InboxChannels.invoke.DELETE_PERMANENT, (_, id) =>
    handlers.handleDeletePermanent(id)
  )
  ipcMain.handle(InboxChannels.invoke.UNDO_FILE, (_, id) => handlers.handleUndoFile(id))
  ipcMain.handle(InboxChannels.invoke.UNDO_ARCHIVE, (_, id) => handlers.handleUndoArchive(id))
}

export function unregisterInboxCrudHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.GET)
  ipcMain.removeHandler(InboxChannels.invoke.UPDATE)
  ipcMain.removeHandler(InboxChannels.invoke.ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.ADD_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.REMOVE_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.MARK_VIEWED)
  ipcMain.removeHandler(InboxChannels.invoke.UNARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.DELETE_PERMANENT)
  ipcMain.removeHandler(InboxChannels.invoke.UNDO_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.UNDO_ARCHIVE)
}
