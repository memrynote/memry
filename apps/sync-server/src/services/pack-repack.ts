import {
  parsePack,
  type PackEntryPlan,
  type PackEntryPlanMeta,
  type PackKindName,
  type PackedEntry
} from './pack-format'
import type { Guard } from './pack-index-write'

/**
 * What rewriting a pack takes, shared by rollup (pack-rollup.ts) and the purge
 * rewrite (pack-purge-rewrite.ts): read a pack object, find which of its
 * entries are still current, and plan them into a new pack. It imports no
 * selection module, so the purge path does not depend back on the services
 * that call it.
 */

/** Read and verify one pack object of `kind`, or the reason it cannot be used. */
export const readPackObject = async (
  storage: R2Bucket,
  kind: PackKindName,
  key: string
): Promise<{ bytes: Uint8Array; entries: PackedEntry[] } | string> => {
  try {
    const object = await storage.get(key)
    if (!object) return 'object missing'
    const bytes = new Uint8Array(await object.arrayBuffer())
    const parsed = await parsePack(bytes)
    if (parsed.entries.some((entry) => entry.kind !== kind)) return 'entry of another kind'
    return { bytes, entries: parsed.entries }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Indexes of the entries whose source row is still current, given their live join. */
export const liveIndexes = async (db: D1Database, live: Guard): Promise<Set<number>> => {
  const rows = await db
    .prepare(`SELECT e.key AS i ${live.sql}`)
    .bind(...live.bind)
    .all<{ i: number }>()
  return new Set((rows.results ?? []).map((row) => row.i))
}

/** The plan that writes a packed entry into a new pack, its meta carried verbatim. */
export const planOf = (kind: PackKindName, entry: PackedEntry): PackEntryPlan => ({
  kind,
  id: entry.id,
  sourceKey: entry.sourceKey,
  sortKey: entry.sortKey,
  sizeBytes: entry.length,
  ...(entry.meta
    ? {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the meta a build wrote into this index block, carried over verbatim
        meta: entry.meta as PackEntryPlanMeta
      }
    : {})
})
