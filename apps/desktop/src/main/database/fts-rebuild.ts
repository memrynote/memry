import { BrowserWindow } from 'electron'
import { sql } from 'drizzle-orm'
import type { DataDb, IndexDb } from './client'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { createLogger } from '../lib/logger'
import { rebuildProjections } from '../projections'

const logger = createLogger('FtsRebuild')

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function isTableCorrupt(db: DataDb | IndexDb, tableName: string): boolean {
  try {
    db.all(sql.raw(`SELECT * FROM ${tableName} WHERE ${tableName} MATCH 'test' LIMIT 1`))
    return false
  } catch {
    return true
  }
}

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
