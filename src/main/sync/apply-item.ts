import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@shared/db/schema/data-schema'
import { tasks } from '@shared/db/schema/tasks'
import type { VectorClock, SyncItemType } from '@shared/contracts/sync-api'
import { TasksChannels } from '@shared/ipc-channels'
import { compare, merge } from './vector-clock'
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
      const cmp = compare(existing.clock as VectorClock, input.clock)
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
      taskData = JSON.parse(decoded)
    } catch {
      log.error('Failed to parse task payload', { itemId: input.itemId })
      return 'skipped'
    }

    const existing = this.db.select().from(tasks).where(eq(tasks.id, input.itemId)).get()
    const remoteClock = input.clock ?? (taskData.clock as VectorClock | undefined) ?? {}
    const now = new Date().toISOString()

    if (existing) {
      const localClock = (existing.clock as VectorClock) ?? {}
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
}
