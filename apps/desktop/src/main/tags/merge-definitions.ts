/**
 * Merges tag definitions that are one tag under `tagKey` (protocol chapter 13
 * §13.7.7). Sync side effects are passed in so the sync handler can call this
 * without importing the local-mutation runtime, which imports the handlers.
 */
import { sql } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagKey } from '@memry/shared/tag-fold'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'

const log = createLogger('TagIdentity')

type DefinitionRow = typeof tagDefinitions.$inferSelect

function schemaVersion(row: DefinitionRow): number {
  if (row.schema === null) return -1
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is untyped; persisted shape is read defensively by the following code
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
  return [...rows].toSorted(
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

export interface MergeEffects {
  deleted(row: DefinitionRow): void
  updated(name: string): void
}

/**
 * Merges every group of definitions that are one tag, or only the group of
 * `onlyKey`. Returns how many definitions were deleted.
 */
export function mergeDefinitions(dataDb: DataDb, effects: MergeEffects, onlyKey?: string): number {
  const groups = new Map<string, DefinitionRow[]>()
  for (const row of dataDb.select().from(tagDefinitions).all()) {
    const key = tagKey(row.name)
    if (onlyKey !== undefined && key !== onlyKey) continue
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  let merged = 0
  for (const rows of groups.values()) {
    if (rows.length < 2) continue
    const survivor = pickSurvivor(rows)
    const losers = rows
      .filter((row) => row !== survivor)
      .toSorted((a, b) => (a.name < b.name ? -1 : 1))
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
    for (const loser of losers) effects.deleted(loser)
    if (Object.keys(fill).length > 0) effects.updated(survivor.name)
    log.info('Merged tag definitions that are one tag', {
      survivor: survivor.name,
      merged: losers.map((loser) => loser.name)
    })
    merged += losers.length
  }
  return merged
}
