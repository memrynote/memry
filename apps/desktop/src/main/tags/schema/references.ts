import { rewriteSchemaReference } from '@memry/contracts/tag-schema'
import { listTagDefinitionRows, writeTagSchemaColumn } from '@main/database/queries/tag-definitions'
import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { syncTagDefinitionUpdate } from '../runtime-effects'
import { tagKey } from '@memry/shared/tag-fold'

const log = createLogger('TagSchemaReferences')

/**
 * Works on schemas this build cannot parse too, so a newer shape keeps its
 * references right.
 */
export function rewriteSchemaReferences(db: DataDb, from: string, to: string | null): string[] {
  const rewritten: string[] = []
  for (const row of listTagDefinitionRows(db)) {
    const key = tagKey(row.name)
    if (row.schema === null) continue
    let stored: unknown
    try {
      stored = JSON.parse(row.schema)
    } catch {
      log.warn('Left a corrupt tag schema out of a reference rewrite', { tag: key })
      continue
    }
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) continue
    const next = rewriteSchemaReference(stored as Record<string, unknown>, from, to)
    if (!next) continue
    writeTagSchemaColumn(db, row.name, JSON.stringify(next))
    syncTagDefinitionUpdate(key)
    rewritten.push(key)
  }
  return rewritten
}
