import { EVENT_CHANNELS, type SyncStatusChangedEvent } from '@memry/contracts/ipc-events'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { trackMainEvent } from '../telemetry/track'
import { isKeyMaterialActivityRecent } from './key-verification'

const log = createLogger('Sync:DeviceKeyMismatch')

/** Set once a mismatch has been escalated, so a burst of rejections signs out once. */
let handled = false

/**
 * The keychain signing key is not the key this device id is registered under.
 * Nothing local can repair that: the server holds the public key the device
 * registered with, so every signature this install produces is rejected
 * (SYNC_INVALID_SIGNATURE) and every attachment manifest it signs is
 * unverifiable on every device, forever — 497 push rejections in 20 minutes for
 * one account, then edits that never sync again (#2218). Signing out puts the
 * user through the ordinary sign-in flow, which re-registers the device under
 * the key it actually holds.
 */
export function handleDeviceKeyMismatch(): void {
  if (handled) return
  handled = true

  broadcastToAllWindows(EVENT_CHANNELS.STATUS_CHANGED, {
    status: 'error',
    pendingCount: 0,
    error: 'errors:sync.deviceKeyMismatch',
    errorCategory: 'device_key_mismatch'
  } satisfies SyncStatusChangedEvent)

  if (isKeyMaterialActivityRecent()) {
    // Sign-in / recovery / linking is mid-flight and re-registration is exactly
    // what it is already doing. Tearing down here would abort the repair.
    log.info('Device key mismatch during key-material transition — not tearing down')
    handled = false
    return
  }

  log.error('Device signing key does not match its registration — signing out to re-register')
  trackMainEvent('sync_error', {
    surface: 'sync',
    action: 'device_key_mismatch',
    result: 'failed',
    errorCode: 'device_key_mismatch',
    source: 'push'
  })
  // Dynamic on purpose: session-teardown imports the sync runtime, which
  // imports this module — a static import would close that cycle at load time.
  void import('./session-teardown')
    .then(({ teardownSession }) => teardownSession('integrity'))
    .catch((err) => log.error('Device key mismatch sign-out failed', err))
}
