import type { VaultDb } from '@/db/index'
import { createLogger } from '@/lib/logger'
import { normalizeTagKey } from './note-ops'

const log = createLogger('TagDefinitions')

/**
 * The colour each tag was actually given, by normalized tag name.
 *
 * A `tag_definition` row's id IS the tag name, and its payload carries the
 * `color` the user picked on whichever device picked it. `tag_definition` is a
 * LEGACY sync type, so it reaches this device even though the client sends no
 * `X-Memry-Sync-Types` header — the rows are already here, nothing was reading
 * them.
 *
 * A tag with no row is not an error: the shared hash in `tagColor` gives it the
 * same colour desktop gives it.
 */
export async function readTagColors(db: VaultDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'tag_definition' AND deleted_at IS NULL`
  )
  const colors = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const color = (JSON.parse(row.payload) as { color?: unknown }).color
      if (typeof color === 'string' && color.length > 0) {
        colors.set(normalizeTagKey(row.id), color)
      }
    } catch {
      log.warn('Tag definition payload is not JSON; skipping', { tag: row.id })
    }
  }
  return colors
}
