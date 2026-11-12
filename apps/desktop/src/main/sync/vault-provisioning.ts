import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as dataSchema from '@memry/db-schema/data-schema'
import { runMigrations } from '../database/migrate'
import { getDataDbPath, initVault } from '../vault/init'
import { createVaultInfo } from '../vault'
import { upsertVault } from '../store'
import { createLogger } from '../lib/logger'

import { adoptVaultLocally } from './vault-adoption'

const logger = createLogger('Sync:VaultProvisioning')

export function dormantVaultFolderName(vaultUuid: string): string {
  return `memry-vault-${vaultUuid.slice(0, 8)}`
}

/** Provision and register a vault without replacing the active vault's database or runtime. */
export function createDormantVault(folderPath: string, serverVaultUuid: string): void {
  // Loading the native adapter can fail on Linux before SQLite opens any file.
  new Database(':memory:').close()

  const firstCreated = fs.mkdirSync(folderPath, { recursive: true })
  try {
    initVault(folderPath)
    const dataDbPath = getDataDbPath(folderPath)
    runMigrations(dataDbPath)
    const sqlite = new Database(dataDbPath)
    try {
      adoptVaultLocally(drizzle(sqlite, { schema: dataSchema }), serverVaultUuid)
    } finally {
      sqlite.close()
    }
    upsertVault({ ...createVaultInfo(folderPath), vaultUuid: serverVaultUuid })
  } catch (error) {
    if (firstCreated) {
      const stop = path.dirname(path.resolve(firstCreated))
      let directory = path.join(path.resolve(folderPath), '.memry')
      while (directory !== stop) {
        try {
          fs.rmdirSync(directory)
        } catch (cleanupError) {
          if (
            cleanupError instanceof Error &&
            'code' in cleanupError &&
            cleanupError.code === 'ENOENT'
          ) {
            directory = path.dirname(directory)
            continue
          }
          logger.warn('Incomplete vault directory kept after provisioning failed', {
            folderPath,
            directory,
            error: cleanupError
          })
          break
        }
        directory = path.dirname(directory)
      }
    }
    throw error
  }
  logger.info('Provisioned dormant vault', { folderPath, serverVaultUuid })
}
