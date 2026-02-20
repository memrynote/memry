import { eq, isNotNull, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as indexSchema from '@shared/db/schema/index-schema'
import { noteTags } from '@shared/db/schema/notes-cache'

type IndexDb = BetterSQLite3Database<typeof indexSchema>

export function getPinnedTagsForNote(indexDb: IndexDb, noteId: string): string[] {
  const rows = indexDb
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(and(eq(noteTags.noteId, noteId), isNotNull(noteTags.pinnedAt)))
    .all()
  return rows.map((r) => r.tag)
}

export function applyPinnedTags(indexDb: IndexDb, noteId: string, pinnedTags: string[]): void {
  const pinnedSet = new Set(pinnedTags)
  const now = new Date().toISOString()

  const existingRows = indexDb.select().from(noteTags).where(eq(noteTags.noteId, noteId)).all()

  for (const row of existingRows) {
    if (pinnedSet.has(row.tag) && !row.pinnedAt) {
      indexDb
        .update(noteTags)
        .set({ pinnedAt: now })
        .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, row.tag)))
        .run()
    } else if (!pinnedSet.has(row.tag) && row.pinnedAt) {
      indexDb
        .update(noteTags)
        .set({ pinnedAt: null })
        .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, row.tag)))
        .run()
    }
  }
}
