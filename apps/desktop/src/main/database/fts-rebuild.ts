import { sql } from 'drizzle-orm'
import type { DataDb, IndexDb } from './client'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { rebuildProjections } from '../projections'
import { isSqliteCorruptError } from './sqlite-errors'

const logger = createLogger('FtsRebuild')

function broadcast(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

/**
 * fts5's own verification pass over a table's index.
 *
 * Stronger than the MATCH probe `checkIndexHealth` runs: a single query only
 * reads the segments that query happens to touch, whereas 'integrity-check'
 * walks the whole index. It is written as an INSERT but stores nothing, so it
 * needs a writable connection — which is why the open-time gate uses MATCH and
 * this one only runs after the databases are open.
 *
 * Narrowed to SQLITE_CORRUPT (and its extended forms). This used to swallow
 * every exception, which would have turned a lock or a closed connection into a
 * full index rebuild (#1585).
 */
function isTableCorrupt(db: DataDb | IndexDb, tableName: string): boolean {
  try {
    db.run(sql.raw(`INSERT INTO ${tableName}(${tableName}) VALUES('integrity-check')`))
    return false
  } catch (error) {
    if (!isSqliteCorruptError(error)) {
      logger.warn(`FTS integrity check for ${tableName} could not run`, error)
      return false
    }
    return true
  }
}

/**
 * Names every FTS table whose index is corrupt, and tells the renderer.
 *
 * Runs only once something else already suspects corruption (the vault-open
 * health verdict, or a reconcile pass that threw SQLITE_CORRUPT) — a full fts5
 * verification of three tables is too expensive to put on every launch.
 */
export function detectCorruption(indexDb: IndexDb, dataDb: DataDb): string[] {
  const corrupt: string[] = []

  if (isTableCorrupt(indexDb, 'fts_notes')) corrupt.push('fts_notes')
  if (isTableCorrupt(dataDb, 'fts_tasks')) corrupt.push('fts_tasks')
  if (isTableCorrupt(dataDb, 'fts_inbox')) corrupt.push('fts_inbox')

  if (corrupt.length > 0) {
    logger.warn('Corrupt FTS tables detected:', corrupt)
    broadcast(SearchChannels.events.INDEX_CORRUPT, { tables: corrupt })
  }

  return corrupt
}

export async function rebuildAllIndexes(
  indexDb: IndexDb,
  dataDb: DataDb
): Promise<{
  notes: number
  tasks: number
  inbox: number
  durationMs: number
}> {
  void indexDb
  void dataDb

  logger.info('Starting full FTS index rebuild via search projector')

  return rebuildProjections(['search']).then((results) => {
    return results.search as {
      notes: number
      tasks: number
      inbox: number
      durationMs: number
    }
  })
}
