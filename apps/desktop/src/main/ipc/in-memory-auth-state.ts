import { clearAuthDeviceState } from './auth-device-handlers'
import { clearOAuthState } from './auth-oauth-state'
import { clearAttachmentState } from './sync-attachment-handlers'

// Cleanup helper for the session-teardown module
export function clearInMemoryAuthState(): void {
  clearAuthDeviceState()
  clearOAuthState()
  clearAttachmentState()
}
