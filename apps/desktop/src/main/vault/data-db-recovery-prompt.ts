import { dialog } from 'electron'

import { closeDatabase, getRawDataDatabase, initDatabase } from '../database/client'
import {
  moveAsideCorruptDataDb,
  replayRows,
  SALVAGED_TABLES,
  salvageRows
} from '../database/data-db-recovery'
import { runMigrations } from '../database/migrate'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { trackMainError } from '../telemetry/diagnostics'

const logger = createLogger('DataDbRecovery')

/** The user is asked at most once per app session, whether at open or mid-session (#3247). */
let offeredThisSession = false

/** Ask before touching the file. Recovery is never silent (#2595). */
async function confirmRecovery(dbPath: string): Promise<boolean> {
  const t = getMainI18n().getFixedT(null, 'system')
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: t('dialog.dataDbRecovery.title'),
    message: t('dialog.dataDbRecovery.message'),
    detail: t('dialog.dataDbRecovery.detail', { path: `${dbPath}.corrupt-<timestamp>` }),
    buttons: [t('dialog.dataDbRecovery.buttonRecover'), t('dialog.dataDbRecovery.buttonLater')],
    defaultId: 0,
    cancelId: 1
  })
  return response === 0
}

/**
 * Offer to recover a corrupt data.db: move it aside as a backup, start a fresh
 * one, and replay the vault identity and pending sync queue rows that can be
 * salvaged (`SALVAGED_TABLES`). Vault-derived
 * tables refill on the normal open path; synced items come back from the next
 * sync pull. Returns true when the database was replaced.
 */
export async function offerDataDbRecovery(dbPath: string): Promise<boolean> {
  offeredThisSession = true
  if (!(await confirmRecovery(dbPath))) {
    logger.warn('User postponed data.db recovery; the corrupt file stays in use')
    return false
  }

  closeDatabase()
  const backupPath = moveAsideCorruptDataDb(dbPath)
  const salvaged = SALVAGED_TABLES.map((table) => [table, salvageRows(backupPath, table)] as const)
  runMigrations(dbPath)
  initDatabase(dbPath)
  const raw = getRawDataDatabase()
  const counts = salvaged.map(
    ([table, rows]) => `${table} ${replayRows(raw, table, rows)}/${rows.length}`
  )
  logger.info(`data.db recovered; backup at ${backupPath}, replayed ${counts.join(', ')}`)
  return true
}

/**
 * SQLITE_CORRUPT from a query mid-session is the same signal as a failed
 * open-time quick_check (#2595): offer the same confirmed recovery, once.
 * Called synchronously from the failing statement, so the dialog is deferred
 * and the statement finishes throwing before the connection can be replaced.
 */
export function offerRuntimeDataDbRecovery(dbPath: string, error: unknown): void {
  if (offeredThisSession) return
  offeredThisSession = true
  logger.error(`SQLITE_CORRUPT from ${dbPath} mid-session — offering recovery`, error)
  trackMainError('vault', 'data_db_corrupt_runtime', error)
  setImmediate(() => {
    offerDataDbRecovery(dbPath).catch((recoveryError: unknown) =>
      logger.error('Mid-session data.db recovery failed', recoveryError)
    )
  })
}
