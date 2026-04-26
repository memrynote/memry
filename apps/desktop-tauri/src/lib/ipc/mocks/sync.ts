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

const mockRecoveryPhrase = Array(12).fill('mock')

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

  // Device management (sync_devices_*) — consumed by settings sync tab.
  sync_devices_get_devices: async () => ({
    // `createdAt` is a unix-epoch seconds number to mirror the D1
    // `devices.created_at INTEGER` column the server returns.
    devices: [
      {
        id: 'device-this',
        name: 'This Mac',
        platform: 'macos',
        osVersion: '15.0',
        appVersion: '2.0.0-alpha.1',
        isCurrentDevice: true,
        linkedAt: mockTimestamp(30),
        lastActiveAt: new Date().toISOString(),
        lastSyncAt: Date.now(),
        createdAt: Math.floor(mockTimestamp(30) / 1000)
      },
      {
        id: 'device-phone',
        name: 'iPhone',
        platform: 'ios',
        osVersion: '18.0',
        appVersion: '2.0.0-alpha.1',
        isCurrentDevice: false,
        linkedAt: mockTimestamp(14),
        lastActiveAt: new Date(mockTimestamp(1)).toISOString(),
        lastSyncAt: mockTimestamp(1),
        createdAt: Math.floor(mockTimestamp(14) / 1000)
      }
    ],
    email: 'mock@memry.local'
  }),
  sync_devices_remove_device: async () => ({ success: true }),
  sync_devices_rename_device: async () => ({ success: true }),

  // Sync setup (sync_setup_*) — consumed by onboarding flow.
  sync_setup_setup_first_device: async () => ({
    success: false,
    error:
      'OAuth-based first-device setup is deferred to post-M4; use the OTP flow',
    deviceId: null,
    email: null,
    recoveryPhrase: null,
    needsRecoverySetup: null
  }),
  sync_setup_setup_new_account: async (_args?: unknown) => ({
    success: true,
    error: null,
    deviceId: 'device-this',
    email: 'mock@memry.local',
    recoveryPhrase: mockRecoveryPhrase,
    needsRecoverySetup: true
  }),
  sync_setup_confirm_recovery_phrase: async () => ({ success: true, error: null }),
  sync_setup_get_recovery_phrase: async () => ({ phrase: mockRecoveryPhrase.join(' ') }),

  // Sync auth (sync_auth_*) — OTP login + OAuth + token + logout.
  sync_auth_request_otp: async () => ({ success: true, expiresIn: 300 }),
  sync_auth_verify_otp: async () => ({ success: true, needsSetup: false }),
  sync_auth_resend_otp: async () => ({ success: true, expiresIn: 300 }),
  sync_auth_init_o_auth: async () => ({
    state: 'mock-oauth-state',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=mock-oauth-state'
  }),
  sync_auth_refresh_token: async () => ({ success: true, error: null }),
  sync_auth_logout: async () => ({ success: true, error: null }),

  // Linking (sync_linking_*) — QR + recovery flows.
  // Shapes mirror the rust LinkingQrView / LinkingScanView / LinkingSasView /
  // LinkingMutationResult / LinkingCompleteView contracts (see
  // src-tauri/src/commands/linking.rs).
  sync_linking_generate_linking_qr: async () => ({
    sessionId: 'mock-linking-session',
    qrPayload: JSON.stringify({
      sessionId: 'mock-linking-session',
      linkingSecret: 'mock-linking-secret',
      ephemeralPublicKey: 'mock-ephemeral-pubkey'
    }),
    // Server returns unix-epoch seconds.
    expiresAt: Math.floor(Date.now() / 1000) + 300
  }),
  sync_linking_link_via_qr: async () => ({
    sessionId: 'mock-linking-session',
    sasCode: '123456'
  }),
  sync_linking_complete_linking_qr: async () => ({
    success: true,
    error: null,
    deviceId: 'device-this'
  }),
  sync_linking_link_via_recovery: async () => ({
    success: true,
    error: null,
    deviceId: 'device-this'
  }),
  sync_linking_approve_linking: async () => ({ success: true, error: null }),
  sync_linking_get_linking_sas: async () => ({ sasCode: '123456' }),

  // Account (account_*) — local profile + recovery key reveal.
  account_get_info: async () => ({
    email: 'mock@memry.local',
    deviceId: 'device-this',
    rememberDevice: true
  }),
  account_sign_out: async () => ({ success: true, error: null }),
  account_get_recovery_key: async () => mockRecoveryPhrase.join(' '),

  // Crypto (crypto_*) — payload + key rotation.
  crypto_rotate_keys: async () => ({ success: true, rotationId: 'mock-rotation' }),
  crypto_get_rotation_progress: async () => ({
    inProgress: false,
    completedItems: 0,
    totalItems: 0
  }),

  // Secrets (secrets_*) — provider key status only.
  secrets_set_provider_key: async (args) => {
    const { provider } = (args as { provider?: string }) ?? {}
    return {
      provider: provider ?? 'openai',
      configured: true,
      label: 'Mock key',
      last4: 'mock',
      updatedAt: new Date().toISOString()
    }
  },
  secrets_get_provider_key_status: async (args) => {
    const { provider } = (args as { provider?: string }) ?? {}
    return {
      provider: provider ?? 'openai',
      configured: false,
      label: null,
      last4: null,
      updatedAt: null
    }
  },
  secrets_delete_provider_key: async () => null,

  // Sync ops status — consumed by SyncContext on mount.
  sync_ops_get_status: async () => ({
    status: 'idle' as const,
    lastSyncAt: undefined,
    pendingCount: 0,
    error: undefined,
    offlineSince: undefined
  })
}
