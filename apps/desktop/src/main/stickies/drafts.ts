/**
 * Sticky drafts: unsent sticky text, kept until it is sent or deleted, and
 * synced across devices as `sticky_draft` records.
 *
 * This module owns the `sticky_drafts` rows on this device. Every local write
 * goes through it, so each one reaches sync and every window.
 *
 * @module main/stickies/drafts
 */

import { desc, eq } from 'drizzle-orm'
import { stickyDrafts, type StickyDraftRow } from '@memry/db-schema/schema/sticky-drafts'
import { StickyChannels } from '@memry/contracts/ipc-channels'
import {
  parseStickyKind,
  type StickyDraft,
  type StickySaveDraftInput
} from '@memry/contracts/sticky-api'
import { utcNow } from '@memry/shared/utc'
import { getDatabase } from '../database'
import { generateId } from '../lib/id'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { notifyStickyDraftsChanged } from './drafts-changed'

function toDraft(row: StickyDraftRow): StickyDraft {
  return {
    id: row.id,
    content: row.content,
    kind: parseStickyKind(row.kind),
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function announce(): void {
  broadcastToAllWindows(StickyChannels.events.DRAFTS_CHANGED, {})
  notifyStickyDraftsChanged()
}

/** Every draft, the most recently edited first. Empty when no vault is open. */
export function listStickyDrafts(): StickyDraft[] {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    return []
  }
  return db.select().from(stickyDrafts).orderBy(desc(stickyDrafts.modifiedAt)).all().map(toDraft)
}

export function getStickyDraft(id: string): StickyDraft | null {
  const row = getDatabase().select().from(stickyDrafts).where(eq(stickyDrafts.id, id)).get()
  return row ? toDraft(row) : null
}

/**
 * Create a draft, or update the one `input.id` names. An id whose row is gone
 * (another device sent it meanwhile) starts a new draft rather than dropping
 * the text.
 */
export function saveStickyDraft(input: StickySaveDraftInput): StickyDraft {
  const db = getDatabase()
  const now = utcNow()
  const existing = input.id
    ? db.select().from(stickyDrafts).where(eq(stickyDrafts.id, input.id)).get()
    : undefined

  if (existing) {
    if (existing.content === input.content && existing.kind === input.kind) {
      return toDraft(existing)
    }
    db.update(stickyDrafts)
      .set({ content: input.content, kind: input.kind, modifiedAt: now })
      .where(eq(stickyDrafts.id, existing.id))
      .run()
    enqueueLocalSyncUpdate('sticky_draft', existing.id)
    announce()
    return toDraft({ ...existing, content: input.content, kind: input.kind, modifiedAt: now })
  }

  const row: StickyDraftRow = {
    id: generateId(),
    content: input.content,
    kind: input.kind,
    createdAt: now,
    modifiedAt: now,
    clock: null,
    syncedAt: null
  }
  db.insert(stickyDrafts).values(row).run()
  enqueueLocalSyncCreate('sticky_draft', row.id)
  announce()
  return toDraft(row)
}

/** Delete a draft. Returns false when there was none. */
export function deleteStickyDraft(id: string): boolean {
  const db = getDatabase()
  const row = db.select().from(stickyDrafts).where(eq(stickyDrafts.id, id)).get()
  if (!row) return false

  db.delete(stickyDrafts).where(eq(stickyDrafts.id, id)).run()
  enqueueLocalSyncDelete('sticky_draft', id, JSON.stringify(row))
  announce()
  return true
}
