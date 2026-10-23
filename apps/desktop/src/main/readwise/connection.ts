import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getMainI18n } from '../lib/main-i18n'
import { getStatus } from '../vault'
import { ReadwiseError, verifyToken } from './client'
import { deleteReadwiseToken, getReadwiseToken, setReadwiseToken } from './secrets'
import { readReadwiseOptions } from './settings'
import { clearRunState, getLastRun } from './sync-state'

function requireVaultPath(): string {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
  return vaultPath
}

/** Flips to true when #1413 and #1415 put the import and sync engine in the build. */
const RUN_AVAILABLE = false

export async function getReadwiseStatus(): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  const db = getDatabase()
  const connected = (await getReadwiseToken(vaultPath)) !== null
  const lastRun = connected ? getLastRun(db) : null
  return {
    connected,
    options: readReadwiseOptions(db),
    lastSyncAt: lastRun?.at ?? null,
    needsAttention: lastRun?.needsAttention ?? false,
    runAvailable: RUN_AVAILABLE
  }
}

/** The check runs before anything is stored, so a bad token leaves no trace (D2). */
export async function connectReadwise(token: string): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  const t = getMainI18n().t
  try {
    await verifyToken(token.trim())
  } catch (err) {
    if (!(err instanceof ReadwiseError)) throw err
    if (err.code === 'invalid-token') throw new Error(t('errors:importer.readwiseInvalidToken'))
    if (err.code === 'rate-limited') throw new Error(t('errors:importer.readwiseRateLimited'))
    throw new Error(t('errors:importer.readwiseUnreachable'))
  }
  await setReadwiseToken(vaultPath, token)
  return await getReadwiseStatus()
}

/** Deletes the token and the run state. Every note stays (D9). */
export async function disconnectReadwise(): Promise<void> {
  const vaultPath = requireVaultPath()
  await deleteReadwiseToken(vaultPath)
  clearRunState(getDatabase())
}

export async function syncReadwiseNow(): Promise<void> {
  if (!RUN_AVAILABLE) throw new Error(getMainI18n().t('errors:importer.readwiseRunUnavailable'))
}
