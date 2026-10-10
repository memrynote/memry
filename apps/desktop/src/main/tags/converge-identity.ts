/**
 * Brings a vault written under the ASCII-only tag identity onto the Unicode one
 * (`foldTag`, protocol chapter 13 §13.7.7). Runs on every vault open and is a
 * no-op once converged.
 *
 * Builds before the Unicode fold kept `Ünal` and `ünal` apart wherever SQLite
 * `COLLATE NOCASE` decided, so a vault can hold:
 * - two tag definitions that are now one tag (`Ünal` minted from the tag hub
 *   with its typed spelling, `ünal` from the indexer; or `i̇ş`, the old full
 *   lowercase of `İş`, beside `iş`). One survives (`pickSurvivor`), takes
 *   whatever the others hold that it lacks, and the others are deleted and the
 *   delete synced. Every device picks the same survivor from the same rows, so
 *   devices converge on one sync id without ping-pong.
 * - two usage rows of one tag on one task, inbox item or note. The first one
 *   is kept (the note's earliest position), so a carrier lists each tag once.
 */
import { sql } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagKey } from '@memry/shared/tag-fold'
import type { DataDb, IndexDb } from '../database'
import { createLogger } from '../lib/logger'
import { syncTagDefinitionDelete, syncTagDefinitionUpdate } from './runtime-effects'

const log = createLogger('TagIdentity')

type DefinitionRow = typeof tagDefinitions.$inferSelect

function schemaVersion(row: DefinitionRow): number {
  if (row.schema === null) return -1
  try {
    const t = (JSON.parse(row.schema) as { t?: unknown })?.t
    return typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : 0
  } catch {
    log.warn('Reading a corrupt tag schema as version 0', { tag: row.name })
    return 0
  }
}

/**
 * The definition that keeps the tag: the newest schema version, then the
 * oldest `createdAt`, then the smallest name by UTF-16 code unit.
 */
export function pickSurvivor(rows: readonly DefinitionRow[]): DefinitionRow {
  return [...rows].sort(
    (a, b) =>
      schemaVersion(b) - schemaVersion(a) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )[0]
}

/** What the survivor lacks and a loser holds, first loser in survivor order wins. */
function fillsFrom(survivor: DefinitionRow, losers: readonly DefinitionRow[]) {
  const fill: Partial<DefinitionRow> = {}
  for (const loser of losers) {
    if (survivor.icon === null && fill.icon === undefined && loser.icon !== null)
      fill.icon = loser.icon
    if (survivor.categoryId === null && fill.categoryId === undefined && loser.categoryId !== null)
      fill.categoryId = loser.categoryId
    if (survivor.views === null && fill.views === undefined && loser.views !== null)
      fill.views = loser.views
    if (!survivor.colorAuthored && fill.color === undefined && loser.colorAuthored) {
      fill.color = loser.color
      fill.colorAuthored = true
    }
  }
  return fill
}

function mergeDefinitions(dataDb: DataDb): number {
  const groups = new Map<string, DefinitionRow[]>()
  for (const row of dataDb.select().from(tagDefinitions).all()) {
    const key = tagKey(row.name)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  let merged = 0
  for (const rows of groups.values()) {
    if (rows.length < 2) continue
    const survivor = pickSurvivor(rows)
    const losers = rows.filter((row) => row !== survivor).sort((a, b) => (a.name < b.name ? -1 : 1))
    const fill = fillsFrom(survivor, losers)
    dataDb.transaction((tx) => {
      if (Object.keys(fill).length > 0) {
        tx.update(tagDefinitions)
          .set(fill)
          .where(sql`${tagDefinitions.name} = ${survivor.name} COLLATE BINARY`)
          .run()
      }
      for (const loser of losers) {
        tx.delete(tagDefinitions)
          .where(sql`${tagDefinitions.name} = ${loser.name} COLLATE BINARY`)
          .run()
      }
    })
    for (const loser of losers) syncTagDefinitionDelete(loser)
    if (Object.keys(fill).length > 0) syncTagDefinitionUpdate(survivor.name)
    log.info('Merged tag definitions that are one tag', {
      survivor: survivor.name,
      merged: losers.map((loser) => loser.name)
    })
    merged += losers.length
  }
  return merged
}

function dropDuplicateUsages(dataDb: DataDb, indexDb: IndexDb): number {
  const tasks = dataDb.run(sql`
    DELETE FROM task_tags WHERE rowid IN (
      SELECT t.rowid FROM task_tags t JOIN task_tags o
        ON o.task_id = t.task_id AND o.rowid < t.rowid AND tag_fold(o.tag) = tag_fold(t.tag))`)
  const inbox = dataDb.run(sql`
    DELETE FROM inbox_item_tags WHERE rowid IN (
      SELECT t.rowid FROM inbox_item_tags t JOIN inbox_item_tags o
        ON o.item_id = t.item_id AND o.rowid < t.rowid AND tag_fold(o.tag) = tag_fold(t.tag))`)
  const notes = indexDb.run(sql`
    DELETE FROM note_tags WHERE rowid IN (
      SELECT t.rowid FROM note_tags t JOIN note_tags o
        ON o.note_id = t.note_id AND tag_fold(o.tag) = tag_fold(t.tag)
       AND (o.position < t.position OR (o.position = t.position AND o.rowid < t.rowid)))`)
  return tasks.changes + inbox.changes + notes.changes
}

export function convergeTagIdentity(
  dataDb: DataDb,
  indexDb: IndexDb
): { definitionsMerged: number; usagesDropped: number } {
  const definitionsMerged = mergeDefinitions(dataDb)
  const usagesDropped = dropDuplicateUsages(dataDb, indexDb)
  if (usagesDropped > 0) log.info('Dropped duplicate tag rows', { usagesDropped })
  return { definitionsMerged, usagesDropped }
}
