import { and, eq } from 'drizzle-orm'
import {
  propertyRefs,
  type NewPropertyRefRow,
  type PropertyRefRow
} from '@memry/db-schema/schema/notes-cache'
import { parseRelationValue, type RelationKind } from '@memry/contracts/relation-uri'
import type { IndexDb } from '../../types'

export function setPropertyRefs(
  db: IndexDb,
  noteId: string,
  properties: Record<string, unknown>
): void {
  db.delete(propertyRefs).where(eq(propertyRefs.sourceNoteId, noteId)).run()

  const rows: NewPropertyRefRow[] = []
  for (const [propertyName, value] of Object.entries(properties)) {
    for (const ref of parseRelationValue(value)) {
      rows.push({ sourceNoteId: noteId, propertyName, targetType: ref.kind, targetId: ref.id })
    }
  }

  if (rows.length > 0) {
    db.insert(propertyRefs).values(rows).run()
  }
}

export function getPropertyRefsForNote(db: IndexDb, noteId: string): PropertyRefRow[] {
  return db.select().from(propertyRefs).where(eq(propertyRefs.sourceNoteId, noteId)).all()
}

export function getIncomingPropertyRefs(
  db: IndexDb,
  targetType: RelationKind,
  targetId: string
): PropertyRefRow[] {
  return db
    .select()
    .from(propertyRefs)
    .where(and(eq(propertyRefs.targetType, targetType), eq(propertyRefs.targetId, targetId)))
    .all()
}
