import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getMainI18n } from '../lib/main-i18n'
import { getStatus } from '../vault'
import { ReadwiseError, verifyToken } from './client'
import { deleteReadwiseToken, getReadwiseToken, setReadwiseToken } from './secrets'
import { readReadwiseOptions } from './settings'
import { clearRunState, getCursor, getLastRun } from './sync-state'

function requireVaultPath(): string {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
  return vaultPath
}

/** Flips to true when #1416's scheduler owns when a run starts outside the import dialog. */
const SYNC_NOW_AVAILABLE = false

/** The user-facing text for a Readwise failure, or null when `err` is not one. */
export function describeReadwiseError(err: unknown): string | null {
  if (!(err instanceof ReadwiseError)) return null
  const t = getMainI18n().t
  if (err.code === 'invalid-token') return t('errors:importer.readwiseInvalidToken')
  if (err.code === 'rate-limited') return t('errors:importer.readwiseRateLimited')
  return t('errors:importer.readwiseUnreachable')
}

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
    hasImported: getCursor(db) !== null,
    syncNowAvailable: SYNC_NOW_AVAILABLE
  }
}

/** The check runs before anything is stored, so a bad token leaves no trace (D2). */
export async function connectReadwise(token: string): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  try {
    await verifyToken(token.trim())
  } catch (err) {
    const message = describeReadwiseError(err)
    if (message === null) throw err
    throw new Error(message)
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
  if (!SYNC_NOW_AVAILABLE)
    throw new Error(getMainI18n().t('errors:importer.readwiseRunUnavailable'))
}
