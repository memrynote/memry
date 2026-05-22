import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  type Comment,
  type CommentStatus,
  type CommentTargetType,
  type CreateCommentInput,
  type ListCommentsInput,
  type UpdateCommentInput
} from '@memry/contracts/comments-api'
import { comments, type CommentRow } from '@memry/db-schema/schema/comments'
import type { VectorClock } from '@memry/contracts/sync-api'
import { getDatabase, type DataDb } from '../database'
import { generateId } from '../lib/id'

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    targetType: row.targetType as CommentTargetType,
    targetId: row.targetId,
    selectedQuote: row.selectedQuote,
    blockId: row.blockId,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    prefix: row.prefix,
    suffix: row.suffix,
    body: row.body,
    mentionRefs: row.mentionRefs ?? [],
    attachmentRefs: row.attachmentRefs ?? [],
    status: row.status as CommentStatus,
    clock: (row.clock as VectorClock | null | undefined) ?? null,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function getStatusList(status: ListCommentsInput['status']): CommentStatus[] | null {
  if (!status) return null
  return Array.isArray(status) ? status : [status]
}

export function listComments(input: ListCommentsInput, db: DataDb = getDatabase()): Comment[] {
  const statuses = getStatusList(input.status)
  const filters = [eq(comments.targetType, input.targetType), eq(comments.targetId, input.targetId)]

  if (statuses && statuses.length > 0) {
    filters.push(inArray(comments.status, statuses))
  }

  return db
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(desc(comments.createdAt))
    .all()
    .map(toComment)
}

export function getComment(id: string, db: DataDb = getDatabase()): Comment | null {
  const row = db.select().from(comments).where(eq(comments.id, id)).get()
  return row ? toComment(row) : null
}

export function createComment(input: CreateCommentInput, db: DataDb = getDatabase()): Comment {
  const now = new Date().toISOString()
  const id = generateId()

  db.insert(comments)
    .values({
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      selectedQuote: input.selectedQuote,
      blockId: input.blockId ?? null,
      rangeStart: input.rangeStart ?? null,
      rangeEnd: input.rangeEnd ?? null,
      prefix: input.prefix ?? null,
      suffix: input.suffix ?? null,
      body: input.body ?? '',
      mentionRefs: input.mentionRefs ?? [],
      attachmentRefs: input.attachmentRefs ?? [],
      status: 'open',
      createdAt: now,
      modifiedAt: now
    })
    .run()

  const created = getComment(id, db)
  if (!created) throw new Error('Failed to create comment')
  return created
}

export function updateComment(input: UpdateCommentInput, db: DataDb = getDatabase()): Comment {
  const existing = getComment(input.id, db)
  if (!existing) throw new Error('Comment not found')

  const updates: Partial<typeof comments.$inferInsert> = {
    modifiedAt: new Date().toISOString()
  }
  if (input.body !== undefined) updates.body = input.body
  if (input.mentionRefs !== undefined) updates.mentionRefs = input.mentionRefs
  if (input.attachmentRefs !== undefined) updates.attachmentRefs = input.attachmentRefs

  db.update(comments).set(updates).where(eq(comments.id, input.id)).run()

  const updated = getComment(input.id, db)
  if (!updated) throw new Error('Failed to update comment')
  return updated
}

export function setCommentStatus(
  id: string,
  status: CommentStatus,
  db: DataDb = getDatabase()
): Comment {
  const existing = getComment(id, db)
  if (!existing) throw new Error('Comment not found')

  db.update(comments)
    .set({ status, modifiedAt: new Date().toISOString() })
    .where(eq(comments.id, id))
    .run()

  const updated = getComment(id, db)
  if (!updated) throw new Error('Failed to update comment status')
  return updated
}

export function deleteComment(id: string, db: DataDb = getDatabase()): Comment {
  const existing = getComment(id, db)
  if (!existing) throw new Error('Comment not found')
  db.delete(comments).where(eq(comments.id, id)).run()
  return existing
}

export function linkCommentAttachment(
  id: string,
  attachmentRef: string,
  db: DataDb = getDatabase()
): Comment {
  const existing = getComment(id, db)
  if (!existing) throw new Error('Comment not found')

  const refs = existing.attachmentRefs.includes(attachmentRef)
    ? existing.attachmentRefs
    : [...existing.attachmentRefs, attachmentRef]

  return updateComment({ id, attachmentRefs: refs }, db)
}

export function serializeComment(comment: Comment): string {
  return JSON.stringify(comment)
}
