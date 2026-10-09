import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { getOrCreateTag, writeTagViews } from '@main/database/queries/tag-definitions'
import type { DataDb } from '../../database/types'
import { syncTagDefinitionUpdate } from '../runtime-effects'
import { tagKey } from '../tag-schema'

/**
 * Saves a tag's views and syncs them. The row is created first: a tag no note
 * has indexed yet has no definition row, and an UPDATE alone would save nothing.
 * `null` empties the column, which a push leaves out; `[]` is pushed, so peers
 * clear theirs too.
 */
export function saveTagViews(db: DataDb, tag: string, views: ViewConfig[] | null): void {
  const key = tagKey(tag)
  getOrCreateTag(db, key)
  writeTagViews(db, key, views)
  syncTagDefinitionUpdate(key)
}
