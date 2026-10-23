import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getMainI18n } from '../lib/main-i18n'
import { getStatus } from '../vault'
import { ReadwiseError, verifyToken } from './client'
import { deleteReadwiseToken, getReadwiseToken, setReadwiseToken } from './secrets'
import {
  getReadwiseScheduler,
  ReadwiseRunInProgressError,
  ReadwiseUnavailableError
} from './runtime-effects'
import { readReadwiseOptions } from './settings'
import { clearRunState, getCursor, getLastRun, setLastRun } from './sync-state'

function requireVaultPath(): string {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
  return vaultPath
}

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
    hasImported: getCursor(db) !== null
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
  // A fresh token ends "needs attention", so the schedule starts again.
  const db = getDatabase()
  const lastRun = getLastRun(db)
  if (lastRun?.needsAttention) setLastRun(db, { ...lastRun, needsAttention: false })
  return await getReadwiseStatus()
}

/** Deletes the token and the run state. Every note stays (D9). */
export async function disconnectReadwise(): Promise<void> {
  const vaultPath = requireVaultPath()
  await deleteReadwiseToken(vaultPath)
  clearRunState(getDatabase())
}

/** Runs now, or joins the scheduler's run, and resolves when it completes. */
export async function syncReadwiseNow(): Promise<void> {
  try {
    await getReadwiseScheduler().syncNow()
  } catch (err) {
    const t = getMainI18n().t
    if (err instanceof ReadwiseRunInProgressError) {
      throw new Error(t('errors:importer.readwiseRunInProgress'))
    }
    if (err instanceof ReadwiseUnavailableError) {
      throw new Error(
        err.reason === 'not-connected'
          ? t('errors:importer.readwiseNotConnected')
          : t('errors:importer.readwiseRunUnavailable')
      )
    }
    const message = describeReadwiseError(err)
    if (message === null) throw err
    throw new Error(message, { cause: err })
  }
}
