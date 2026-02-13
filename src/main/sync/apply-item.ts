import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@shared/db/schema/data-schema'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import type { VectorClock, SyncItemType } from '@shared/contracts/sync-api'
import type { SettingsSyncPayload } from '@shared/contracts/settings-sync'
import { TasksChannels, InboxChannels, SavedFiltersChannels } from '@shared/ipc-channels'
import { compare, merge } from './vector-clock'
import { getSettingsSyncManager } from './settings-sync'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('ItemApplier')

export interface ApplyItemInput {
  itemId: string
  type: SyncItemType
  operation: 'create' | 'update' | 'delete'
  content: Uint8Array
  clock?: VectorClock
  deletedAt?: number
}

export type EmitToWindows = (channel: string, data: unknown) => void

export class ItemApplier {
  constructor(
    private db: DrizzleDb,
    private emitToWindows: EmitToWindows
  ) {}

  apply(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    switch (input.type) {
      case 'task':
        return this.applyTask(input)
      case 'inbox':
        return this.applyInbox(input)
      case 'filter':
        return this.applyFilter(input)
      case 'settings':
        return this.applySettings(input)
      default:
        log.warn('Unsupported item type for apply', { type: input.type })
        return 'skipped'
    }
  }

  private applyTask(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    if (input.operation === 'delete') {
      return this.applyTaskDelete(input)
    }
    return this.applyTaskUpsert(input)
  }

  private applyTaskDelete(input: ApplyItemInput): 'applied' | 'skipped' {
    const existing = this.db.select().from(tasks).where(eq(tasks.id, input.itemId)).get()
    if (!existing) return 'skipped'

    if (input.clock && existing.clock) {
      const cmp = compare(existing.clock, input.clock)
      if (cmp === 'after' || cmp === 'concurrent') {
        log.info('Skipping remote delete, local has unseen changes', { itemId: input.itemId })
        return 'skipped'
      }
    }

    this.db.delete(tasks).where(eq(tasks.id, input.itemId)).run()
    this.emitToWindows(TasksChannels.events.DELETED, { id: input.itemId })
    return 'applied'
  }

  private applyTaskUpsert(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    const decoded = new TextDecoder().decode(input.content)
    let taskData: Record<string, unknown>
    try {
      taskData = JSON.parse(decoded) as Record<string, unknown>
    } catch {
      log.error('Failed to parse task payload', { itemId: input.itemId })
      return 'skipped'
    }

    const existing = this.db.select().from(tasks).where(eq(tasks.id, input.itemId)).get()
    const remoteClock = input.clock ?? (taskData.clock as VectorClock | undefined) ?? {}
    const now = new Date().toISOString()

    if (existing) {
      const localClock = existing.clock ?? {}
      const cmp = compare(localClock, remoteClock)

      if (cmp === 'after') {
        log.info('Skipping remote update, local is newer', { itemId: input.itemId })
        return 'skipped'
      }

      if (cmp === 'concurrent') {
        log.warn('Concurrent edit detected, using last-write-wins', { itemId: input.itemId })
      }

      const mergedClock = cmp === 'concurrent' ? merge(localClock, remoteClock) : remoteClock

      this.db
        .update(tasks)
        .set({
          title: taskData.title as string,
          description: (taskData.description as string) ?? null,
          projectId: taskData.projectId as string,
          statusId: (taskData.statusId as string) ?? null,
          parentId: (taskData.parentId as string) ?? null,
          priority: (taskData.priority as number) ?? 0,
          position: (taskData.position as number) ?? 0,
          dueDate: (taskData.dueDate as string) ?? null,
          dueTime: (taskData.dueTime as string) ?? null,
          startDate: (taskData.startDate as string) ?? null,
          repeatConfig: taskData.repeatConfig ?? null,
          repeatFrom: (taskData.repeatFrom as string) ?? null,
          sourceNoteId: (taskData.sourceNoteId as string) ?? null,
          completedAt: (taskData.completedAt as string) ?? null,
          archivedAt: (taskData.archivedAt as string) ?? null,
          clock: mergedClock,
          syncedAt: now,
          modifiedAt: (taskData.modifiedAt as string) ?? now
        })
        .where(eq(tasks.id, input.itemId))
        .run()

      const updated = this.db.select().from(tasks).where(eq(tasks.id, input.itemId)).get()
      this.emitToWindows(TasksChannels.events.UPDATED, {
        id: input.itemId,
        task: updated,
        changes: {}
      })

      return cmp === 'concurrent' ? 'conflict' : 'applied'
    }

    this.db
      .insert(tasks)
      .values({
        id: input.itemId,
        title: (taskData.title as string) ?? 'Untitled',
        projectId: taskData.projectId as string,
        statusId: (taskData.statusId as string) ?? null,
        parentId: (taskData.parentId as string) ?? null,
        description: (taskData.description as string) ?? null,
        priority: (taskData.priority as number) ?? 0,
        position: (taskData.position as number) ?? 0,
        dueDate: (taskData.dueDate as string) ?? null,
        dueTime: (taskData.dueTime as string) ?? null,
        startDate: (taskData.startDate as string) ?? null,
        repeatConfig: taskData.repeatConfig ?? null,
        repeatFrom: (taskData.repeatFrom as string) ?? null,
        sourceNoteId: (taskData.sourceNoteId as string) ?? null,
        completedAt: (taskData.completedAt as string) ?? null,
        archivedAt: (taskData.archivedAt as string) ?? null,
        clock: remoteClock,
        syncedAt: now,
        createdAt: (taskData.createdAt as string) ?? now,
        modifiedAt: (taskData.modifiedAt as string) ?? now
      })
      .run()

    const inserted = this.db.select().from(tasks).where(eq(tasks.id, input.itemId)).get()
    this.emitToWindows(TasksChannels.events.CREATED, { task: inserted })

    return 'applied'
  }

