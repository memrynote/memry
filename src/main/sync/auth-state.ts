/**
 * Sync Auth State
 *
 * Centralized login/crypto readiness flag used by sync subsystems.
 *
 * @module sync/auth-state
 */

let syncUserId: string | null = null
let syncAuthReady = false

export function setSyncAuthState(state: { userId: string | null; authReady: boolean }): void {
  syncUserId = state.userId
  syncAuthReady = state.authReady
}

export function getSyncUserId(): string | null {
  return syncUserId
}

export function isSyncAuthReady(): boolean {
  return syncAuthReady && !!syncUserId
}
