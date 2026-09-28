import { eq } from 'drizzle-orm'
import { graphLayouts } from '@memry/db-schema/schema/graph-layouts'
import { GraphLayoutSchema, type GraphLayout } from '@memry/contracts/graph-api'
import type { IndexDb } from '../types'

/**
 * Saved layout for a view, or null when there is none or it cannot be read.
 * An unreadable blob falls back to a fresh arrangement rather than failing the graph.
 */
export function getGraphLayout(db: IndexDb, viewKey: string): GraphLayout | null {
  const row = db
    .select({ positions: graphLayouts.positions })
    .from(graphLayouts)
    .where(eq(graphLayouts.viewKey, viewKey))
    .get()
  if (!row) return null

  let raw: unknown
  try {
    raw = JSON.parse(row.positions)
  } catch {
    return null
  }
  const parsed = GraphLayoutSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function saveGraphLayout(db: IndexDb, viewKey: string, layout: GraphLayout): void {
  const positions = JSON.stringify(layout)
  const updatedAt = new Date().toISOString()
  db.insert(graphLayouts)
    .values({ viewKey, positions, updatedAt })
    .onConflictDoUpdate({ target: graphLayouts.viewKey, set: { positions, updatedAt } })
    .run()
}

export function clearGraphLayout(db: IndexDb, viewKey: string): void {
  db.delete(graphLayouts).where(eq(graphLayouts.viewKey, viewKey)).run()
}