  private applyInbox(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    if (input.operation === 'delete') return this.applyInboxDelete(input)
    return this.applyInboxUpsert(input)
  }

  private applyInboxDelete(input: ApplyItemInput): 'applied' | 'skipped' {
    const existing = this.db.select().from(inboxItems).where(eq(inboxItems.id, input.itemId)).get()
    if (!existing) return 'skipped'

    if (input.clock && existing.clock) {
      const cmp = compare(existing.clock, input.clock)
      if (cmp === 'after' || cmp === 'concurrent') {
        log.info('Skipping remote inbox delete, local has unseen changes', {
          itemId: input.itemId
        })
        return 'skipped'
      }
    }

    this.db.delete(inboxItems).where(eq(inboxItems.id, input.itemId)).run()
    this.emitToWindows(InboxChannels.events.ARCHIVED, { id: input.itemId })
    return 'applied'
  }

  private applyInboxUpsert(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    const decoded = new TextDecoder().decode(input.content)
    let data: Record<string, unknown>
    try {
      data = JSON.parse(decoded) as Record<string, unknown>
    } catch {
      log.error('Failed to parse inbox payload', { itemId: input.itemId })
      return 'skipped'
    }

    const existing = this.db.select().from(inboxItems).where(eq(inboxItems.id, input.itemId)).get()
    const remoteClock = input.clock ?? (data.clock as VectorClock | undefined) ?? {}
    const now = new Date().toISOString()

    if (existing) {
      const localClock = existing.clock ?? {}
      const cmp = compare(localClock, remoteClock)

      if (cmp === 'after') {
        log.info('Skipping remote inbox update, local is newer', { itemId: input.itemId })
        return 'skipped'
      }

      if (cmp === 'concurrent') {
        log.warn('Concurrent inbox edit detected, using last-write-wins', {
          itemId: input.itemId
        })
      }

      const mergedClock = cmp === 'concurrent' ? merge(localClock, remoteClock) : remoteClock

      this.db
        .update(inboxItems)
        .set({
          title: (data.title as string) ?? existing.title,
          content: (data.content as string) ?? null,
          type: (data.type as string) ?? existing.type,
          metadata: data.metadata ?? null,
          filedAt: (data.filedAt as string) ?? null,
          filedTo: (data.filedTo as string) ?? null,
          filedAction: (data.filedAction as string) ?? null,
          snoozedUntil: (data.snoozedUntil as string) ?? null,
          snoozeReason: (data.snoozeReason as string) ?? null,
          archivedAt: (data.archivedAt as string) ?? null,
          sourceUrl: (data.sourceUrl as string) ?? null,
          sourceTitle: (data.sourceTitle as string) ?? null,
          clock: mergedClock,
          syncedAt: now,
          modifiedAt: (data.modifiedAt as string) ?? now
        })
        .where(eq(inboxItems.id, input.itemId))
        .run()

      this.emitToWindows(InboxChannels.events.UPDATED, { id: input.itemId })
      return cmp === 'concurrent' ? 'conflict' : 'applied'
    }

    this.db
      .insert(inboxItems)
      .values({
        id: input.itemId,
        title: (data.title as string) ?? 'Untitled',
        type: (data.type as string) ?? 'note',
        content: (data.content as string) ?? null,
        metadata: data.metadata ?? null,
        sourceUrl: (data.sourceUrl as string) ?? null,
        sourceTitle: (data.sourceTitle as string) ?? null,
        clock: remoteClock,
        syncedAt: now,
        createdAt: (data.createdAt as string) ?? now,
        modifiedAt: (data.modifiedAt as string) ?? now
      })
      .run()

    this.emitToWindows(InboxChannels.events.CAPTURED, { id: input.itemId })
    return 'applied'
  }

