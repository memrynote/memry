/**
 * Sync State Reset
 *
 * Utilities for resetting sync state when setting up a new device.
 * This ensures new devices start with cursor=0 to pull ALL existing data.
 *
 * @module sync/state-reset
 */

import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { syncState } from '@shared/db/schema/sync-schema'
import { deleteSetting } from '@shared/db/queries/settings'

const CURSOR_KEY = 'server_cursor'
const SETTINGS_FIELD_CLOCKS_KEY = 'settings_field_clocks'
const BOOTSTRAP_KEY = 'sync.bootstrap.v1'

/**
 * Resets sync state for a new device joining an existing account.
 *
 * This should be called before triggerPostSetupSync() when:
 * - REGISTER_EXISTING_DEVICE: User recovers account with recovery phrase
 * - COMPLETE_LINKING: User links device via QR code
 * - SETUP_FIRST_DEVICE: Clean state for first device (optional but recommended)
 *
 * After reset, the sync flow will:
 * 1. Pull: Fetch all remote data (cursor=0 means server_cursor > 0)
 * 2. Bootstrap: Queue any local data that hasn't been synced
 * 3. Push: Send local data to server
 * 4. Conflict resolution: CRDT/vector clocks handle any conflicts
 */
export async function resetSyncStateForNewDevice(): Promise<void> {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    console.info('[SyncStateReset] Skipped: no open vault')
    return
  }

  console.info('[SyncStateReset] Resetting sync state for new device')

  await db.delete(syncState).where(eq(syncState.key, CURSOR_KEY))

  await db.delete(syncState).where(eq(syncState.key, SETTINGS_FIELD_CLOCKS_KEY))

  deleteSetting(db, BOOTSTRAP_KEY)

  console.info('[SyncStateReset] Sync state reset complete')
}
