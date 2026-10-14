import { dialog } from 'electron'

import { closeDatabase, getRawDataDatabase, initDatabase } from '../database/client'
import {
  moveAsideCorruptDataDb,
  replaySyncQueue,
  salvageSyncQueue
} from '../database/data-db-recovery'
import { runMigrations } from '../database/migrate'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('DataDbRecovery')

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
 * one, and replay whatever pending sync queue rows can be salvaged. Vault-derived
 * tables refill on the normal open path; synced items come back from the next
 * sync pull. Returns true when the database was replaced.
 */
export async function offerDataDbRecovery(dbPath: string): Promise<boolean> {
  if (!(await confirmRecovery(dbPath))) {
    logger.warn('User postponed data.db recovery; the corrupt file stays in use')
    return false
  }

  closeDatabase()
  const backupPath = moveAsideCorruptDataDb(dbPath)
  const salvaged = salvageSyncQueue(backupPath)
  runMigrations(dbPath)
  initDatabase(dbPath)
  const replayed = replaySyncQueue(getRawDataDatabase(), salvaged)
  logger.info(
    `data.db recovered; backup at ${backupPath}, replayed ${replayed}/${salvaged.length} pending sync rows`
  )
  return true
}