  private applyFilter(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    if (input.operation === 'delete') return this.applyFilterDelete(input)
    return this.applyFilterUpsert(input)
  }

  private applyFilterDelete(input: ApplyItemInput): 'applied' | 'skipped' {
    const existing = this.db
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.id, input.itemId))
      .get()
    if (!existing) return 'skipped'

    if (input.clock && existing.clock) {
      const cmp = compare(existing.clock, input.clock)
      if (cmp === 'after' || cmp === 'concurrent') {
        log.info('Skipping remote filter delete, local has unseen changes', {
          itemId: input.itemId
        })
        return 'skipped'
      }
    }

    this.db.delete(savedFilters).where(eq(savedFilters.id, input.itemId)).run()
    this.emitToWindows(SavedFiltersChannels.events.DELETED, { id: input.itemId })
    return 'applied'
  }

  private applyFilterUpsert(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    const decoded = new TextDecoder().decode(input.content)
    let data: Record<string, unknown>
    try {
      data = JSON.parse(decoded) as Record<string, unknown>
    } catch {
      log.error('Failed to parse filter payload', { itemId: input.itemId })
      return 'skipped'
    }

    const existing = this.db
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.id, input.itemId))
      .get()
    const remoteClock = input.clock ?? (data.clock as VectorClock | undefined) ?? {}
    const now = new Date().toISOString()

    if (existing) {
      const localClock = existing.clock ?? {}
      const cmp = compare(localClock, remoteClock)

      if (cmp === 'after') {
        log.info('Skipping remote filter update, local is newer', { itemId: input.itemId })
        return 'skipped'
      }

      if (cmp === 'concurrent') {
        log.warn('Concurrent filter edit detected, using last-write-wins', {
          itemId: input.itemId
        })
      }

      const mergedClock = cmp === 'concurrent' ? merge(localClock, remoteClock) : remoteClock

      this.db
        .update(savedFilters)
        .set({
          name: (data.name as string) ?? existing.name,
          config: data.config ?? existing.config,
          position: (data.position as number) ?? existing.position,
          clock: mergedClock,
          syncedAt: now
        })
        .where(eq(savedFilters.id, input.itemId))
        .run()

      this.emitToWindows(SavedFiltersChannels.events.UPDATED, { id: input.itemId })
      return cmp === 'concurrent' ? 'conflict' : 'applied'
    }

    this.db
      .insert(savedFilters)
      .values({
        id: input.itemId,
        name: (data.name as string) ?? 'Untitled Filter',
        config: data.config ?? {},
        position: (data.position as number) ?? 0,
        clock: remoteClock,
        syncedAt: now,
        createdAt: (data.createdAt as string) ?? now
      })
      .run()

    this.emitToWindows(SavedFiltersChannels.events.CREATED, { id: input.itemId })
    return 'applied'
  }

  private applySettings(input: ApplyItemInput): 'applied' | 'skipped' | 'conflict' {
    const manager = getSettingsSyncManager()
    if (!manager) {
      log.warn('SettingsSyncManager not initialized, skipping settings apply')
      return 'skipped'
    }

    const decoded = new TextDecoder().decode(input.content)
    let payload: SettingsSyncPayload
    try {
      payload = JSON.parse(decoded) as Record<string, unknown> as SettingsSyncPayload
    } catch {
      log.error('Failed to parse settings payload', { itemId: input.itemId })
      return 'skipped'
    }

    manager.mergeRemote(payload)
    return 'applied'
  }
}
