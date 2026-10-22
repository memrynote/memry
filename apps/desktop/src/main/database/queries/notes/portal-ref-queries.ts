import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { noteCache, portalRefs, type PortalRefRow } from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../../types'

export type { PortalRefRow }

export function getPortalRefsForHost(db: IndexDb, hostNoteId: string): PortalRefRow[] {
  return db.select().from(portalRefs).where(eq(portalRefs.hostNoteId, hostNoteId)).all()
}

/** Replaces a host's rows. A host with no portal fences ends with no rows. */
export function setPortalRefs(db: IndexDb, hostNoteId: string, rows: PortalRefRow[]): void {
  db.delete(portalRefs).where(eq(portalRefs.hostNoteId, hostNoteId)).run()
  if (rows.length > 0) db.insert(portalRefs).values(rows).run()
}

export interface PortalUsageRow {
  hostNoteId: string
  title: string
  path: string
  count: number
}

/**
 * Notes that show `sourceNoteId` through a portal, one row per host. With
 * `anchor`, only portals to that block count. A host whose note row is gone
 * (rows are not cascaded) is left out, and so is the source itself: a portal
 * in the note it shows is not "another note" using it.
 */
export function getPortalUsage(
  db: IndexDb,
  sourceNoteId: string,
  anchor?: string
): PortalUsageRow[] {
  const where = and(
    eq(portalRefs.sourceNoteId, sourceNoteId),
    ne(portalRefs.hostNoteId, sourceNoteId),
    anchor ? eq(portalRefs.anchor, anchor) : undefined
  )
  return db
    .select({
      hostNoteId: portalRefs.hostNoteId,
      title: noteCache.title,
      path: noteCache.path,
      // A fence has one row per root, so count fences, not rows.
      count: sql<number>`count(distinct ${portalRefs.ordinal})`
    })
    .from(portalRefs)
    .innerJoin(noteCache, eq(noteCache.id, portalRefs.hostNoteId))
    .where(where)
    .groupBy(portalRefs.hostNoteId)
    .orderBy(noteCache.title)
    .all()
    .map((row) => ({ ...row, count: Number(row.count) }))
}

/** Host notes of any portal to the given sources, for the incoming-reference lists. */
export function getPortalHostIds(db: IndexDb, sourceNoteId: string): string[] {
  return db
    .selectDistinct({ hostNoteId: portalRefs.hostNoteId })
    .from(portalRefs)
    .innerJoin(noteCache, eq(noteCache.id, portalRefs.hostNoteId))
    .where(eq(portalRefs.sourceNoteId, sourceNoteId))
    .all()
    .map((row) => row.hostNoteId)
}

/** Every (host, source) pair with a portal, for the graph. */
export function listPortalEdges(
  db: IndexDb,
  hostNoteIds?: readonly string[],
  sourceNoteIds?: readonly string[]
): { hostNoteId: string; sourceNoteId: string }[] {
  const conditions = [sql`${portalRefs.sourceNoteId} IS NOT NULL`]
  if (hostNoteIds) conditions.push(inArray(portalRefs.hostNoteId, [...hostNoteIds]))
  if (sourceNoteIds) conditions.push(inArray(portalRefs.sourceNoteId, [...sourceNoteIds]))
  return db
    .selectDistinct({ hostNoteId: portalRefs.hostNoteId, sourceNoteId: portalRefs.sourceNoteId })
    .from(portalRefs)
    .where(and(...conditions))
    .all() as { hostNoteId: string; sourceNoteId: string }[]
}
