import type { MockRouteMap } from './types'
import { mockTimestamp } from './types'

type SyncState = 'idle' | 'syncing' | 'error' | 'disabled'

interface MockSyncStatus {
  state: SyncState
  lastSyncedAt: number | null
  lastError: string | null
  queueDepth: number
}

let status: MockSyncStatus = {
  state: 'idle',
  lastSyncedAt: mockTimestamp(0),
  lastError: null,
  queueDepth: 0
}

let enabled = true

function currentState(): SyncState {
  if (!enabled) return 'disabled'
  return status.state
}

export const syncRoutes: MockRouteMap = {
  sync_status: async () => ({ ...status, state: currentState() }),
  sync_trigger: async () => {
    if (!enabled) {
      status = { ...status, state: 'disabled' }
      return { ok: false, reason: 'sync-disabled' }
    }
    status = {
      ...status,
      state: 'idle',
      lastSyncedAt: Date.now(),
      queueDepth: 0
    }
    return { ok: true }
  },
  sync_stats: async () => ({
    pushed: 42,
    pulled: 17,
    failed: 0,
    durationMs: 350
  }),
  sync_identity: async () => ({
    deviceId: 'mock-device-1',
    publicKey: 'mock-ed25519-pubkey'
  }),
  sync_enable: async (args) => {
    const { enabled: next } = args as { enabled: boolean }
    enabled = next
    status = { ...status, state: next ? 'idle' : 'disabled' }
    return { ok: true, enabled: next }
  },
  sync_pending_items: async () => [],
  sync_reset: async () => {
    status = {
      state: 'idle',
      lastSyncedAt: null,
      lastError: null,
      queueDepth: 0
    }
    return { ok: true }
  }
}
