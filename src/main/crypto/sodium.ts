/**
 * Sodium Initialization Helper
 *
 * Singleton pattern for initializing libsodium-wrappers.
 * All crypto functions should call ensureSodiumReady() before using sodium.
 */

import sodium from 'libsodium-wrappers'

let initialized = false

/**
 * Ensure sodium is initialized and ready for use.
 * Uses singleton pattern - only initializes once.
 *
 * @returns The initialized sodium instance
 */
export async function ensureSodiumReady(): Promise<typeof sodium> {
  if (!initialized) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    await sodium.ready
    initialized = true
  }
  return sodium
}

/**
 * Get the sodium instance without initialization check.
 * Only use this after ensureSodiumReady() has been called.
 *
 * @returns The sodium instance
 */
export function getSodium(): typeof sodium {
  return sodium
}

/**
 * Check if sodium has been initialized.
 *
 * @returns Whether sodium is ready
 */
export function isSodiumInitialized(): boolean {
  return initialized
}
