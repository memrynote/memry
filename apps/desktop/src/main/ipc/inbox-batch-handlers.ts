import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  BulkArchiveSchema,
  BulkFileSchema,
  BulkTagSchema,
  type BulkResponse
} from '@memry/contracts/inbox-api'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq, and } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { bulkFileToFolder } from '../inbox/filing'
import { bulkSnoozeItems } from '../inbox/snooze'
import { getStaleItemIds } from '../inbox/stats'
import type { DrizzleDb } from '../database'

export interface InboxBatchHandlerDeps {
  requireDatabase: () => DrizzleDb
  emitInboxEvent: (channel: string, data: unknown) => void
  archiveItem: (itemId: string) => Promise<{ success: boolean; error?: string }>
}

export interface InboxBatchHandlers {
  handleBulkArchive: (input: unknown) => Promise<BulkResponse>
  handleBulkSnooze: (input: unknown) => Promise<{
    success: boolean
    processedCount: number
    errors: Array<{ itemId: string; error: string }>
  }>
  handleBulkFile: (input: unknown) => Promise<BulkResponse>
  handleBulkTag: (input: unknown) => Promise<BulkResponse>
  handleFileAllStale: () => Promise<BulkResponse>
}

export function createInboxBatchHandlers(deps: InboxBatchHandlerDeps): InboxBatchHandlers {
  async function handleBulkArchive(input: unknown): Promise<BulkResponse> {
    const parsed = BulkArchiveSchema.parse(input)
    const errors: Array<{ itemId: string; error: string }> = []
    let processedCount = 0

    for (const itemId of parsed.itemIds) {
      const result = await deps.archiveItem(itemId)
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

  async function handleBulkSnooze(input: unknown): Promise<{
    success: boolean
    processedCount: number
    errors: Array<{ itemId: string; error: string }>
  }> {
    if (!input || typeof input !== 'object') {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'Invalid input' }]
      }
    }

    const { itemIds, snoozeUntil, reason } = input as {
      itemIds: string[]
      snoozeUntil: string
      reason?: string
    }

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'itemIds array is required' }]
      }
    }

    if (!snoozeUntil) {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'snoozeUntil is required' }]
      }
    }

    return bulkSnoozeItems(itemIds, snoozeUntil, reason)
  }

  async function handleBulkFile(input: unknown): Promise<BulkResponse> {
    const parsed = BulkFileSchema.parse(input)
    const { itemIds, destination, tags } = parsed

    if (destination.type !== 'folder') {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'Bulk filing only supports folder destination' }]
      }
    }

    return bulkFileToFolder(itemIds, destination.path || '', tags)
  }

  async function handleBulkTag(input: unknown): Promise<BulkResponse> {
    const parsed = BulkTagSchema.parse(input)
    const { itemIds, tags } = parsed
    const db = deps.requireDatabase()

    let processedCount = 0
    const errors: Array<{ itemId: string; error: string }> = []

    for (const itemId of itemIds) {
      try {
        const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
        if (!item) {
          errors.push({ itemId, error: 'Item not found' })
          continue
        }

        for (const tag of tags) {
          const normalizedTag = tag.trim().toLowerCase()
          if (!normalizedTag) continue

          const existing = db
            .select()
            .from(inboxItemTags)
            .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, normalizedTag)))
            .get()

          if (!existing) {
            db.insert(inboxItemTags)
              .values({
                id: generateId(),
                itemId,
                tag: normalizedTag
              })
              .run()
          }
        }
        processedCount++
      } catch (error) {
        errors.push({
          itemId,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    for (const itemId of itemIds) {
      deps.emitInboxEvent(InboxChannels.events.UPDATED, { id: itemId, changes: { tags } })
    }

    return {
      success: errors.length === 0,
      processedCount,
      errors
    }
  }

  async function handleFileAllStale(): Promise<BulkResponse> {
    try {
      const staleIds = getStaleItemIds()

      if (staleIds.length === 0) {
        return { success: true, processedCount: 0, errors: [] }
      }

      const result = await bulkFileToFolder(staleIds, 'Unsorted', [])

      return result
    } catch (error) {
      return {
        success: false,
        processedCount: 0,
        errors: [
          { itemId: 'batch', error: error instanceof Error ? error.message : 'Unknown error' }
        ]
      }
    }
  }

  return {
    handleBulkArchive,
    handleBulkSnooze,
    handleBulkFile,
    handleBulkTag,
    handleFileAllStale
  }
}

export function registerInboxBatchHandlers(handlers: InboxBatchHandlers): void {
  ipcMain.handle(InboxChannels.invoke.BULK_SNOOZE, (_, input) => handlers.handleBulkSnooze(input))
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, (_, input) => handlers.handleBulkFile(input))
  ipcMain.handle(InboxChannels.invoke.BULK_ARCHIVE, (_, input) => handlers.handleBulkArchive(input))
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, (_, input) => handlers.handleBulkTag(input))
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, () => handlers.handleFileAllStale())
}

export function unregisterInboxBatchHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.BULK_SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.FILE_ALL_STALE)
}
