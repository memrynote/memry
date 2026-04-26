import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { mockRouter } from './mocks'

/**
 * Typed wrapper around Tauri's invoke.
 *
 * At M1, every call is routed through the mock router to produce fake data
 * so the ported Electron renderer can render every page. Subsequent milestones
 * (M2+) implement real Rust commands; the wrapper flips to Tauri-backed
 * invoke per-command as implementations come online by adding entries to
 * `realCommands`.
 */
export async function invoke<TResponse = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<TResponse> {
  if (shouldUseMock(cmd)) {
    return mockRouter<TResponse>(cmd, args)
  }
  return tauriInvoke<TResponse>(cmd, args ?? {})
}

/**
 * Decides whether a command should be served by the mock router or routed to
 * the real Tauri backend. M2 Phase F lit up the settings KV slice; M4
 * Phase F adds the auth/crypto/keychain/device/linking surface. Every other
 * domain still serves data through the JS-side mocks until its Rust
 * implementation lands. Add a command here once its Rust handler ships.
 */
const realCommands = new Set<string>([
  // M2 — settings KV + lifecycle
  'settings_get',
  'settings_set',
  'settings_list',
  'notify_flush_done',

  // M4 — local auth state
  'auth_status',
  'auth_unlock',
  'auth_lock',
  'auth_register_device',
  'auth_request_otp',
  'auth_submit_otp',
  'auth_enable_biometric',

  // M4 — sync-server auth (OTP / OAuth / token / logout)
  'sync_auth_request_otp',
  'sync_auth_verify_otp',
  'sync_auth_resend_otp',
  'sync_auth_init_o_auth',
  'sync_auth_refresh_token',
  'sync_auth_logout',

  // M4 — sync-server account setup
  'sync_setup_setup_first_device',
  'sync_setup_setup_new_account',
  'sync_setup_confirm_recovery_phrase',
  'sync_setup_get_recovery_phrase',

  // M4 — local account profile
  'account_get_info',
  'account_sign_out',
  'account_get_recovery_key',

  // M4 — device management
  'sync_devices_get_devices',
  'sync_devices_remove_device',
  'sync_devices_rename_device',

  // M4 — device linking (QR + recovery)
  'sync_linking_generate_linking_qr',
  'sync_linking_link_via_qr',
  'sync_linking_complete_linking_qr',
  'sync_linking_link_via_recovery',
  'sync_linking_approve_linking',
  'sync_linking_get_linking_sas',

  // M4 — payload crypto + key rotation
  'crypto_encrypt_item',
  'crypto_decrypt_item',
  'crypto_verify_signature',
  'crypto_rotate_keys',
  'crypto_get_rotation_progress',

  // M4 — provider secret status (no raw key egress)
  'secrets_set_provider_key',
  'secrets_get_provider_key_status',
  'secrets_delete_provider_key'
])

function shouldUseMock(cmd: string): boolean {
  if (import.meta.env.VITE_MOCK_IPC === 'false') {
    return false
  }
  return !realCommands.has(cmd)
}
