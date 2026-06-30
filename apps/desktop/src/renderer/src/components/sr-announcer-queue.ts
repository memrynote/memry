// Global announcement queue shared between the SRAnnouncer component and callers.

let announceQueue: string[] = []
let announceCallback: ((message: string) => void) | null = null

/**
 * Queue a message to be announced by the screen reader
 * Can be called from anywhere in the app
 */
export const announceToScreenReader = (message: string): void => {
  if (announceCallback) {
    announceCallback(message)
  } else {
    announceQueue.push(message)
  }
}

/**
 * Register the live-region callback and flush any queued announcements.
 * Returns a cleanup that unregisters the callback.
 */
export const registerAnnounceCallback = (callback: (message: string) => void): (() => void) => {
  announceCallback = callback

  // Process any queued announcements
  announceQueue.forEach(callback)
  announceQueue = []

  return () => {
    announceCallback = null
  }
}
