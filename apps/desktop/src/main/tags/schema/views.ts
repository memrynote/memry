import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { getOrCreateTag, writeTagViews } from '@main/database/queries/tag-definitions'
import type { DataDb } from '../../database/types'
import { syncTagDefinitionUpdate } from '../runtime-effects'
import { tagKey } from '@memry/shared/tag-fold'

export function saveTagViews(db: DataDb, tag: string, views: ViewConfig[] | null): void {
  const key = tagKey(tag)
  getOrCreateTag(db, key)
  writeTagViews(db, key, views)
  syncTagDefinitionUpdate(key)
}
