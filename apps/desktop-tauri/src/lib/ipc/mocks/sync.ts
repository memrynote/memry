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
  },

  // Device management (sync_devices_*) — consumed by settings sync tab
  sync_devices_get_devices: async () => ({
    devices: [
      {
        id: 'device-this',
        name: 'This Mac',
        platform: 'macos',
        isCurrentDevice: true,
        linkedAt: mockTimestamp(30),
        lastActiveAt: new Date().toISOString(),
        lastSyncAt: Date.now(),
        createdAt: new Date(mockTimestamp(30)).toISOString()
      },
      {
        id: 'device-phone',
        name: 'iPhone',
        platform: 'ios',
        isCurrentDevice: false,
        linkedAt: mockTimestamp(14),
        lastActiveAt: new Date(mockTimestamp(1)).toISOString(),
        lastSyncAt: mockTimestamp(1),
        createdAt: new Date(mockTimestamp(14)).toISOString()
      }
    ],
    email: 'mock@memry.local'
  }),
  sync_devices_remove_device: async () => ({ success: true }),
  sync_devices_rename_device: async () => ({ success: true }),

  // Sync setup (sync_setup_*) — consumed by onboarding flow
  sync_setup_setup_first_device: async () => ({
    success: true,
    deviceId: 'device-this',
    email: 'mock@memry.local',
    recoveryPhrase: Array(12).fill('mock'),
    needsRecoverySetup: false
  }),
  sync_setup_setup_new_account: async () => ({
    success: true,
    recoveryPhrase: Array(12).fill('mock')
  }),
  sync_setup_confirm_recovery_phrase: async () => ({ success: true }),

  // Sync auth (sync_auth_*) — OTP login + OAuth + token refresh
  sync_auth_request_otp: async () => ({ success: true, expiresIn: 300 }),
  sync_auth_verify_otp: async () => ({
    success: true,
    deviceId: 'device-this',
    email: 'mock@memry.local'
  }),
  sync_auth_resend_otp: async () => ({ success: true, expiresIn: 300 }),
  sync_auth_init_o_auth: async () => ({ state: 'mock-oauth-state' }),
  sync_auth_refresh_token: async () => ({ success: true }),

  // Sync ops status — consumed by SyncContext on mount
  sync_ops_get_status: async () => ({
    status: 'idle' as const,
    lastSyncAt: undefined,
    pendingCount: 0,
    error: undefined,
    offlineSince: undefined
  })
}
