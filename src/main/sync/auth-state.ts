/**
 * Sync Auth State
 *
 * Centralized login/crypto readiness flag used by sync subsystems.
 *
 * @module sync/auth-state
 */

export const SYNC_SETUP_COMPLETE_KEY = 'sync.setup.complete.v1'
export const SYNC_SETUP_PENDING_KEY = 'sync.setup.pending.v1'

let syncUserId: string | null = null
let syncAuthReady = false
let syncEnabled = false

export function setSyncAuthState(state: {
  userId: string | null
  authReady: boolean
  syncEnabled?: boolean
}): void {
  syncUserId = state.userId
  syncAuthReady = state.authReady
  if (state.syncEnabled !== undefined) {
    syncEnabled = state.syncEnabled
  }
}

export function getSyncUserId(): string | null {
  return syncUserId
}

export function setSyncEnabled(enabled: boolean): void {
  syncEnabled = enabled
}

export function isSyncEnabled(): boolean {
  return syncEnabled
}

export function isSyncAuthReady(): boolean {
  return syncAuthReady && !!syncUserId && syncEnabled
}
