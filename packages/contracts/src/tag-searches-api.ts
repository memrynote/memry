/**
 * Saved tag searches — a named multi-tag (AND) filter.
 *
 * Stored as one JSON blob in the vault's `settings` table under the
 * `tagSearches` group (see `readGroupSettings`/`writeGroupSettings` in the
 * main process), so a saved search survives a restart and travels with the
 * vault instead of living in renderer-only state.
 *
 * BACKWARD COMPATIBILITY: the group key is simply absent for every vault
 * written before this feature. Readers fall back to
 * `TAG_SEARCHES_SETTINGS_DEFAULTS` (an empty list), so an existing install
 * sees "no saved searches" rather than an error.
 *
 * @module contracts/tag-searches-api
 */

import { z } from 'zod'

/**
 * One saved search. `tags[0]` is the primary tag — the one whose page opens —
 * and the rest are ANDed onto it, matching `ViewScope`'s `tag` + `andTags`.
 */
export const TagSearchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  createdAt: z.string()
})

export type TagSearch = z.infer<typeof TagSearchSchema>

export const TagSearchesSettingsSchema = z.object({
  searches: z.array(TagSearchSchema)
})

export type TagSearchesSettings = z.infer<typeof TagSearchesSettingsSchema>

export const TAG_SEARCHES_SETTINGS_DEFAULTS: TagSearchesSettings = {
  searches: []
}

/** Hard cap, so a runaway caller cannot grow the settings blob without bound. */
export const MAX_SAVED_TAG_SEARCHES = 100

/**
 * Total reader for the persisted blob: anything a newer/older/corrupted build
 * wrote that does not parse degrades to "no saved searches" instead of
 * throwing into the settings read path. Individual malformed entries are
 * dropped rather than failing the whole list.
 */
export function parseTagSearches(raw: unknown): TagSearch[] {
  if (raw === null || typeof raw !== 'object') return []
  const searches = (raw as { searches?: unknown }).searches
  if (!Array.isArray(searches)) return []
  const parsed: TagSearch[] = []
  for (const entry of searches) {
    const result = TagSearchSchema.safeParse(entry)
    if (result.success) parsed.push(result.data)
  }
  return parsed.slice(0, MAX_SAVED_TAG_SEARCHES)
}
