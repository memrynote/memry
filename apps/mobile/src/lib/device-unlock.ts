import * as LocalAuthentication from 'expo-local-authentication'
import * as SecureStore from 'expo-secure-store'

import { createLogger } from './logger'

const log = createLogger('DeviceUnlock')

const ENABLED_KEY = 'memry.deviceUnlock.enabled'
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

/**
 * Biometric app lock (Paper `09 · Auth — Device unlock`).
 *
 * An app-level gate, not a change to how keys are stored: the vault key stays
 * in secure-store exactly as it was, so an existing install keeps working and
 * nothing has to be migrated. That is also why this is off until asked for —
 * `specs/001-mobile-app/spec.md` records biometric lock as opt-in, and turning
 * it on for everyone would hand existing users a lockout path they never chose.
 * The Settings toggle that flips it ships with the settings screens.
 */
export async function isDeviceUnlockEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ENABLED_KEY, OPTIONS)) === '1'
}

export async function setDeviceUnlockEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await SecureStore.setItemAsync(ENABLED_KEY, '1', OPTIONS)
    return
  }
  await SecureStore.deleteItemAsync(ENABLED_KEY, OPTIONS)
}

/**
 * Whether the device can actually perform the check. Hardware alone is not
 * enough: a phone with Face ID but nothing enrolled would prompt and fail
 * forever, so an unenrolled device is treated as having no gate at all.
 */
export async function isDeviceUnlockAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync()
  ])
  return hasHardware && isEnrolled
}

export type DeviceUnlockOutcome = 'passed' | 'refused' | 'unavailable'

export async function requestDeviceUnlock(): Promise<DeviceUnlockOutcome> {
  if (!(await isDeviceUnlockAvailable())) return 'unavailable'
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock your Memry vault',
      // The system fallback opens the device passcode, which is not the
      // credential this app understands. The recovery phrase route on the
      // screen is the real fallback, so the system one stays out of the way.
      disableDeviceFallback: true,
      cancelLabel: 'Cancel'
    })
    return result.success ? 'passed' : 'refused'
  } catch (err) {
    log.warn('Biometric prompt failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return 'refused'
  }
}
