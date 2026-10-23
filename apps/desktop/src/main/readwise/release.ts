import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getCurrentVaultPath } from '../store'
import { deleteReadwiseToken, getReadwiseToken } from './secrets'
import { claimLostToAnotherDevice } from './pull-gate'
import { clearRunState } from './sync-state'

const log = createLogger('Readwise:Release')

/**
 * The old device's side of a takeover (D8): once another device holds the
 * claim, this one deletes its copy of the token and its run state, so it can
 * neither pull nor resume from a stale cursor if the user takes Readwise back
 * later. Every note stays (D9). Returns true when it released something.
 */
export async function releaseTokenIfClaimedElsewhere(): Promise<boolean> {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath || !claimLostToAnotherDevice()) return false
  const hadToken = (await getReadwiseToken(vaultPath)) !== null
  await deleteReadwiseToken(vaultPath)
  clearRunState(getDatabase())
  if (hadToken) log.info('Readwise now syncs on another device; this device dropped its token')
  return hadToken
}
